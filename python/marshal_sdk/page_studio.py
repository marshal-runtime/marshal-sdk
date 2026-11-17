"""Page builds on the Page Studio extension: an agent-sandbox page-agent query, answered by ``marshal-sdk page-run``.

With ``MARSHAL_SDK_ENGINE=page-studio`` a query whose working folder is an agent-sandbox page-agent workspace
(``input/page/brief.json`` and ``input/products/``) does not start the caller's own agent. The page is built (or, when
``input/page/base-page/index.html`` exists, edited) by Page Studio on a headless Marshal host, on Marshal's own system
prompt and Page Studio's own skills, critic and copy. The caller's system prompt, skills, subagents and in-process MCP
servers are not used on this path; any other query runs through marshal-claude as before.

The run contract is the one the caller's agent would have met: ``out/index.html`` (+ ``out/assets/``, ``out/shots/``,
``out/notes.md``). The query yields a ``SystemMessage`` per host log line and one ``ResultMessage`` carrying the run's
whole usage and cost, so the caller's run log and summary work unchanged.

Environment:
    MARSHAL_SDK_ENGINE=page-studio     route page-agent workspaces to Page Studio (default: the caller's own agent)
    MARSHAL_SDK_CLI                     the marshal-sdk CLI (default: next to marshal-claude, else ``marshal-sdk`` on PATH)
    MARSHAL_SDK_PAGE_STUDIO             Page Studio's package folder (read by marshal-sdk)
    MARSHAL_SDK_PAGE_DEPTH              quick | single | deep (default single)
    MARSHAL_SDK_PAGE_STATE_ROOT         where each page's Marshal state is kept between a build and its edits: a folder or
                                        gs://bucket/prefix. Unset: a page can't be found again, so its edits run the
                                        caller's own agent.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, Message, ResultMessage, SystemMessage

ENGINE_ENV_VAR = "MARSHAL_SDK_ENGINE"
ENGINE_PAGE_STUDIO = "page-studio"
CLI_ENV_VAR = "MARSHAL_SDK_CLI"
DEPTH_ENV_VAR = "MARSHAL_SDK_PAGE_DEPTH"
STATE_ROOT_ENV_VAR = "MARSHAL_SDK_PAGE_STATE_ROOT"
KIT_ENV_VAR = "MARSHAL_SDK_KIT"
# Page Studio's scripted backend (no model): the dry path, for tests.
FAKE_ENV_VAR = "MARSHAL_SDK_PAGE_FAKE"
# The host, not the agent's tools, calls the Decisions API that routes Page Studio's edits; the caller's agent env
# blanks this key for its tools, so the host takes it from the process.
HOST_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
STATE_META = "marshal-page-state"
RUN_DIRNAME = "marshal-page-studio"
LOG_PREFIX = "[marshal-sdk page-"
PROGRESS_SUBTYPE = "marshal_page_studio"
SUMMARY_SUBTYPE = "marshal_page_studio_summary"
CHANGE_REQUEST_MARKER = "Change request:"


def routes(options: ClaudeAgentOptions | None) -> bool:
    """Whether this query is a page-agent build that Page Studio answers."""
    if os.environ.get(ENGINE_ENV_VAR) != ENGINE_PAGE_STUDIO or options is None or options.cwd is None:
        return False
    input_dir = Path(options.cwd) / "input"
    return (input_dir / "page" / "brief.json").is_file() and (input_dir / "products").is_dir()


def base_page(cwd: Path) -> Path | None:
    page = cwd / "input" / "page" / "base-page" / "index.html"
    return page if page.is_file() else None


def page_state_key(html: str) -> str | None:
    found = re.search(rf'<meta\s+name="{STATE_META}"\s+content="([A-Za-z0-9-]+)"', html)
    return found.group(1) if found else None


def stamp_state_key(html: str, key: str) -> str:
    """The page with its state key in a meta tag (replacing an older one), so an edit of it finds its Marshal state."""
    meta = f'<meta name="{STATE_META}" content="{key}">'
    html = re.sub(rf'<meta\s+name="{STATE_META}"\s+content="[^"]*">\s*', "", html)
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
            source = Path(self._root) / key
            if not source.is_dir():
                return False
            shutil.copytree(source, state, symlinks=True, dirs_exist_ok=True)
            return True
        bucket, prefix = self._bucket()
        found = False
        for blob in bucket.list_blobs(prefix=f"{prefix}{key}/"):
            target = state / blob.name[len(f"{prefix}{key}/") :]
            target.parent.mkdir(parents=True, exist_ok=True)
            blob.download_to_filename(str(target))
            found = True
        return found

    def _bucket(self) -> tuple[Any, str]:
        from google.cloud import storage  # the sandbox has it; only gs:// roots need it

        bucket, _, prefix = self._root[len("gs://") :].partition("/")
        return storage.Client().bucket(bucket), f"{prefix}/" if prefix else ""


def cli(bridge: str | None) -> list[str]:
    found = os.environ.get(CLI_ENV_VAR)
    if not found and bridge:
        sibling = Path(bridge).resolve().parent / "cli.js"
        found = str(sibling) if sibling.is_file() else None
    found = found or shutil.which("marshal-sdk")
    if not found:
        raise RuntimeError(f"No marshal-sdk CLI: set {CLI_ENV_VAR} or install the marshal-sdk npm package.")
    return ["node", found] if found.endswith(".js") else [found]


def host_env(options: ClaudeAgentOptions) -> dict[str, str]:
    env = {**os.environ, **{key: str(value) for key, value in (options.env or {}).items()}}
    for key in HOST_KEYS:
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


async def run(options: ClaudeAgentOptions, bridge: str | None) -> AsyncIterator[Message]:
    """One page build or edit by Page Studio, as the caller's query would have made it."""
    cwd = Path(str(options.cwd)).resolve()
    run_dir = cwd.parent / RUN_DIRNAME
    logs, state, out = run_dir / "logs", run_dir / "state", cwd / "out"
    logs.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True)
    root = StateRoot(os.environ[STATE_ROOT_ENV_VAR]) if os.environ.get(STATE_ROOT_ENV_VAR) else None
    common = [
        *(["--model", options.model] if options.model else []),
        *(["--effort", str(options.effort)] if options.effort else []),
        *(["--kit", os.environ[KIT_ENV_VAR]] if os.environ.get(KIT_ENV_VAR) else []),
        *(["--fake"] if os.environ.get(FAKE_ENV_VAR) == "1" else []),
        "--host-id", "agent-sandbox",
    ]
    edited = base_page(cwd)
    if edited is not None:
        key = page_state_key(edited.read_text(encoding="utf-8"))
        if root is None or key is None or not root.load(key, state):
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
    process = await asyncio.create_subprocess_exec(
        *cli(bridge), *args, *common, env=host_env(options), cwd=str(cwd),
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
    summary_file = logs / "summary.json"
    summary: dict[str, Any] = json.loads(summary_file.read_text(encoding="utf-8")) if summary_file.is_file() else {}
    index = out / "index.html"
    key = None
    if root is not None and index.is_file() and code == 0:
        key = str(uuid.uuid4())
        root.save(key, state)
        index.write_text(stamp_state_key(index.read_text(encoding="utf-8"), key), encoding="utf-8")
    yield SystemMessage(subtype=SUMMARY_SUBTYPE, data={"summary": summary, "state_key": key, "exit_code": code})
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


async def query(options: ClaudeAgentOptions, bridge: str | None, fallback: Any) -> AsyncIterator[Message]:
    """Page Studio's answer to the query, or the caller's own agent when an edit has no Marshal state."""
    try:
        async for message in run(options, bridge):
            yield message
    except _PassThrough:
        async for message in fallback():
            yield message


__all__ = ["change_request", "page_state_key", "query", "routes", "stamp_state_key"]
