"""The agent route: a query whose caller chose an agent at init runs that agent on a Marshal host.

The caller names the agent once, in its marshal-sdk.json (``"agent": "@scope/name"``, or ``"@scope/name:id"`` when the
extension declares several) or as ``marshal_sdk.init(path, agent=...)``. An agent is one an extension declares in its
runtime-extension.json (``contributes.agents``). From then on every ``marshal_sdk.query`` runs it with
``marshal-sdk agent-run``: the host the manifest declares (extensions, configuration, kit, Brain, model) starts, the agent
gets the query's working folder, prompt, model, effort and person, and the query yields a ``SystemMessage`` per host log
line and one ``ResultMessage`` with the run's whole usage and cost. What the agent reads in the working folder and
writes back is its own business; the caller's system prompt, skills, subagents and MCP servers are not used on this
route. With no agent named, a query runs the caller's own agent on the host (``marshal-claude``).

Per query: ``ClaudeAgentOptions(extra_args={"marshal-agent": "@scope/name"})`` runs another agent the manifest's
extensions declare, ``"none"`` the caller's own agent.

What this module keeps for every agent:
- the run's state folder: ``<cwd name>-logs/marshal-state`` beside the working folder when the caller keeps a logs
  folder there (agent-sandbox uploads it to ``<output root>/agent/``), else ``marshal-agent/state``;
- where that state is uploaded (``<output root>/agent/marshal-state``, the output root from
  $MARSHAL_SDK_RUN_OUTPUT_ROOT and the caller's run id the agent's ``runId`` points at), the run pointer Marshal
  desktop's cloud run list reads, and the link a later run continues from (the agent's ``resume`` file names it);
- who the run works for (the options' ``user`` email, else $MARSHAL_SDK_BRAIN_CALLER) and the service account key the
  caller blanked for its agent's tools (handed to the host as a private file).

Environment (all optional):
    MARSHAL_SDK_AGENT                   the agent over the manifest's and init()'s; ``none`` runs the caller's own agent
    MARSHAL_SDK_CLI                     the marshal-sdk CLI (default: the one this package carries)
    MARSHAL_SDK_FAKE=1                  a dry run: the agent's scripted backend instead of a model
    MARSHAL_SDK_STATE_ROOT              a folder or gs://bucket/prefix to keep each run's state in as well, by key (for
                                        callers whose output root is unknown)
    MARSHAL_SDK_KIT                     host kit parts over the manifest's (default: the manifest's kit)
    MARSHAL_SDK_RUN_OUTPUT_ROOT         the run's output root as a template on the caller's run id (default:
                                        agent-sandbox's layout, gs://$GCS_BUCKET/page-generation-runs/{run}/output)
    MARSHAL_SDK_RUN_POINTER_PREFIX      also write {prefix}/index/{run}.json = {"outputRoot": root}, the pointer a cloud host
                                        of the SDK sessions viewer lists (default gs://$GCS_BUCKET/marshal-sdk-cloud-runs
                                        when GCS_BUCKET is set)
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import uuid
from collections.abc import AsyncIterable, AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, Message, ResultMessage, SystemMessage

from marshal_sdk import _node, manifest

AGENT_ARG = "marshal-agent"
AGENT_ENV_VAR = "MARSHAL_SDK_AGENT"
NO_AGENT = "none"
CLI_ENV_VAR = "MARSHAL_SDK_CLI"
FAKE_ENV_VAR = "MARSHAL_SDK_FAKE"
STATE_ROOT_ENV_VAR = "MARSHAL_SDK_STATE_ROOT"
KIT_ENV_VAR = "MARSHAL_SDK_KIT"
BRAIN_CALLER_ENV_VAR = "MARSHAL_SDK_BRAIN_CALLER"
NOTICE_SUBTYPE = "marshal_sdk_notice"
PROGRESS_SUBTYPE = "marshal_agent"
SUMMARY_SUBTYPE = "marshal_agent_summary"
# The host, not the agent's tools, calls model APIs outside its sessions (decide services and the like); the caller's
# agent env blanks these keys for its tools, so the host takes them from the process.
HOST_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
# The host signs in to the Brain and Cloud Storage with the process's service account key. agent-sandbox blanks the
# key for its agent's tools, so the host gets it as a private file this variable names, never back in the tools' env.
SERVICE_KEY_FILE_ENV_VAR = "MARSHAL_SDK_SERVICE_KEY_FILE"
SERVICE_KEY_JSON_ENV_VAR = "GOOGLE_APPLICATION_CREDENTIALS_JSON"
SERVICE_KEY_PATH_ENV_VAR = "GOOGLE_APPLICATION_CREDENTIALS"
SERVICE_KEY_FILENAME = "service-key.json"
RUN_DIRNAME = "marshal-agent"
OUTPUT_ROOT_ENV_VAR = "MARSHAL_SDK_RUN_OUTPUT_ROOT"
# agent-sandbox's own run layout (its edit_turn_service checks base runs against it): GCS_BUCKET, else its default bucket.
SANDBOX_BUCKET_ENV_VAR = "GCS_BUCKET"
SANDBOX_DEFAULT_BUCKET = "zyg-ecom-prod-shops-artifacts"
SANDBOX_OUTPUT_ROOT = "gs://{bucket}/page-generation-runs/{{run}}/output"
STATE_DOWNLOAD_WORKERS = 16
DEFAULT_POINTER_FOLDER = "marshal-sdk-cloud-runs"
POINTER_PREFIX_ENV_VAR = "MARSHAL_SDK_RUN_POINTER_PREFIX"
# A caller that uploads the folder beside its working folder named <cwd name>-logs to <output root>/agent/ gets the
# state there, so it lands at <output root>/agent/marshal-state, the layout Marshal's cloud viewers read.
CALLER_LOGS_SUFFIX = "-logs"
STATE_DIRNAME = "marshal-state"
UPLOADED_STATE_PATH = "agent/marshal-state"
RUN_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def chosen(options: ClaudeAgentOptions | None) -> dict[str, Any] | None:
    """The agent this query runs (its entry in the checked manifest's report), or None for the caller's own agent.

    Order: the query's extra_args["marshal-agent"], $MARSHAL_SDK_AGENT, init(agent=...), the manifest's ``agent``.
    Raises manifest.MarshalInitError when the named agent is not on the host.
    """
    given = (options.extra_args or {}).get(AGENT_ARG) if options is not None else None
    given = given or os.environ.get(AGENT_ENV_VAR) or None
    if given == NO_AGENT:
        return None
    found = manifest.find(options)
    if found is None:
        if given:
            raise manifest.MarshalInitError([f"the agent {given} was asked for, but no {manifest.MANIFEST_FILE} declares a host"])
        return None
    report = manifest.report(found)
    if not given:
        return report.get("agent") or None
    entry = find(report.get("agents") or [], given)
    if entry is None:
        known = ", ".join(agent.get("ref", "") for agent in report.get("agents") or []) or "none"
        raise manifest.MarshalInitError([f"{found} declares no agent {given} (its extensions declare: {known})"])
    return entry


def find(agents: list[dict[str, Any]], ref: str) -> dict[str, Any] | None:
    """`@scope/name:id`, or `@scope/name` when that extension declares one agent."""
    exact = [agent for agent in agents if agent.get("ref") == ref]
    if exact:
        return exact[0]
    own = [agent for agent in agents if ":" not in ref and str(agent.get("ref", "")).startswith(f"{ref}:")]
    return own[0] if len(own) == 1 else None


def run_label(cwd: Path, agent: dict[str, Any]) -> str | None:
    """The caller's run id, where the agent's ``runId`` says it is ({file, field} with a dotted field)."""
    where = agent.get("runId") or {}
    if not where.get("file") or not where.get("field"):
        return None
    try:
        value: Any = json.loads((cwd / where["file"]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for part in str(where["field"]).split("."):
        value = value.get(part) if isinstance(value, dict) else None
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    return str(value) if RUN_LABEL.match(str(value)) else None


def output_root(run: str | None) -> str | None:
    """The run's gs:// output root from $MARSHAL_SDK_RUN_OUTPUT_ROOT and the caller's run id."""
    template = (os.environ.get(OUTPUT_ROOT_ENV_VAR) or "").strip() or SANDBOX_OUTPUT_ROOT.format(
        bucket=os.environ.get(SANDBOX_BUCKET_ENV_VAR) or SANDBOX_DEFAULT_BUCKET
    )
    return template.replace("{run}", run).rstrip("/") if template and run else None


def pointer_prefix() -> str:
    """Where Marshal desktop's cloud run list looks: $MARSHAL_SDK_RUN_POINTER_PREFIX, else gs://$GCS_BUCKET/marshal-sdk-cloud-runs
    when GCS_BUCKET is set explicitly (never the sandbox's default bucket, so a dev run writes nothing into it)."""
    given = (os.environ.get(POINTER_PREFIX_ENV_VAR) or "").strip().rstrip("/")
    bucket = (os.environ.get(SANDBOX_BUCKET_ENV_VAR) or "").strip()
    return given or (f"gs://{bucket}/{DEFAULT_POINTER_FOLDER}" if bucket else "")


def write_pointer(root: str, run: str) -> None:
    prefix = pointer_prefix()
    if not prefix.startswith("gs://"):
        return
    from google.cloud import storage

    bucket, _, path = prefix[len("gs://") :].partition("/")
    blob = storage.Client().bucket(bucket).blob(f"{path}/index/{run}.json" if path else f"index/{run}.json")
    blob.upload_from_string(json.dumps({"outputRoot": root}), content_type="application/json")


def resume_link(cwd: Path, agent: dict[str, Any]) -> tuple[bool, str | None]:
    """Whether this run continues an earlier one (the agent's ``resume`` file is there), and the state link it names."""
    where = agent.get("resume") or {}
    if not where.get("file") or not where.get("meta"):
        return False, None
    file = cwd / where["file"]
    if not file.is_file():
        return False, None
    found = re.search(rf'<meta\s+name="{re.escape(where["meta"])}"\s+content="([^"<>]+)"', file.read_text(encoding="utf-8", errors="replace"))
    return True, found.group(1) if found else None


def is_location(link: str) -> bool:
    return link.startswith("gs://") or link.startswith("/")


class StateRoot:
    """Each run's Marshal state between runs: a local folder or gs://bucket/prefix."""

    def __init__(self, root: str) -> None:
        self._root = root.rstrip("/")

    def save(self, key: str, state: Path) -> None:
        if not self._root.startswith("gs://"):
            target = Path(self._root) / key
            shutil.rmtree(target, ignore_errors=True)
            shutil.copytree(state, target, symlinks=True)
            return
        bucket, prefix = self._bucket()
        for path in state.rglob("*"):
            if path.is_file() and not path.is_symlink():
                bucket.blob(f"{prefix}{key}/{path.relative_to(state).as_posix()}").upload_from_filename(str(path))

    def load(self, key: str, state: Path) -> bool:
        if not self._root.startswith("gs://"):
            source = Path(self._root) / key if key else Path(self._root)
            if not source.is_dir():
                return False
            shutil.copytree(source, state, symlinks=True, dirs_exist_ok=True)
            return True
        bucket, prefix = self._bucket()
        folder = f"{prefix}{key}/" if key else prefix
        blobs = [blob for blob in bucket.list_blobs(prefix=folder) if not blob.name.endswith("/")]

        def fetch(blob: Any) -> None:
            target = state / blob.name[len(folder) :]
            target.parent.mkdir(parents=True, exist_ok=True)
            blob.download_to_filename(str(target))

        with ThreadPoolExecutor(max_workers=STATE_DOWNLOAD_WORKERS) as pool:
            list(pool.map(fetch, blobs))
        return bool(blobs)

    def _bucket(self) -> tuple[Any, str]:
        from google.cloud import storage  # the sandbox has it; only gs:// roots need it

        bucket, _, prefix = self._root[len("gs://") :].partition("/")
        return storage.Client().bucket(bucket), f"{prefix}/" if prefix else ""


def load_state(link: str | None, root: StateRoot | None, state: Path) -> bool:
    """An earlier run's state into this run's state folder: from the location the link names, else by key."""
    if link is None:
        return False
    if is_location(link):
        return StateRoot(link).load("", state)
    return root is not None and root.load(link, state)


def cli() -> list[str]:
    """The marshal-sdk CLI: $MARSHAL_SDK_CLI, else the one this package carries."""
    found = os.environ.get(CLI_ENV_VAR)
    if not found:
        return _node.cli_command()
    return [_node.node(), found] if found.endswith(".js") else [found]


def kit() -> str | None:
    """Kit parts named in $MARSHAL_SDK_KIT, over the manifest's; None leaves the manifest's kit."""
    parts = os.environ.get(KIT_ENV_VAR, "").strip()
    return None if parts.lower() in ("", "none", "off") else parts


def person(options: ClaudeAgentOptions) -> str | None:
    """Who the run works for: the options' user when it is an email address (the caller sets it from its own request),
    else $MARSHAL_SDK_BRAIN_CALLER. claude_agent_sdk spawns its CLI as the OS user ``user`` names, so marshal_sdk takes
    an email there as the person and never passes it on as an OS user (see on_marshal)."""
    given = options.user if is_email(options.user) else os.environ.get(BRAIN_CALLER_ENV_VAR)
    return (given or "").strip().lower() or None


def is_email(value: str | None) -> bool:
    return bool(value) and re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value.strip()) is not None


def host_env(options: ClaudeAgentOptions) -> dict[str, str]:
    env = {**os.environ, **_node.tool_env(), **{key: str(value) for key, value in (options.env or {}).items()}}
    for key in HOST_KEYS:
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


def hand_service_key(env: dict[str, str]) -> Path | None:
    """When the caller blanked the service account key for its agent's tools, hand it to the host as a 0600 file in a
    fresh private folder and name it in env; returns that folder for the caller to delete when the run ends."""
    if env.get(SERVICE_KEY_JSON_ENV_VAR, "").strip() or env.get(SERVICE_KEY_PATH_ENV_VAR):
        return None
    inline = os.environ.get(SERVICE_KEY_JSON_ENV_VAR, "").strip()
    if not inline:
        if os.environ.get(SERVICE_KEY_PATH_ENV_VAR):
            env[SERVICE_KEY_FILE_ENV_VAR] = os.environ[SERVICE_KEY_PATH_ENV_VAR]
        return None
    folder = Path(tempfile.mkdtemp(prefix="marshal-sdk-key-"))
    key = folder / SERVICE_KEY_FILENAME
    with os.fdopen(os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as handle:
        handle.write(inline)
    env[SERVICE_KEY_FILE_ENV_VAR] = str(key)
    return folder


async def prompt_text(prompt: str | AsyncIterable[dict[str, Any]]) -> str:
    """The query's prompt as text: the string, or the text of the streamed user messages."""
    if isinstance(prompt, str):
        return prompt
    parts: list[str] = []
    async for message in prompt:
        content = (message.get("message") or {}).get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(str(block.get("text", "")) for block in content if isinstance(block, dict) and block.get("type") == "text")
    return "\n".join(parts)


class _PassThrough(Exception):
    """This query goes to the caller's own agent after all."""


async def run(options: ClaudeAgentOptions, agent: dict[str, Any], prompt: str | AsyncIterable[dict[str, Any]]) -> AsyncIterator[Message]:
    """One run of the agent on the Marshal host, answered as the caller's query."""
    ref = str(agent["ref"])
    cwd = Path(str(options.cwd or os.getcwd())).resolve()
    run_dir = cwd.parent / RUN_DIRNAME
    caller_logs = cwd.parent / f"{cwd.name}{CALLER_LOGS_SUFFIX}"
    logs = run_dir / "logs"
    state = caller_logs / STATE_DIRNAME if caller_logs.is_dir() else run_dir / "state"
    logs.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True)
    root = StateRoot(os.environ[STATE_ROOT_ENV_VAR]) if os.environ.get(STATE_ROOT_ENV_VAR) else None
    env = host_env(options)
    label = run_label(cwd, agent)
    run_root = output_root(label)
    location = f"{run_root}/{UPLOADED_STATE_PATH}" if run_root is not None and state.parent == caller_logs else None
    resumed, earlier = resume_link(cwd, agent)
    if resumed and not load_state(earlier, root, state):
        yield SystemMessage(
            subtype=PROGRESS_SUBTYPE,
            data={"warning": f"{ref}: the run this one continues left no Marshal state; this query runs the caller's own agent"},
        )
        raise _PassThrough
    if location is not None and label is not None:
        try:
            write_pointer(run_root, label)
        except Exception as error:  # a missing pointer only hides the run from cloud listings
            yield SystemMessage(subtype=PROGRESS_SUBTYPE, data={"warning": f"run pointer not written: {error!r}"})
    key = str(uuid.uuid4()) if root is not None else None
    # The location wins: it is the state a desktop push updates; the key is only a copy taken when the run ends.
    link = location or key
    prompt_file = logs / "prompt.md"
    prompt_file.write_text(await prompt_text(prompt), encoding="utf-8")
    declared = manifest.find(options)
    who = person(options)
    args = [
        "agent-run", "--agent", ref, "--cwd", str(cwd), "--state", str(state), "--logs", str(logs), "--prompt", f"@{prompt_file}",
        *(["--manifest", str(declared)] if declared is not None else []),
        *(["--person", who] if who else []),
        *(["--model", options.model] if options.model else []),
        *(["--effort", str(options.effort)] if options.effort else []),
        *(["--kit", kit()] if kit() else []),
        *(["--state-location", location] if location else []),
        *(["--state-link", link] if link else []),
        *(["--run-label", label] if label else []),
        *(["--resumed"] if resumed else []),
        *(["--fake"] if os.environ.get(FAKE_ENV_VAR) == "1" else []),
        "--host-id", "agent-sandbox",
    ]
    key_folder = hand_service_key(env)
    try:
        process = await asyncio.create_subprocess_exec(
            *cli(), *args, env=env, cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=16 * 1024 * 1024,
        )
        assert process.stderr is not None and process.stdout is not None
        stdout_task = asyncio.create_task(process.stdout.read())
        async for raw in process.stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                yield SystemMessage(subtype=PROGRESS_SUBTYPE, data={"line": line})
        code = await process.wait()
        await stdout_task
    finally:
        if key_folder is not None:
            shutil.rmtree(key_folder, ignore_errors=True)
    summary_file = logs / "summary.json"
    summary: dict[str, Any] = json.loads(summary_file.read_text(encoding="utf-8")) if summary_file.is_file() else {}
    if code == 0 and root is not None and key is not None:
        root.save(key, state)
    yield SystemMessage(
        subtype=SUMMARY_SUBTYPE,
        data={"agent": ref, "summary": summary, "state_key": key, "state_location": location, "exit_code": code},
    )
    yield result_message(summary, code, ref)


def result_message(summary: dict[str, Any], code: int, ref: str) -> ResultMessage:
    """The whole run as one SDK result: summed usage, per-model usage and the run's cost."""
    results = summary.get("results") or []
    usage: dict[str, int] = {}
    model_usage: dict[str, dict[str, float]] = {}
    for result in results:
        for name, value in (result.get("usage") or {}).items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                usage[name] = usage.get(name, 0) + int(value)
        for model, counts in (result.get("model_usage") or {}).items():
            merged = model_usage.setdefault(model, {})
            for name, value in counts.items():
                if isinstance(value, (int, float)) and not isinstance(value, bool) and name not in ("contextWindow", "maxOutputTokens"):
                    merged[name] = merged.get(name, 0) + value
    totals = summary.get("totals") or {}
    marshal = summary.get("marshal") or {}
    error = summary.get("error") or ("" if code == 0 else f"marshal-sdk exited with {code}")
    return ResultMessage(
        subtype="error_during_execution" if error else "success",
        duration_ms=int(totals.get("duration_ms") or (summary.get("wall_seconds") or 0) * 1000),
        duration_api_ms=int(totals.get("duration_api_ms") or 0),
        is_error=bool(error),
        num_turns=int(totals.get("num_turns") or 0),
        session_id=str(marshal.get("runId") or ""),
        total_cost_usd=float(totals.get("total_cost_usd") or sum(r.get("total_cost_usd") or 0 for r in results)),
        usage=usage,
        model_usage=model_usage,
        result=error or str(marshal.get("reply") or ""),
        origin={"kind": "marshal-agent", "agent": ref},
    )


async def query(
    options: ClaudeAgentOptions,
    agent: dict[str, Any],
    prompt: str | AsyncIterable[dict[str, Any]],
    fallback: Callable[[], AsyncIterator[Message]],
) -> AsyncIterator[Message]:
    """The agent's answer to the query, or the caller's own agent when the run it continues left no state."""
    try:
        async for message in run(options, agent, prompt):
            yield message
    except _PassThrough:
        async for message in fallback():
            yield message


__all__ = ["chosen", "find", "query", "result_message", "run"]
