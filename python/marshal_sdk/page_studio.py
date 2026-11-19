"""Page builds on the Page Studio extension: an agent-sandbox page-agent query, answered by ``marshal-sdk page-run``.

A query whose working folder is an agent-sandbox page-agent workspace
(``input/page/brief.json`` and ``input/products/``), on a host whose marshal-sdk.json lists ``@zyg/page-studio``, does
not start the caller's own agent. Page Studio, its configuration, the kit, the Brain and the model all come from that
manifest (see manifest.py); nothing is taken from inside this package. Without such a manifest the query runs the
caller's own agent and says so in a SystemMessage. The page is built (or, when
``input/page/base-page/index.html`` exists, edited) by Page Studio on a headless Marshal host, on Marshal's own system
prompt and Page Studio's own skills, critic and copy. The caller's system prompt, skills, subagents and in-process MCP
servers are not used on this path; any other query runs through marshal-claude as before.

The run contract is the one the caller's agent would have met: ``out/index.html`` (+ ``out/assets/``, ``out/shots/``,
``out/notes.md``). The query yields a ``SystemMessage`` per host log line and one ``ResultMessage`` carrying the run's
whole usage and cost, so the caller's run log and summary work unchanged.

Each page carries where its Marshal state is kept (a ``marshal-page-state`` meta tag): the run's uploaded logs,
``<output root>/agent/marshal-state``. An edit loads that state, so it continues the page as it is now, including an
edit made in Marshal desktop's Page Studio and pushed back to the run (sdksessions.pushToCloud updates that state and
re-stamps the tag).

Environment (all optional):
    MARSHAL_SDK_ENGINE                  page-studio (default) routes page-agent workspaces to Page Studio; claude runs the
                                        caller's own agent
    MARSHAL_SDK_CLI                     the marshal-sdk CLI (default: the one this package carries)
    MARSHAL_SDK_MANIFEST                the marshal-sdk.json (default: the one marshal_sdk.init() loaded, else
                                        ./marshal-sdk.json, else beside the agent's working folder)
    MARSHAL_SDK_PAGE_DEPTH              quick | single | deep (default single)
    MARSHAL_SDK_PAGE_STATE_ROOT         a folder or gs://bucket/prefix to keep each page's state in as well, by key (for
                                        callers whose output root is unknown)
    MARSHAL_SDK_KIT                     host kit parts over the manifest's (default: the manifest's kit)
    MARSHAL_SDK_RUN_POINTER_PREFIX      where the run's pointer for Marshal desktop's cloud run list goes (default
                                        gs://$GCS_BUCKET/marshal-sdk-cloud-runs when GCS_BUCKET is set)
    MARSHAL_SDK_RUN_OUTPUT_ROOT         the run's output root as a template on the brief's page_generation_run_id
                                        (default: agent-sandbox's own layout, gs://$GCS_BUCKET/page-generation-runs/{run}/
                                        output, with its default bucket when GCS_BUCKET is unset). The run's published sessions
                                        name {root}/agent/marshal-state (where agent-sandbox uploads the state kept in its
                                        logs folder), so Marshal desktops and Page Studio find the run.
    MARSHAL_SDK_RUN_POINTER_PREFIX      with the output root: also write {prefix}/index/{run}.json = {"outputRoot": root},
                                        the pointer a cloud host of the SDK sessions viewer lists.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, Message, ResultMessage, SystemMessage

from marshal_sdk import _node, manifest

ENGINE_ENV_VAR = "MARSHAL_SDK_ENGINE"
ENGINE_PAGE_STUDIO = "page-studio"
ENGINE_CLAUDE = "claude"
CLI_ENV_VAR = "MARSHAL_SDK_CLI"
DEPTH_ENV_VAR = "MARSHAL_SDK_PAGE_DEPTH"
STATE_ROOT_ENV_VAR = "MARSHAL_SDK_PAGE_STATE_ROOT"
KIT_ENV_VAR = "MARSHAL_SDK_KIT"
BRAIN_CALLER_ENV_VAR = "MARSHAL_SDK_BRAIN_CALLER"
NOTICE_SUBTYPE = "marshal_sdk_notice"
# Page Studio's scripted backend (no model): the dry path, for tests.
FAKE_ENV_VAR = "MARSHAL_SDK_PAGE_FAKE"
# The host, not the agent's tools, calls the Decisions API that routes Page Studio's edits; the caller's agent env
# blanks this key for its tools, so the host takes it from the process.
HOST_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
# The host signs in to the Brain and Cloud Storage with the process's service account key. agent-sandbox blanks the
# key for its agent's tools, so the host gets it as a private file this variable names, never back in the tools' env.
SERVICE_KEY_FILE_ENV_VAR = "MARSHAL_SDK_SERVICE_KEY_FILE"
SERVICE_KEY_JSON_ENV_VAR = "GOOGLE_APPLICATION_CREDENTIALS_JSON"
SERVICE_KEY_PATH_ENV_VAR = "GOOGLE_APPLICATION_CREDENTIALS"
SERVICE_KEY_FILENAME = "service-key.json"
STATE_META = "marshal-page-state"
RUN_DIRNAME = "marshal-page-studio"
LOG_PREFIX = "[marshal-sdk page-"
PROGRESS_SUBTYPE = "marshal_page_studio"
SUMMARY_SUBTYPE = "marshal_page_studio_summary"
CHANGE_REQUEST_MARKER = "Change request:"
OUTPUT_ROOT_ENV_VAR = "MARSHAL_SDK_RUN_OUTPUT_ROOT"
# agent-sandbox's own run layout (its edit_turn_service checks base runs against it): GCS_BUCKET, else its default bucket.
SANDBOX_BUCKET_ENV_VAR = "GCS_BUCKET"
SANDBOX_DEFAULT_BUCKET = "zyg-ecom-prod-shops-artifacts"
SANDBOX_OUTPUT_ROOT = "gs://{bucket}/page-generation-runs/{{run}}/output"
STATE_DOWNLOAD_WORKERS = 16
DEFAULT_POINTER_FOLDER = "marshal-sdk-cloud-runs"
POINTER_PREFIX_ENV_VAR = "MARSHAL_SDK_RUN_POINTER_PREFIX"
STATE_LOCATION_ENV_VAR = "MARSHAL_SDK_STATE_LOCATION"
# agent-sandbox uploads everything in the folder beside page-agent/ to <output root>/agent/, so state kept there lands at
# <output root>/agent/marshal-state, the layout Marshal's cloud viewers read.
CALLER_LOGS_DIRNAME = "page-agent-logs"
STATE_DIRNAME = "marshal-state"
UPLOADED_STATE_PATH = "agent/marshal-state"


def run_label(cwd: Path) -> str | None:
    """The brief's page_generation_run_id, when the caller's pack names one."""
    try:
        source = json.loads((cwd / "input" / "page" / "brief.json").read_text(encoding="utf-8")).get("source") or {}
    except (OSError, ValueError, AttributeError):
        return None
    run = source.get("page_generation_run_id") if isinstance(source, dict) else None
    return str(run) if isinstance(run, int) or (isinstance(run, str) and run.isdigit()) else None


def output_root(cwd: Path) -> str | None:
    """The run's gs:// output root from $MARSHAL_SDK_RUN_OUTPUT_ROOT and the brief's run id."""
    template = (os.environ.get(OUTPUT_ROOT_ENV_VAR) or "").strip() or SANDBOX_OUTPUT_ROOT.format(
        bucket=os.environ.get(SANDBOX_BUCKET_ENV_VAR) or SANDBOX_DEFAULT_BUCKET
    )
    run = run_label(cwd)
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


def page_request(options: ClaudeAgentOptions | None) -> bool:
    """Whether this query is a page-agent build or edit (its working folder is an agent-sandbox page-agent workspace)."""
    if os.environ.get(ENGINE_ENV_VAR, ENGINE_PAGE_STUDIO) != ENGINE_PAGE_STUDIO or options is None or options.cwd is None:
        return False
    input_dir = Path(options.cwd) / "input"
    return (input_dir / "page" / "brief.json").is_file() and (input_dir / "products").is_dir()


def routes(options: ClaudeAgentOptions | None) -> bool:
    """Whether Page Studio answers this query: a page-agent request on a host whose manifest lists Page Studio.

    Raises manifest.MarshalInitError when the manifest cannot start a host (a missing setting, extension or variable).
    """
    if not page_request(options):
        return False
    found = manifest.find(options)
    return found is not None and manifest.lists(found, manifest.PAGE_STUDIO)


def not_routed_notice(options: ClaudeAgentOptions | None) -> SystemMessage:
    """Why a page-agent request runs the caller's own agent: no manifest, or one that does not list Page Studio."""
    found = manifest.find(options)
    reason = (
        f"no {manifest.MANIFEST_FILE} was found (marshal_sdk.init(path) or ${manifest.MANIFEST_ENV_VAR})"
        if found is None
        else f"{found} does not list {manifest.PAGE_STUDIO}"
    )
    return SystemMessage(subtype=NOTICE_SUBTYPE, data={"notice": f"this page request runs the caller's own agent: {reason}"})


def base_page(cwd: Path) -> Path | None:
    page = cwd / "input" / "page" / "base-page" / "index.html"
    return page if page.is_file() else None


def page_state_key(html: str) -> str | None:
    """The page's state link: a location (gs://… or a folder) or, from older runs, a key under the state root."""
    found = re.search(rf'<meta\s+name="{STATE_META}"\s+content="([^"<>]+)"', html)
    return found.group(1) if found else None


def is_location(link: str) -> bool:
    return link.startswith("gs://") or link.startswith("/")


def stamp_state_key(html: str, key: str) -> str:
    """The page with its state key in a meta tag (replacing an older one), so an edit of it finds its Marshal state."""
    meta = f'<meta name="{STATE_META}" content="{key}">'
    html = re.sub(rf'<meta\s+name="{STATE_META}"\s+content="[^"]*"\s*/?>\s*', "", html)
    head = re.search(r"<head[^>]*>", html, re.IGNORECASE)
    return f"{html[: head.end()]}{meta}{html[head.end():]}" if head else f"{meta}{html}"


def change_request(operator_request: str) -> str:
    """The latest change of an edit run's operator-request.md (its last block of ``Change request:`` lines)."""
    lines = operator_request.strip().splitlines()
    block: list[str] = []
    for line in reversed(lines):
        if line.strip().startswith(CHANGE_REQUEST_MARKER):
            block.insert(0, line.strip()[len(CHANGE_REQUEST_MARKER) :].strip())
        elif block and line.strip():
            break
    return "\n".join(block) or operator_request.strip()


class StateRoot:
    """Each page's Marshal state between runs: a local folder or gs://bucket/prefix."""

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


def load_base_state(link: str | None, root: StateRoot | None, state: Path) -> bool:
    """The base page's Marshal state into the edit's state folder: from the location the page names, else by key."""
    if link is None:
        return False
    if is_location(link):
        return StateRoot(link).load("", state)
    return root is not None and root.load(link, state)


async def run(options: ClaudeAgentOptions) -> AsyncIterator[Message]:
    """One page build or edit by Page Studio, as the caller's query would have made it."""
    cwd = Path(str(options.cwd)).resolve()
    run_dir = cwd.parent / RUN_DIRNAME
    caller_logs = cwd.parent / CALLER_LOGS_DIRNAME
    logs, out = run_dir / "logs", cwd / "out"
    state = caller_logs / STATE_DIRNAME if caller_logs.is_dir() else run_dir / "state"
    logs.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True)
    root = StateRoot(os.environ[STATE_ROOT_ENV_VAR]) if os.environ.get(STATE_ROOT_ENV_VAR) else None
    env = host_env(options)
    run_root = output_root(cwd)
    location = f"{run_root}/{UPLOADED_STATE_PATH}" if run_root is not None and state.parent == caller_logs else None
    if location is not None:
        env[STATE_LOCATION_ENV_VAR] = location
        try:
            write_pointer(run_root, str(run_label(cwd)))
        except Exception as error:  # a missing pointer only hides the run from cloud listings
            yield SystemMessage(subtype=PROGRESS_SUBTYPE, data={"warning": f"run pointer not written: {error!r}"})
    declared = manifest.find(options)
    common = [
        *(["--manifest", str(declared)] if declared is not None else []),
        *(["--person", person(options)] if person(options) else []),
        *(["--model", options.model] if options.model else []),
        *(["--effort", str(options.effort)] if options.effort else []),
        *(["--kit", kit()] if kit() else []),
        *(["--fake"] if os.environ.get(FAKE_ENV_VAR) == "1" else []),
        "--host-id", "agent-sandbox",
    ]
    edited = base_page(cwd)
    if edited is not None:
        link = page_state_key(edited.read_text(encoding="utf-8"))
        if not load_base_state(link, root, state):
            yield SystemMessage(
                subtype=PROGRESS_SUBTYPE,
                data={"warning": "the base page has no Marshal state to edit; this edit runs the caller's own agent"},
            )
            raise _PassThrough
        request_file = logs / "request.md"
        request_file.write_text(
            change_request((cwd / "input" / "page" / "operator-request.md").read_text(encoding="utf-8")), encoding="utf-8"
        )
        args = ["page-edit", "--state", str(state), "--out", str(out), "--logs", str(logs), "--request", f"@{request_file}"]
    else:
        args = [
            "page-run", "--input", str(cwd / "input"), "--out", str(out), "--logs", str(logs), "--state", str(state),
            "--depth", os.environ.get(DEPTH_ENV_VAR, "single"),
        ]
    key_folder = hand_service_key(env)
    try:
        process = await asyncio.create_subprocess_exec(
            *cli(), *args, *common, env=env, cwd=str(cwd),
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
    index = out / "index.html"
    key = None
    if index.is_file() and code == 0:
        if root is not None:
            key = str(uuid.uuid4())
            root.save(key, state)
        # The location wins: it is the state a desktop push updates; the key is only a copy taken now.
        link = location or key
        if link is not None:
            index.write_text(stamp_state_key(index.read_text(encoding="utf-8"), link), encoding="utf-8")
    yield SystemMessage(
        subtype=SUMMARY_SUBTYPE, data={"summary": summary, "state_key": key, "state_location": location, "exit_code": code}
    )
    yield result_message(summary, code)


class _PassThrough(Exception):
    """This query goes to the caller's own agent after all."""


def result_message(summary: dict[str, Any], code: int) -> ResultMessage:
    """The whole Page Studio run as one SDK result: summed usage, per-model usage and the run's cost."""
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
        origin={"kind": "marshal-page-studio"},
    )


async def query(options: ClaudeAgentOptions, fallback: Any) -> AsyncIterator[Message]:
    """Page Studio's answer to the query, or the caller's own agent when an edit has no Marshal state."""
    try:
        async for message in run(options):
            yield message
    except _PassThrough:
        async for message in fallback():
            yield message


__all__ = ["change_request", "page_state_key", "query", "routes", "stamp_state_key"]
