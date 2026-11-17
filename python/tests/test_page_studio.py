"""marshal_sdk's Page Studio route: which queries it takes, the page's state key, the edit request, and a dry build."""

import asyncio
import json
import os
from pathlib import Path

import pytest
from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, SystemMessage

from marshal_sdk import page_studio

PACKAGE_ROOT = Path(__file__).resolve().parents[2]


def workspace(tmp_path: Path) -> Path:
    cwd = tmp_path / "page-agent"
    (cwd / "input" / "page").mkdir(parents=True)
    (cwd / "input" / "products" / "1").mkdir(parents=True)
    (cwd / "input" / "page" / "brief.json").write_text("{}")
    return cwd


def test_routes_only_page_agent_workspaces_under_the_engine(tmp_path, monkeypatch):
    cwd = workspace(tmp_path)
    monkeypatch.delenv(page_studio.ENGINE_ENV_VAR, raising=False)
    assert not page_studio.routes(ClaudeAgentOptions(cwd=str(cwd)))
    monkeypatch.setenv(page_studio.ENGINE_ENV_VAR, "page-studio")
    assert page_studio.routes(ClaudeAgentOptions(cwd=str(cwd)))
    assert not page_studio.routes(ClaudeAgentOptions(cwd=str(tmp_path)))
    assert not page_studio.routes(ClaudeAgentOptions())


def test_state_key_is_stamped_once_and_read_back():
    html = "<!doctype html><html><head><title>x</title></head><body></body></html>"
    once = page_studio.stamp_state_key(html, "a1")
    twice = page_studio.stamp_state_key(once, "b2")
    assert page_studio.page_state_key(once) == "a1"
    assert page_studio.page_state_key(twice) == "b2"
    assert twice.count("marshal-page-state") == 1
    assert page_studio.page_state_key(html) is None


def test_change_request_is_the_last_block():
    text = "Make the best page.\n\nChange request: old ask\n\nMore context.\nChange request: first line\nChange request: second line\n"
    assert page_studio.change_request(text) == "first line\nsecond line"
    assert page_studio.change_request("Just a request.") == "Just a request."


def test_result_message_sums_usage_and_cost():
    message = page_studio.result_message(
        {
            "results": [
                {"usage": {"input_tokens": 2, "output_tokens": 5, "service_tier": "x"}, "model_usage": {"opus": {"outputTokens": 5, "costUSD": 1.5}}, "total_cost_usd": 1.5},
                {"usage": {"input_tokens": 3, "output_tokens": 1}, "model_usage": {"opus": {"outputTokens": 1, "costUSD": 0.5}}, "total_cost_usd": 0.5},
            ],
            "totals": {"num_turns": 7, "total_cost_usd": 2.0, "duration_ms": 10},
            "marshal": {"runId": "r1", "reply": "done"},
        },
        0,
    )
    assert isinstance(message, ResultMessage)
    assert message.usage == {"input_tokens": 5, "output_tokens": 6}
    assert message.model_usage == {"opus": {"outputTokens": 6, "costUSD": 2.0}}
    assert (message.total_cost_usd, message.num_turns, message.is_error, message.session_id) == (2.0, 7, False, "r1")
    assert page_studio.result_message({"error": "boom"}, 1).is_error


@pytest.mark.skipif(
    not (PACKAGE_ROOT / "dist" / "src" / "cli.js").is_file() or not os.environ.get("MARSHAL_SDK_PAGE_STUDIO"),
    reason="needs a built marshal-sdk and MARSHAL_SDK_PAGE_STUDIO",
)
def test_dry_build_then_edit_through_query(tmp_path, monkeypatch):
    """A page-agent query builds a page on Page Studio's scripted backend, then an edit of it finds its state."""
    import marshal_sdk

    pack = Path(os.environ.get("MARSHAL_SDK_TEST_PACK", ""))
    if not pack.is_dir():
        pytest.skip("MARSHAL_SDK_TEST_PACK names no agent-sandbox input pack")
    import shutil

    monkeypatch.setenv(page_studio.ENGINE_ENV_VAR, "page-studio")
    monkeypatch.setenv(page_studio.FAKE_ENV_VAR, "1")
    monkeypatch.setenv(page_studio.STATE_ROOT_ENV_VAR, str(tmp_path / "states"))
    monkeypatch.setenv(page_studio.CLI_ENV_VAR, str(PACKAGE_ROOT / "dist" / "src" / "cli.js"))

    async def run(cwd: Path) -> list:
        return [m async for m in marshal_sdk.query(prompt="build", options=ClaudeAgentOptions(cwd=str(cwd)))]

    built = tmp_path / "build" / "page-agent"
    shutil.copytree(pack, built / "input")
    messages = asyncio.run(run(built))
    assert isinstance(messages[-1], ResultMessage) and not messages[-1].is_error
    page = (built / "out" / "index.html").read_text()
    key = page_studio.page_state_key(page)
    assert key and (tmp_path / "states" / key).is_dir()

    edit = tmp_path / "edit" / "page-agent"
    shutil.copytree(pack, edit / "input")
    (edit / "input" / "page" / "base-page").mkdir()
    (edit / "input" / "page" / "base-page" / "index.html").write_text(page)
    (edit / "input" / "page" / "operator-request.md").write_text("Build it.\n\nChange request: make the buttons blue")
    messages = asyncio.run(run(edit))
    assert not messages[-1].is_error
    summary = next(m for m in messages if isinstance(m, SystemMessage) and m.subtype == page_studio.SUMMARY_SUBTYPE)
    assert summary.data["summary"]["marshal"]["job"] == "edit"
    assert json.loads((edit.parent / page_studio.RUN_DIRNAME / "logs" / "summary.json").read_text())["marshal"]["request"] == "make the buttons blue"
    assert page_studio.page_state_key((edit / "out" / "index.html").read_text()) not in (None, key)
