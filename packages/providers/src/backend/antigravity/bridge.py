"""Marshal's bridge to the Google Antigravity SDK (google-antigravity, Python).

One process serves every Antigravity session of one Marshal runtime client.
It speaks JSON lines: commands arrive on stdin, events leave on stdout, and
logs go to stderr. Each session is one `Agent` whose tool calls are decided by
Marshal (the pre-tool hook asks the host) and whose host tools run in Marshal.
"""

import asyncio
import json
import logging
import collections
import os
import re
import sqlite3
import sys
import traceback
import uuid

from google.antigravity import Agent, LocalAgentConfig, types
from google.antigravity import models as agy_models
from google.antigravity.hooks import hooks as agy_hooks
from google.antigravity.hooks import policy as agy_policy
from google.antigravity.tools import tool_runner as agy_tool_runner

try:
  from google.antigravity.connections.local import local_connection as agy_local_connection
  from google.antigravity.proto import localharness_pb2 as agy_harness_proto
except ImportError:  # Another SDK layout: replace-mode prompts go out as CustomSystemInstructions.
  agy_local_connection = None
  agy_harness_proto = None

PROTOCOL_VERSION = 1

# A cancel that the harness doesn't honour within this many seconds (a dead connection, a hook still waiting on
# the host) is finished by cancelling the turn's task; the Agent is then restarted on the same conversation.
CANCEL_GRACE_SECONDS = 5
CLOSE_SECONDS = 10
CANCELLED = "The turn was cancelled"

# Step types in a conversation's trajectory database (<saveDir>/<conversationId>.db, table `steps`), as
# google-antigravity 0.1.24's harness numbers them.
STEP_USER_INPUT = 14
STEP_PLANNER_RESPONSE = 15
STEP_ERROR_MESSAGE = 17
STEP_SYSTEM_MESSAGE = 101

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


# The harness error for a tool result whose call it can't find while building the next model request; the
# id is the model's call id (a Go format string in the localharness binary).
MISSING_CALL_ERROR = re.compile(r"tool call id (\S+) not found in map")

# The SDK logs each failed system step (local_connection.py) with its harness status code and error; the bridge
# keeps the latest ones so a failed turn can report them.
STEP_ERROR_LOG_FORMAT = "System step error (HTTP %s): %s"
_step_errors: collections.deque = collections.deque(maxlen=32)


class _StepErrorRecorder(logging.Handler):

  def emit(self, record: logging.LogRecord) -> None:
    if record.msg == STEP_ERROR_LOG_FORMAT and isinstance(record.args, tuple) and len(record.args) == 2:
      _step_errors.append({"httpCode": record.args[0], "stepError": str(record.args[1])})


def _step_error_for(message: str) -> dict | None:
  for entry in reversed(_step_errors):
    if message and message in entry["stepError"]:
      return entry
  return None


# A prompt that replaces Google's goes to the harness as template overrides, not as CustomSystemInstructions.
# Under CustomSystemInstructions the harness doesn't render a compaction's summary, so after a compaction every
# request starts at the first user-role step. In a turn with no user input since the compaction that is a background
# task's "finished" SYSTEM_MESSAGE: everything before it is dropped, and when the message directly follows a tool
# result the harness folds it into that result and can't find the result's call ("tool call id <id> not found in
# map"; conversations d6bdf896, 7afca41e, bd1438bc, 2026-11-25/26). With overrides the harness keeps its default
# request path: `identity` carries Marshal's prompt and every other section of Google's default prompt is removed.
# These are the sections google-antigravity 0.1.24 renders for Gemini models (the dynamic skills list stays, as it
# does under CustomSystemInstructions). The harness refuses to remove a section it left out (gemini-4-neon has no
# "guidelines"): the bridge then remembers that title for the model and sends the turn again.
DEFAULT_PROMPT_SECTIONS = (
    "non_interactive_mode",
    "user_information",
    "subagents",
    "messaging",
    "conversation_transcript",
    "guidelines",
    "communication_style",
    "memory_rules",
)
# As an exception the title is quoted; inside a harness step error it comes escaped (\"guidelines\").
ABSENT_SECTION_ERROR = re.compile(r'template override title \\?"([^"\\]+)\\?" has not been included')
# model -> default prompt sections the harness leaves out for it
_absent_sections: dict[str, set[str]] = {}


class ReplacingSystemInstructions(types.CustomSystemInstructions):
  """Marshal's prompt in place of Google's, sent as template overrides (see DEFAULT_PROMPT_SECTIONS)."""

  removed_sections: list[str] = []


_sdk_system_instructions_proto = getattr(agy_local_connection, "to_system_instructions_proto", None)
OVERRIDES_SUPPORTED = _sdk_system_instructions_proto is not None and hasattr(agy_harness_proto, "TemplateOverride")


def _system_instructions_proto(instructions):
  if isinstance(instructions, ReplacingSystemInstructions):
    proto = agy_harness_proto.SystemInstructions()
    proto.overrides.add(title="identity", text=instructions.text)
    for title in instructions.removed_sections:
      proto.overrides.add(title=title, remove=True)
    return proto
  return _sdk_system_instructions_proto(instructions)


if OVERRIDES_SUPPORTED:
  agy_local_connection.to_system_instructions_proto = _system_instructions_proto


def _drop_failed_input(con: sqlite3.Connection) -> list[int]:
  """Deletes a failed attempt's trailing user input and error steps, so its turn can be sent again."""
  last = con.execute("SELECT idx, step_type FROM steps ORDER BY idx DESC LIMIT 2").fetchall()
  if [kind for _, kind in last] != [STEP_ERROR_MESSAGE, STEP_USER_INPUT]:
    return []
  dropped = sorted(idx for idx, _ in last)
  con.execute("DELETE FROM steps WHERE idx >= ?", (dropped[0],))
  return dropped


def _drop_failed_attempt(db_path: str) -> list[int]:
  if not os.path.exists(db_path):
    return []
  con = sqlite3.connect(db_path)
  try:
    with con:
      return _drop_failed_input(con)
  finally:
    con.close()


def _repair_trajectory(db_path: str, call_id: str, drop_failed_input: bool) -> dict | None:
  """Moves the system message that landed after `call_id`'s tool result back before that result.

  A background task that finishes while the model's next tool call runs is announced by a SYSTEM_MESSAGE step
  written after that call's result. With custom system instructions (Marshal's prompt) the harness can no
  longer build a request from that layout ("tool call id <call_id> not found in map"), and every later turn of
  the conversation fails the same way (2026-11-20, conversation cf3f4022). The same message placed between the
  model's call and its result replays fine. With `drop_failed_input`, the failed attempt's own user input and
  error step are removed too, so the turn can be sent again without a duplicate. Returns what changed, or None.
  The failed attempts' gen_metadata/executor_metadata rows stay: they are keyed by their own counters, not by
  step, and a conversation that keeps them replays fine. Replace-mode prompts now go out as template overrides
  (DEFAULT_PROMPT_SECTIONS), which build that layout fine, so this is only a fallback.
  """
  if not os.path.exists(db_path):
    return None
  con = sqlite3.connect(db_path)
  try:
    rows = con.execute("SELECT idx, step_type FROM steps ORDER BY idx").fetchall()
    order = [idx for idx, _ in rows]
    kinds = dict(rows)
    boundaries = {STEP_USER_INPUT, STEP_PLANNER_RESPONSE, STEP_ERROR_MESSAGE, STEP_SYSTEM_MESSAGE}
    holders = {
        idx
        for (idx,) in con.execute("SELECT idx FROM steps WHERE instr(step_payload, ?) > 0", (call_id.encode(),))
        if kinds.get(idx) not in boundaries
    }
    if not holders:
      return None
    result_pos = order.index(max(holders))
    start = result_pos
    while start > 0 and kinds[order[start - 1]] not in boundaries:
      start -= 1
    stop = result_pos + 1
    while stop < len(order) and kinds[order[stop]] not in boundaries:
      stop += 1
    if start == 0 or kinds[order[start - 1]] != STEP_PLANNER_RESPONSE:
      return None
    late = stop
    while late < len(order) and kinds[order[late]] == STEP_SYSTEM_MESSAGE:
      late += 1
    if late == stop:
      return None
    moved = order[stop:late]
    results = order[start:stop]
    order[start:late] = moved + results
    with con:
      for slot, idx in zip([idx for idx, _ in rows], order):
        if slot != idx:
          con.execute("UPDATE steps SET idx = ? WHERE idx = ?", (-1 - slot, idx))
      con.execute("UPDATE steps SET idx = -1 - idx WHERE idx < 0")
      dropped = _drop_failed_input(con) if drop_failed_input else []
    return {"systemMessageSteps": moved, "toolResultSteps": results, "droppedSteps": dropped}
  finally:
    con.close()


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

  def _model_name(self) -> str:
    return self.config.get("model") or agy_models.DEFAULT_MODEL

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
      if not OVERRIDES_SUPPORTED:
        return types.CustomSystemInstructions(text=system["text"])
      absent = _absent_sections.get(self._model_name(), set())
      return ReplacingSystemInstructions(
          text=system["text"], removed_sections=[title for title in DEFAULT_PROMPT_SECTIONS if title not in absent]
      )
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

  @staticmethod
  def _error_fields(error: BaseException) -> dict:
    fields = {"errorType": type(error).__name__, "details": [_jsonable(arg) for arg in error.args]}
    step_error = _step_error_for(str(error))
    if step_error:
      fields.update(step_error)
    return fields

  async def _turn_error(
      self, turn: str, error: BaseException, recovery: str | None = None, repair: dict | None = None
  ) -> None:
    message = str(error) or type(error).__name__
    auth = await asyncio.to_thread(_auth_problem, self.config)
    event = {"ev": "turn_error", "session": self.id, "turn": turn, "error": auth or message, **self._error_fields(error)}
    if auth:
      event["code"] = "auth"
    if recovery:
      event["recovery"] = recovery
    if repair:
      event["repair"] = repair
    logging.error("turn %s failed: %s", turn, json.dumps({k: v for k, v in event.items() if k != "ev"}, default=str))
    await emit(event)

  async def run_turn(self, turn: str, prompt: str, media: list[dict], retried: bool = False) -> None:
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
    produced = False
    failure: Exception | None = None
    try:
      steps_before = len(self.agent.conversation.history)
      response = await self.agent.chat(content)
      self.response = response
      async for chunk in response.chunks:
        produced = True
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
      system_error = self._system_error_since(steps_before)
      if system_error:
        # The SDK only logs a harness error that arrives as a step, and the turn would end as an empty reply.
        raise types.AntigravityExecutionError(system_error)
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
      failure = error
    finally:
      self.response = None
    if failure is None:
      return
    absent = ABSENT_SECTION_ERROR.search(str(failure)) if isinstance(failure, types.AntigravityExecutionError) else None
    learned = _absent_sections.setdefault(self._model_name(), set())
    if (
        absent is not None
        and not produced
        and absent.group(1) in DEFAULT_PROMPT_SECTIONS
        and absent.group(1) not in learned
    ):
      # The request was refused before it reached the model: reopen without that override and send the turn again.
      learned.add(absent.group(1))
      await self._stop_agent()
      dropped = await asyncio.to_thread(self._drop_failed_attempt_steps)
      logging.warning(
          "default prompt section %r is absent for %s; resending turn %s (dropped steps %s)",
          absent.group(1), self._model_name(), turn, dropped,
      )
      await self.run_turn(turn, prompt, media, retried=retried)
      return
    missing = MISSING_CALL_ERROR.search(str(failure)) if isinstance(failure, types.AntigravityExecutionError) else None
    if missing is None:
      await self._turn_error(turn, failure)
      return
    if retried:
      await self._turn_error(turn, failure, recovery="failed: the repaired conversation failed again")
      return
    try:
      repair = await self._heal_trajectory(missing.group(1), drop_failed_input=not produced)
    except asyncio.CancelledError:
      await emit({"ev": "turn_end", "session": self.id, "turn": turn, "cancelled": True})
      return
    if repair is None:
      await self._turn_error(turn, failure, recovery="failed: no late system message to move")
      return
    if produced:
      await self._turn_error(turn, failure, recovery="repaired; the next turn continues", repair=repair)
      return
    # The request never reached the model: send the same turn again on the repaired conversation.
    await emit({
        "ev": "recovered",
        "session": self.id,
        "turn": turn,
        **self._error_fields(failure),
        "recovery": "repaired and retried",
        "repair": repair,
    })
    await self.run_turn(turn, prompt, media, retried=True)

  def _system_error_since(self, steps_before: int) -> str | None:
    """The error of the harness (SYSTEM) step this turn ended on, if it ended on one."""
    if self.agent is None:
      return None
    history = self.agent.conversation.history
    if len(history) <= steps_before:
      return None
    step = history[-1]
    if step.status == types.StepStatus.ERROR and step.source == types.StepSource.SYSTEM and step.error:
      return step.error
    return None

  def _drop_failed_attempt_steps(self) -> list[int]:
    save_dir = self.config.get("saveDir")
    conversation_id = self.config.get("conversationId")
    if not save_dir or not conversation_id:
      return []
    try:
      return _drop_failed_attempt(os.path.join(save_dir, conversation_id + ".db"))
    except sqlite3.Error:
      logging.warning("dropping the failed attempt failed: %s", traceback.format_exc())
      return []

  async def _heal_trajectory(self, call_id: str, drop_failed_input: bool) -> dict | None:
    save_dir = self.config.get("saveDir")
    conversation_id = self.config.get("conversationId")
    if not save_dir or not conversation_id:
      return None
    # The harness owns the database while the Agent runs; the next turn reopens it (needs_reopen is set).
    await self._stop_agent()
    db_path = os.path.join(save_dir, conversation_id + ".db")
    try:
      repair = await asyncio.to_thread(_repair_trajectory, db_path, call_id, drop_failed_input)
    except sqlite3.Error:
      logging.warning("repairing the trajectory failed: %s", traceback.format_exc())
      return None
    logging.warning("trajectory repair of %s for call %s: %s", conversation_id, call_id, repair)
    return repair

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
    pending = _pending.get(command.get("id", ""))
    future = pending[2] if pending is not None else None
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
  logging.getLogger().addHandler(_StepErrorRecorder())
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
