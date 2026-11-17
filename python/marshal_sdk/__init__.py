"""The Claude Agent SDK on a Marshal host: the same API, one import changed.

    from claude_agent_sdk import query, ClaudeAgentOptions   # before
    from marshal_sdk import query, ClaudeAgentOptions        # after

Everything claude_agent_sdk exports is re-exported unchanged (the same classes, so code that still imports types from
claude_agent_sdk keeps working). ``query`` and ``ClaudeSDKClient`` run the agent through ``marshal-claude`` (the
marshal-sdk npm package), which starts a Marshal host around the Claude Code CLI the SDK would have run: the agent gets
Marshal's runtime tools and the run is recorded as a Marshal session, while hooks, subagents, permission callbacks and
in-process MCP tools work as before.

Environment:
    MARSHAL_CLAUDE        path of the marshal-claude executable (default: ``marshal-claude`` on PATH)
    MARSHAL_SDK_OFF=1     run on plain claude_agent_sdk (no Marshal host), for an A/B or a rollback
    MARSHAL_SDK_KIT       host kit parts: brain, memory, sessions (comma separated)
    MARSHAL_SDK_STATE     where the host keeps its sessions (default: a temp folder per run)
"""

from __future__ import annotations

import dataclasses
import os
import shutil
from collections.abc import AsyncIterable, AsyncIterator
from pathlib import Path
from typing import Any

import claude_agent_sdk as _sdk
from claude_agent_sdk import *  # noqa: F403  (the drop-in re-exports the SDK's whole API)
from claude_agent_sdk import ClaudeAgentOptions, Message
from claude_agent_sdk import ClaudeSDKClient as _ClaudeSDKClient
from claude_agent_sdk._internal.transport import Transport

__all__ = list(_sdk.__all__)

BRIDGE_ENV_VAR = "MARSHAL_CLAUDE"
BRIDGE_NAME = "marshal-claude"
REAL_CLI_ENV_VAR = "MARSHAL_SDK_CLAUDE_CLI"
OFF_ENV_VAR = "MARSHAL_SDK_OFF"


class MarshalNotInstalledError(RuntimeError):
    """marshal-claude is not on PATH and MARSHAL_CLAUDE does not name it."""


def _bridge() -> str:
    found = os.environ.get(BRIDGE_ENV_VAR) or shutil.which(BRIDGE_NAME)
    if not found:
        raise MarshalNotInstalledError(
            f"{BRIDGE_NAME} was not found: install the marshal-sdk npm package (npm i -g <marshal-sdk tarball>) "
            f"or set {BRIDGE_ENV_VAR} to its path."
        )
    return found


def _claude_cli(options: ClaudeAgentOptions) -> str:
    """The Claude Code CLI the SDK would run: the caller's cli_path, else the one claude_agent_sdk bundles."""
    if options.cli_path is not None:
        return str(options.cli_path)
    bundled = Path(_sdk.__file__).parent / "_bundled" / "claude"
    if bundled.is_file():
        return str(bundled)
    on_path = shutil.which("claude")
    if on_path:
        return on_path
    raise MarshalNotInstalledError("No Claude Code CLI: claude_agent_sdk has no bundled CLI and claude is not on PATH.")


def on_marshal(options: ClaudeAgentOptions | None) -> ClaudeAgentOptions:
    """The same options, run through marshal-claude (unchanged when MARSHAL_SDK_OFF=1)."""
    options = options or ClaudeAgentOptions()
    if os.environ.get(OFF_ENV_VAR) == "1":
        return options
    return dataclasses.replace(
        options, cli_path=_bridge(), env={**options.env, REAL_CLI_ENV_VAR: _claude_cli(options)}
    )


async def query(
    *,
    prompt: str | AsyncIterable[dict[str, Any]],
    options: ClaudeAgentOptions | None = None,
    transport: Transport | None = None,
) -> AsyncIterator[Message]:
    """claude_agent_sdk.query on a Marshal host."""
    async for message in _sdk.query(prompt=prompt, options=on_marshal(options), transport=transport):
        yield message


class ClaudeSDKClient(_ClaudeSDKClient):
    """claude_agent_sdk.ClaudeSDKClient on a Marshal host."""

    def __init__(self, options: ClaudeAgentOptions | None = None, transport: Transport | None = None) -> None:
        super().__init__(options=on_marshal(options), transport=transport)
