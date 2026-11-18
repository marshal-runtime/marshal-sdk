"""The Claude Agent SDK on a Marshal host: the same API, one import changed.

    from claude_agent_sdk import query, ClaudeAgentOptions   # before
    from marshal_sdk import query, ClaudeAgentOptions        # after

Everything claude_agent_sdk exports is re-exported unchanged (the same classes, so code that still imports types from
claude_agent_sdk keeps working). ``query`` and ``ClaudeSDKClient`` run the agent through ``marshal-claude`` (the
marshal-sdk npm package), which starts a Marshal host around the Claude Code CLI the SDK would have run: the agent gets
Marshal's runtime tools and the run is recorded as a Marshal session, while hooks, subagents, permission callbacks and
in-process MCP tools work as before.

Nothing else needs installing: Node comes from the nodejs-wheel-binaries dependency, and the marshal-sdk npm package
(with the Page Studio extension and the Brain inside) ships in this package and is installed when its wheel is built
(see _node.py).

Environment:
    MARSHAL_CLAUDE        path of a marshal-claude executable (default: the one this package carries, else on PATH)
    MARSHAL_SDK_OFF=1     run on plain claude_agent_sdk (no Marshal host), for an A/B or a rollback
    MARSHAL_SDK_KIT       host kit parts: brain, memory, sessions (comma separated)
    MARSHAL_SDK_STATE     where the host keeps its sessions (default: a temp folder per run)
    MARSHAL_SDK_ENGINE    page-studio (default): page-agent builds and edits run on the Page Studio extension
                          (see page_studio.py); claude: they run the caller's own agent
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

from marshal_sdk import _node, page_studio

__all__ = list(_sdk.__all__)

BRIDGE_ENV_VAR = "MARSHAL_CLAUDE"
BRIDGE_NAME = "marshal-claude"
REAL_CLI_ENV_VAR = "MARSHAL_SDK_CLAUDE_CLI"
OFF_ENV_VAR = "MARSHAL_SDK_OFF"


MarshalNotInstalledError = _node.MarshalNotInstalledError


def _bridge() -> str:
    """marshal-claude: $MARSHAL_CLAUDE, the one this package carries, else one on PATH."""
    given = os.environ.get(BRIDGE_ENV_VAR)
    if given:
        return given
    try:
        return _node.bridge()
    except _node.MarshalNotInstalledError:
        on_path = shutil.which(BRIDGE_NAME)
        if on_path:
            return on_path
        raise


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
        options, cli_path=_bridge(), env={**_node.tool_env(), **options.env, REAL_CLI_ENV_VAR: _claude_cli(options)}
    )


async def query(
    *,
    prompt: str | AsyncIterable[dict[str, Any]],
    options: ClaudeAgentOptions | None = None,
    transport: Transport | None = None,
) -> AsyncIterator[Message]:
    """claude_agent_sdk.query on a Marshal host; a page-agent build or edit goes to Page Studio."""

    def own_agent() -> AsyncIterator[Message]:
        return _sdk.query(prompt=prompt, options=on_marshal(options), transport=transport)

    if transport is None and os.environ.get(OFF_ENV_VAR) != "1" and page_studio.routes(options):
        assert options is not None
        async for message in page_studio.query(options, own_agent):
            yield message
        return
    async for message in own_agent():
        yield message


class ClaudeSDKClient(_ClaudeSDKClient):
    """claude_agent_sdk.ClaudeSDKClient on a Marshal host."""

    def __init__(self, options: ClaudeAgentOptions | None = None, transport: Transport | None = None) -> None:
        super().__init__(options=on_marshal(options), transport=transport)
