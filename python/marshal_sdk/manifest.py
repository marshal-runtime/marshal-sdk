"""The caller's marshal-sdk.json: which extensions its Marshal host loads, their configuration, the Brain and the model.

    marshal_sdk.init("marshal-sdk.json")   # once at the service's start; raises MarshalInitError naming what is missing

``init`` resolves the manifest with the marshal-sdk CLI (``marshal-sdk check``): pinned packages are downloaded and
checked against their sha256, ``${env:NAME}`` settings are read from the environment, every extension's declared
dependencies and required settings are checked, a host is started with exactly those extensions, and the Brain is
asked one question. The report says what loaded and from where. A second call with the same file is free.

Without ``init``, the manifest is found at the first query: $MARSHAL_SDK_MANIFEST, else marshal-sdk.json in the
process's working folder, else beside the agent's working folder.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions

from marshal_sdk import _node

MANIFEST_FILE = "marshal-sdk.json"
MANIFEST_ENV_VAR = "MARSHAL_SDK_MANIFEST"
PAGE_STUDIO = "@zyg/page-studio"
CHECK_TIMEOUT_S = 600
LOG = logging.getLogger("marshal_sdk")

_state: dict[str, Any] = {"manifest": None, "reports": {}}


class MarshalInitError(RuntimeError):
    """The manifest cannot start a Marshal host; ``problems`` lists every reason, one per line."""

    def __init__(self, problems: list[str], report: dict[str, Any] | None = None) -> None:
        self.problems = problems
        self.report = report or {}
        super().__init__("Marshal cannot start:\n" + "\n".join(f"  - {problem}" for problem in problems))


def find(options: ClaudeAgentOptions | None = None) -> Path | None:
    """The manifest in force: the one init() loaded, $MARSHAL_SDK_MANIFEST, ./marshal-sdk.json, else beside the agent's cwd."""
    if _state["manifest"] is not None:
        return Path(_state["manifest"])
    given = os.environ.get(MANIFEST_ENV_VAR)
    if given:
        return Path(given).resolve()
    candidates = [Path.cwd() / MANIFEST_FILE]
    if options is not None and options.cwd is not None:
        candidates += [Path(str(options.cwd)) / MANIFEST_FILE, Path(str(options.cwd)).parent / MANIFEST_FILE]
    return next((candidate.resolve() for candidate in candidates if candidate.is_file()), None)


def init(manifest: str | os.PathLike[str] | None = None, *, ping_brain: bool = True, person: str | None = None) -> dict[str, Any]:
    """Load and prove the manifest once; returns the report (extensions with their source, Brain, model).

    Raises MarshalInitError with every missing setting, environment variable, extension or Brain access by name.
    """
    path = Path(manifest).resolve() if manifest is not None else find()
    if path is None or not path.is_file():
        raise MarshalInitError([f"No {MANIFEST_FILE}: pass its path to marshal_sdk.init() or set {MANIFEST_ENV_VAR}."])
    report = check(path, ping_brain=ping_brain, person=person)
    _state["manifest"] = str(path)
    return report


def check(path: Path, *, ping_brain: bool, person: str | None = None) -> dict[str, Any]:
    """`marshal-sdk check` for this file, cached per file version: raises MarshalInitError when it cannot start a host."""
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size, ping_brain, person or "")
    cached = _state["reports"].get(key)
    if cached is not None:
        return cached
    # Imported here: page_studio imports this module for find().
    from marshal_sdk.page_studio import cli

    command = [*cli(), "check", "--manifest", str(path), *(["--person", person] if person else []), *([] if ping_brain else ["--no-brain-ping"])]
    env = {**os.environ, **_node.tool_env()}
    done = subprocess.run(command, env=env, cwd=str(path.parent), capture_output=True, text=True, timeout=CHECK_TIMEOUT_S, check=False)
    try:
        report: dict[str, Any] = json.loads(done.stdout)
    except ValueError:
        tail = (done.stderr or done.stdout or "").strip().splitlines()[-5:]
        raise MarshalInitError([f"marshal-sdk check exited with {done.returncode} and no report: {' | '.join(tail)}"]) from None
    if done.returncode != 0 or not report.get("ok"):
        raise MarshalInitError([str(problem) for problem in report.get("problems") or ["marshal-sdk check failed"]], report)
    # What the host runs without (a service Brain sign-in with no person): said once per file version.
    for warning in report.get("warnings") or []:
        LOG.warning("marshal-sdk: %s", warning)
    _state["reports"][key] = report
    return report


def lists(path: Path, identity: str) -> bool:
    """Whether the manifest loads this extension: from its checked report, so path, archive and url entries count too."""
    stat = path.stat()
    version = (str(path), stat.st_mtime_ns, stat.st_size)
    report = next((value for key, value in _state["reports"].items() if key[:3] == version), None)
    if report is None:
        report = check(path, ping_brain=False)
    return any(extension.get("identity") == identity for extension in report.get("extensions") or [])


def reset() -> None:
    """Forget init() and the cached reports (tests)."""
    _state["manifest"] = None
    _state["reports"].clear()


__all__ = ["MANIFEST_ENV_VAR", "MANIFEST_FILE", "MarshalInitError", "check", "find", "init", "lists", "reset"]
