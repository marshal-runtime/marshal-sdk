"""Marshal's bridge to the Google Antigravity SDK (google-antigravity, Python).

One process serves every Antigravity session of one Marshal runtime client.
It speaks JSON lines: commands arrive on stdin, events leave on stdout, and
logs go to stderr. Each session is one `Agent` whose tool calls are decided by
Marshal (the pre-tool hook asks the host) and whose host tools run in Marshal.
"""

import asyncio
import json
import logging
import os
import sys
import traceback
import uuid

from google.antigravity import Agent, LocalAgentConfig, types
from google.antigravity import models as agy_models
from google.antigravity.hooks import hooks as agy_hooks
from google.antigravity.hooks import policy as agy_policy
from google.antigravity.tools import tool_runner as agy_tool_runner

PROTOCOL_VERSION = 1

# A cancel that the harness doesn't honour within this many seconds (a dead connection, a hook still waiting on
# the host) is finished by cancelling the turn's task; the Agent is then restarted on the same conversation.
CANCEL_GRACE_SECONDS = 5
CLOSE_SECONDS = 10
CANCELLED = "The turn was cancelled"

_out_lock = asyncio.Lock()
# request id -> (session id, request kind, future the host's reply resolves)
_pending: dict[str, tuple[str, str, asyncio.Future]] = {}
_sessions: dict[str, "BridgeSession"] = {}


def _jsonable(value):
  try:
    json.dumps(value)
    return value
  except (TypeError, ValueError):
    if hasattr(value, "model_dump"):
      try:
        return value.model_dump(mode="json")
      except Exception:  # pylint: disable=broad-except
        pass
    return str(value)


async def emit(event: dict) -> None:
  line = json.dumps(event, default=_jsonable)
  async with _out_lock:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


async def ask_host(session: str, kind: str, payload: dict):
  request_id = uuid.uuid4().hex
  future = asyncio.get_running_loop().create_future()
  _pending[request_id] = (session, kind, future)
  try:
    await emit({"ev": "request", "id": request_id, "session": session, "kind": kind, **payload})
    return await future
  finally:
    _pending.pop(request_id, None)


def _release_pending(session: str) -> None:
  """Answers the session's open host requests so hooks blocked on them return and the turn can stop."""
  for _, (owner, kind, future) in list(_pending.items()):
    if owner != session or future.done():
      continue
    future.set_result({"allow": False, "message": CANCELLED} if kind == "pre_tool" else {"error": CANCELLED})


def _auth_problem(config: dict) -> str | None:
  """Says why Vertex credentials can't be used (an expired gcloud login, say), or None when they work."""
  endpoint = config.get("endpoint") or {}
  if endpoint.get("kind") != "vertex" or endpoint.get("apiKey"):
    return None
  try:
    import google.auth  # pylint: disable=import-outside-toplevel
    import google.auth.exceptions  # pylint: disable=import-outside-toplevel
    import google.auth.transport.requests  # pylint: disable=import-outside-toplevel
  except ImportError:
    return None
  try:
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    credentials.refresh(google.auth.transport.requests.Request())
    return None
  except (google.auth.exceptions.RefreshError, google.auth.exceptions.DefaultCredentialsError) as error:
    return (
        f"Vertex AI credentials are not valid ({error}). Sign in again with "
        "`gcloud auth login --update-adc` (or `gcloud auth application-default login`), then send the message again."
    )
  except Exception:  # pylint: disable=broad-except
    return None


def _usage(usage) -> dict | None:
  if usage is None:
    return None
  return {
      "inputTokens": usage.prompt_token_count,
      "cachedInputTokens": usage.cached_content_token_count,
      "outputTokens": usage.candidates_token_count,
      "reasoningTokens": usage.thoughts_token_count,
      "totalTokens": usage.total_token_count,
  }


def _tool_name(name) -> str:
  return name.value if hasattr(name, "value") else str(name)


class HostDecidesToolCall(agy_hooks.PreToolCallDecideHook):
  """Every tool call (built-in, MCP or host) is allowed or denied by Marshal."""

  def __init__(self, session: "BridgeSession"):
    self._session = session

  async def run(self, context, data: types.ToolCall) -> types.HookResult:
    call_id = data.id or uuid.uuid4().hex
    name = _tool_name(data.name)
    self._session.remember_call(name, data.args, call_id)
    reply = await ask_host(
        self._session.id,
        "pre_tool",
        {
            "callId": call_id,
            "toolName": name,
            "args": data.args,
            "serverName": data.server_name,
            "canonicalPath": data.canonical_path,
            "hostTool": name in self._session.host_tool_names,
        },
    )
    if reply.get("allow"):
      args = reply.get("args")
      if isinstance(args, dict):
        return types.HookResult(allow=True, modified_args=args)
      return types.HookResult(allow=True)
    return types.HookResult(allow=False, message=reply.get("message") or "Denied by Marshal")


class ReportToolResult(agy_hooks.PostToolCallHook):

  def __init__(self, session: "BridgeSession"):
    self._session = session

  async def run(self, context, data: types.ToolResult) -> None:
    await emit({
        "ev": "tool_result",
        "session": self._session.id,
        "callId": data.id,
        "toolName": _tool_name(data.name),
        "result": _jsonable(data.result),
        "error": data.error,
    })


class ReportCompaction(agy_hooks.OnCompactionHook):

  def __init__(self, session: "BridgeSession"):
    self._session = session

  async def run(self, context, data) -> None:
    await emit({"ev": "compaction", "session": self._session.id, "summary": getattr(data, "content", "")})


class BridgeSession:

  def __init__(self, session_id: str, config: dict):
    self.id = session_id
    self.config = config
    self.agent: Agent | None = None
    self.host_tool_names: set[str] = set()
    self.response = None
    self.turn_task: asyncio.Task | None = None
    # Set when the harness may be stuck mid-turn or its connection is gone: the next turn restarts the Agent on
    # the same conversation (RESUME) instead of sending into it.
    self.needs_reopen = False
    self._call_ids: dict[str, list[str]] = {}

  def __deepcopy__(self, memo):
    # The SDK deep-copies the Agent config, hooks included: the hooks must keep this live session (its call ids
    # and turn task), and a running turn task can't be copied at all.
    return self

  def remember_call(self, name: str, args, call_id: str) -> None:
    self._call_ids.setdefault(self._call_key(name, args), []).append(call_id)

  def take_call_id(self, name: str, args) -> str:
    queue = self._call_ids.get(self._call_key(name, args))
    return queue.pop(0) if queue else uuid.uuid4().hex

  @staticmethod
  def _call_key(name: str, args) -> str:
    return name + "\x00" + json.dumps(args, sort_keys=True, default=str)

  def _host_tool(self, spec: dict):
    name = spec["name"]

    async def call_host(**kwargs):
      call_id = self.take_call_id(name, kwargs)
      reply = await ask_host(self.id, "host_tool", {"callId": call_id, "toolName": name, "args": kwargs})
      if reply.get("error"):
        raise RuntimeError(reply["error"])
      return reply.get("text", "")

    call_host.__name__ = name
    call_host.__doc__ = spec.get("description") or name
    schema = spec.get("parameters") or {"type": "object", "properties": {}}
    return agy_tool_runner.ToolWithSchema(call_host, schema)

  def _endpoint(self):
    endpoint = self.config.get("endpoint") or {}
    if endpoint.get("kind") == "vertex":
      if endpoint.get("apiKey"):
        return agy_models.VertexEndpoint(api_key=endpoint["apiKey"])
      return agy_models.VertexEndpoint(project=endpoint.get("project"), location=endpoint.get("location"))
    return agy_models.GeminiAPIEndpoint(api_key=endpoint.get("apiKey"))

  def _models(self):
    endpoint = self._endpoint()
    model = self.config.get("model")
    thinking = self.config.get("thinkingLevel")
    if thinking:
      endpoint.options = agy_models.GeminiModelOptions(thinking_level=agy_models.ThinkingLevel(thinking))
    text = agy_models.ModelTarget(name=model or agy_models.DEFAULT_MODEL, types=[agy_models.ModelType.TEXT], endpoint=endpoint)
    image_endpoint = self._endpoint()
    image = agy_models.ModelTarget(
        name=agy_models.DEFAULT_IMAGE_GENERATION_MODEL, types=[agy_models.ModelType.IMAGE], endpoint=image_endpoint
    )
    return [text, image]

  def _system_instructions(self):
    system = self.config.get("system")
    if not system or not system.get("text"):
      return None
    if system.get("mode") == "replace":
      return types.CustomSystemInstructions(text=system["text"])
    return types.TemplatedSystemInstructions(
        sections=[types.SystemInstructionSection(content=system["text"], title="marshal_instructions")]
    )

  def _mcp_servers(self):
    servers = []
    for server in self.config.get("mcpServers") or []:
      common = {"name": server["name"]}
      if server.get("tools"):
        common["enabled_tools"] = server["tools"]
      if server.get("url"):
        servers.append(types.McpStreamableHttpServer(url=server["url"], headers=server.get("headers"), **common))
      else:
        servers.append(
            types.McpStdioServer(
                command=server["command"], args=server.get("args") or [], env=server.get("env"), **common
            )
        )
    return servers

  @staticmethod
  def _builtin_tools(names) -> list:
    known = []
    for name in names or []:
      try:
        known.append(types.BuiltinTools(name))
      except ValueError:
        pass  # Another runtime's tool name (Marshal sends one list to every runtime).
    return known

  def _capabilities(self):
    enabled = self.config.get("enabledBuiltinTools")
    if enabled is not None:
      return types.CapabilitiesConfig(enabled_tools=self._builtin_tools(enabled))
    disabled = self._builtin_tools(self.config.get("disabledBuiltinTools"))
    if disabled:
      return types.CapabilitiesConfig(disabled_tools=disabled)
    return None

  async def open(self) -> str:
    host_tools = [self._host_tool(spec) for spec in self.config.get("hostTools") or []]
    self.host_tool_names = {spec["name"] for spec in self.config.get("hostTools") or []}
    kwargs = {
        "models": self._models(),
        "tools": host_tools or None,
        "policies": [agy_policy.allow_all()],
        "hooks": [HostDecidesToolCall(self), ReportToolResult(self), ReportCompaction(self)],
        "mcp_servers": self._mcp_servers() or None,
        "workspaces": self.config.get("workspaces") or [os.getcwd()],
        "conversation_id": self.config["conversationId"],
        "session_continuation_mode": (
            types.SessionContinuationMode.RESUME if self.config.get("resume") else types.SessionContinuationMode.CREATE_ONLY
        ),
        "save_dir": self.config.get("saveDir"),
        "app_data_dir": self.config.get("appDataDir"),
        "env": self.config.get("env"),
        "system_instructions": self._system_instructions(),
        "capabilities": self._capabilities(),
        "response_schema": self.config.get("responseSchema"),
        "skills_paths": self.config.get("skillsPaths") or None,
    }
    agent = Agent(LocalAgentConfig(**{k: v for k, v in kwargs.items() if v is not None}))
    await agent.__aenter__()
    self.agent = agent
    self.needs_reopen = False
    # Every later open continues the same conversation.
    self.config["resume"] = True
    return agent.conversation_id or self.config["conversationId"]

  async def _stop_agent(self) -> None:
    agent, self.agent = self.agent, None
    if agent is None:
      return
    try:
      await asyncio.wait_for(agent.__aexit__(None, None, None), timeout=CLOSE_SECONDS)
    except BaseException:  # pylint: disable=broad-except
      logging.warning("stopping the agent failed: %s", traceback.format_exc())

  async def _turn_error(self, turn: str, error: BaseException) -> None:
    message = str(error) or type(error).__name__
    auth = await asyncio.to_thread(_auth_problem, self.config)
    event = {"ev": "turn_error", "session": self.id, "turn": turn, "error": auth or message}
    if auth:
      event["code"] = "auth"
    await emit(event)

  async def run_turn(self, turn: str, prompt: str, media: list[dict]) -> None:
    if self.needs_reopen or self.agent is None:
      await self._stop_agent()
      try:
        await self.open()
      except asyncio.CancelledError:
        self.needs_reopen = True
        await emit({"ev": "turn_end", "session": self.id, "turn": turn, "cancelled": True})
        return
      except Exception as error:  # pylint: disable=broad-except
        logging.error("reopen failed: %s", traceback.format_exc())
        self.needs_reopen = True
        await self._turn_error(turn, error)
        return
    assert self.agent is not None
    content = prompt
    if media:
      parts: list = [prompt]
      for item in media:
        parts.append(types.from_file(item["path"], description=item.get("description")))
      content = parts
    try:
      response = await self.agent.chat(content)
      self.response = response
      async for chunk in response.chunks:
        if isinstance(chunk, types.Thought):
          await emit({"ev": "chunk", "session": self.id, "turn": turn, "kind": "thought", "text": chunk.text})
        elif isinstance(chunk, types.Text):
          await emit({"ev": "chunk", "session": self.id, "turn": turn, "kind": "text", "text": chunk.text})
        elif isinstance(chunk, types.ToolCall):
          await emit({
              "ev": "chunk",
              "session": self.id,
              "turn": turn,
              "kind": "tool_call",
              "callId": chunk.id,
              "toolName": _tool_name(chunk.name),
              "args": chunk.args,
              "serverName": chunk.server_name,
          })
      structured = None
      if self.config.get("responseSchema") is not None:
        try:
          structured = await response.structured_output()
        except Exception:  # pylint: disable=broad-except
          structured = None
      await emit({
          "ev": "turn_end",
          "session": self.id,
          "turn": turn,
          "usage": _usage(response.usage_metadata),
          "stopReason": _tool_name(response.stop_reason),
          "structured": _jsonable(structured),
      })
    except (asyncio.CancelledError, types.AntigravityCancelledError):
      await emit({"ev": "turn_end", "session": self.id, "turn": turn, "cancelled": True})
    except Exception as error:  # pylint: disable=broad-except
      logging.error("turn failed: %s", traceback.format_exc())
      # The harness may be mid-turn or disconnected (a closed websocket ends every later turn too).
      self.needs_reopen = True
      await self._turn_error(turn, error)
    finally:
      self.response = None

  async def cancel(self) -> None:
    _release_pending(self.id)
    task = self.turn_task
    if task is None or task.done():
      return
    response = self.response
    if response is not None:
      try:
        await asyncio.wait_for(response.cancel(), timeout=CANCEL_GRACE_SECONDS)
      except BaseException:  # pylint: disable=broad-except
        logging.warning("cancel failed: %s", traceback.format_exc())
      await asyncio.wait({task}, timeout=CANCEL_GRACE_SECONDS)
    if not task.done():
      # The harness didn't stop the turn: end it here (run_turn reports it cancelled) and restart the Agent
      # before the next turn, since the SDK would otherwise wait for the stuck turn to go idle.
      self.needs_reopen = True
      task.cancel()
      await asyncio.wait({task}, timeout=CANCEL_GRACE_SECONDS)

  async def close(self) -> None:
    await self.cancel()
    await self._stop_agent()


async def handle(command: dict) -> None:
  op = command.get("op")
  if op == "reply":
    future = _pending.get(command.get("id", ""))
    if future is not None and not future.done():
      future.set_result(command.get("result") or {})
    return
  session_id = command.get("session", "")
  if op == "open":
    session = BridgeSession(session_id, command.get("config") or {})
    try:
      conversation_id = await session.open()
      _sessions[session_id] = session
      await emit({"ev": "opened", "session": session_id, "conversationId": conversation_id})
    except Exception as error:  # pylint: disable=broad-except
      logging.error("open failed: %s", traceback.format_exc())
      await session.close()
      auth = await asyncio.to_thread(_auth_problem, session.config)
      failed = {"ev": "open_failed", "session": session_id, "error": auth or str(error) or type(error).__name__}
      if auth:
        failed["code"] = "auth"
      await emit(failed)
    return
  session = _sessions.get(session_id)
  if session is None:
    await emit({"ev": "error", "session": session_id, "error": f"Unknown session {session_id}"})
    return
  if op == "send":
    session.turn_task = asyncio.create_task(
        session.run_turn(command.get("turn", ""), command.get("prompt", ""), command.get("media") or [])
    )
  elif op == "cancel":
    await session.cancel()
  elif op == "close":
    _sessions.pop(session_id, None)
    await session.close()
    await emit({"ev": "closed", "session": session_id})


async def main() -> None:
  logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="[antigravity-bridge] %(message)s")
  loop = asyncio.get_running_loop()
  reader = asyncio.StreamReader(limit=64 * 1024 * 1024)
  await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
  await emit({"ev": "ready", "protocol": PROTOCOL_VERSION})
  tasks: set[asyncio.Task] = set()
  while True:
    line = await reader.readline()
    if not line:
      break
    try:
      command = json.loads(line)
    except json.JSONDecodeError:
      logging.warning("ignored a line that is not JSON")
      continue
    task = asyncio.create_task(handle(command))
    tasks.add(task)
    task.add_done_callback(tasks.discard)
  for session in list(_sessions.values()):
    await session.close()


if __name__ == "__main__":
  asyncio.run(main())
