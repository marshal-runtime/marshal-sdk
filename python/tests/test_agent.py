"""marshal_sdk's agent route: which agent a query runs, the run's state and its link, and real runs of two agents."""

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, SystemMessage

from marshal_sdk import agent, manifest

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = PACKAGE_ROOT / "test" / "fixtures" / "agents"
CLI = PACKAGE_ROOT / "dist" / "src" / "cli.js"
PAGES = {
    "ref": "@fixture/pages:page",
    "kind": "capability",
    "capability": "pages.agent.run",
    "runId": {"file": "input/page/brief.json", "field": "source.page_generation_run_id"},
    "resume": {"file": "input/page/base-page/index.html", "meta": "marshal-page-state"},
    "ports": [],
}
HELLO = {"ref": "@fixture/hello:hello", "kind": "capability", "capability": "hello.agent.run", "ports": []}


@pytest.fixture(autouse=True)
def no_manifest(monkeypatch):
    """Each test starts with no manifest or agent in force, unless it sets one."""
    manifest.reset()
    for name in (manifest.MANIFEST_ENV_VAR, agent.BRAIN_CALLER_ENV_VAR, agent.AGENT_ENV_VAR, agent.FAKE_ENV_VAR, agent.STATE_ROOT_ENV_VAR):
        monkeypatch.delenv(name, raising=False)
    yield
    manifest.reset()


def checked(monkeypatch, chosen: dict | None, seen: list | None = None):
    """manifest.check standing in for `marshal-sdk check`: a report declaring both fixture agents."""

    def fake_check(path, *, ping_brain, person=None):
        if seen is not None:
            seen.append((str(path), ping_brain))
        return {"ok": True, "manifest": str(path), "extensions": [], "agents": [HELLO, PAGES], **({"agent": chosen} if chosen else {}), "problems": []}

    monkeypatch.setattr(manifest, "check", fake_check)


def workspace(tmp_path: Path, run: int | None = None) -> Path:
    """agent-sandbox's layout: <root>/page-agent (the cwd) beside <root>/page-agent-logs."""
    cwd = tmp_path / "page-agent"
    (cwd / "input" / "page").mkdir(parents=True)
    brief = {"product_name": "NIGHT BALM", **({"source": {"page_generation_run_id": run}} if run is not None else {})}
    (cwd / "input" / "page" / "brief.json").write_text(json.dumps(brief))
    return cwd


def test_the_query_runs_the_agent_the_call_env_init_or_manifest_names_in_that_order(tmp_path, monkeypatch):
    options = ClaudeAgentOptions(cwd=str(workspace(tmp_path)))
    assert agent.chosen(options) is None, "no manifest: the caller's own agent"
    (tmp_path / "marshal-sdk.json").write_text('{"version": 1, "extensions": []}')
    checked(monkeypatch, None)
    assert agent.chosen(options) is None, "a manifest naming no agent: the caller's own agent"
    checked(monkeypatch, PAGES)
    assert agent.chosen(options)["ref"] == "@fixture/pages:page"
    monkeypatch.setenv(agent.AGENT_ENV_VAR, "@fixture/hello")
    assert agent.chosen(options)["ref"] == "@fixture/hello:hello"
    assert agent.chosen(ClaudeAgentOptions(cwd=options.cwd, extra_args={"marshal-agent": "@fixture/pages"}))["ref"] == "@fixture/pages:page"
    assert agent.chosen(ClaudeAgentOptions(cwd=options.cwd, extra_args={"marshal-agent": "none"})) is None
    with pytest.raises(manifest.MarshalInitError, match="declares no agent @fixture/gone"):
        agent.chosen(ClaudeAgentOptions(cwd=options.cwd, extra_args={"marshal-agent": "@fixture/gone"}))


def test_init_proves_the_manifest_and_its_agent_once_and_names_every_problem(tmp_path, monkeypatch, caplog):
    declared = tmp_path / "marshal-sdk.json"
    declared.write_text('{"version": 1, "extensions": []}')
    calls: list = []
    answer = {"ok": True, "extensions": [{"identity": "@fixture/pages", "source": "path"}], "agents": [PAGES], "agent": PAGES, "problems": []}

    def fake_run(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0 if answer["ok"] else 1, stdout=json.dumps(answer), stderr="")

    monkeypatch.setattr(manifest.subprocess, "run", fake_run)
    monkeypatch.setenv(agent.CLI_ENV_VAR, "/x/cli.js")
    import marshal_sdk

    report = marshal_sdk.init(declared)
    assert report["agent"]["ref"] == "@fixture/pages:page"
    assert calls[0][-3:] == ["check", "--manifest", str(declared.resolve())]
    assert marshal_sdk.init(declared) is report and len(calls) == 1
    assert manifest.find() == declared.resolve()
    # Routing reads the checked report: no second check.
    assert agent.chosen(ClaudeAgentOptions())["ref"] == "@fixture/pages:page" and len(calls) == 1

    manifest.reset()
    marshal_sdk.init(declared, agent="@fixture/hello")
    assert calls[-1][calls[-1].index("--agent") + 1] == "@fixture/hello"

    manifest.reset()
    answer.update(warnings=["the Brain signs in as the service (service-key) and this run names no person"])
    with caplog.at_level("WARNING", logger="marshal_sdk"):
        assert marshal_sdk.init(declared)["ok"]
    assert [record.getMessage() for record in caplog.records] == ["marshal-sdk: the Brain signs in as the service (service-key) and this run names no person"]

    manifest.reset()
    answer.update(ok=False, problems=["The agent @fixture/gone is not on this host", "environment variable OPENAI_API_KEY is not set"])
    with pytest.raises(marshal_sdk.MarshalInitError) as raised:
        marshal_sdk.init(declared, agent="@fixture/gone")
    assert raised.value.problems == answer["problems"] and "OPENAI_API_KEY" in str(raised.value)
    with pytest.raises(marshal_sdk.MarshalInitError, match="No marshal-sdk.json"):
        marshal_sdk.init(tmp_path / "missing.json")


def test_the_person_is_the_options_user_email_never_an_os_user_and_marshal_agent_is_no_cli_flag(monkeypatch):
    import marshal_sdk

    assert agent.person(ClaudeAgentOptions(user="Omer.Machluf@Zyg.com")) == "omer.machluf@zyg.com"
    assert agent.person(ClaudeAgentOptions(user="www-data")) is None
    monkeypatch.setenv(agent.BRAIN_CALLER_ENV_VAR, "bar@zyg.com")
    assert agent.person(ClaudeAgentOptions()) == "bar@zyg.com"
    monkeypatch.delenv(agent.BRAIN_CALLER_ENV_VAR)
    monkeypatch.setenv(marshal_sdk.BRIDGE_ENV_VAR, "/x/marshal-claude")
    monkeypatch.setattr(marshal_sdk, "_claude_cli", lambda _options: "/x/claude")
    spawned = marshal_sdk.on_marshal(ClaudeAgentOptions(user="omer@zyg.com", extra_args={"marshal-agent": "none", "debug-to-stderr": None}))
    assert spawned.user is None and spawned.env[agent.BRAIN_CALLER_ENV_VAR] == "omer@zyg.com"
    assert spawned.extra_args == {"debug-to-stderr": None}
    assert marshal_sdk.on_marshal(ClaudeAgentOptions(user="www-data")).user == "www-data"
    monkeypatch.setenv(marshal_sdk.OFF_ENV_VAR, "1")
    off = marshal_sdk.on_marshal(ClaudeAgentOptions(user="omer@zyg.com", extra_args={"marshal-agent": "none"}))
    assert off.user is None and off.extra_args == {}


def test_the_host_gets_the_service_key_the_caller_blanked_for_its_tools_as_a_private_file(monkeypatch):
    key = '{"type": "service_account", "client_email": "e2b-production@zyg-ecom-prod.iam.gserviceaccount.com"}'
    monkeypatch.setenv(agent.SERVICE_KEY_JSON_ENV_VAR, key)
    monkeypatch.delenv(agent.SERVICE_KEY_PATH_ENV_VAR, raising=False)
    blanked = {"ANTHROPIC_API_KEY": "", agent.SERVICE_KEY_JSON_ENV_VAR: "", agent.SERVICE_KEY_PATH_ENV_VAR: ""}
    env = agent.host_env(ClaudeAgentOptions(env=blanked))
    folder = agent.hand_service_key(env)
    try:
        assert folder is not None
        handed = Path(env[agent.SERVICE_KEY_FILE_ENV_VAR])
        assert handed.parent == folder and handed.read_text(encoding="utf-8") == key
        assert handed.stat().st_mode & 0o777 == 0o600
        assert env[agent.SERVICE_KEY_JSON_ENV_VAR] == "" and env[agent.SERVICE_KEY_PATH_ENV_VAR] == ""
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    kept = agent.host_env(ClaudeAgentOptions())
    assert agent.hand_service_key(kept) is None and agent.SERVICE_KEY_FILE_ENV_VAR not in kept


def test_result_message_sums_usage_and_cost():
    message = agent.result_message(
        {
            "results": [
                {"usage": {"input_tokens": 2, "output_tokens": 5, "service_tier": "x"}, "model_usage": {"opus": {"outputTokens": 5, "costUSD": 1.5}}, "total_cost_usd": 1.5},
                {"usage": {"input_tokens": 3, "output_tokens": 1}, "model_usage": {"opus": {"outputTokens": 1, "costUSD": 0.5}}, "total_cost_usd": 0.5},
            ],
            "totals": {"num_turns": 7, "total_cost_usd": 2.0, "duration_ms": 10},
            "marshal": {"runId": "r1", "reply": "done"},
        },
        0,
        "@fixture/pages:page",
    )
    assert isinstance(message, ResultMessage)
    assert message.usage == {"input_tokens": 5, "output_tokens": 6}
    assert message.model_usage == {"opus": {"outputTokens": 6, "costUSD": 2.0}}
    assert (message.total_cost_usd, message.num_turns, message.is_error, message.session_id, message.result) == (2.0, 7, False, "r1", "done")
    assert agent.result_message({"error": "boom"}, 1, "@fixture/pages:page").is_error


def test_the_run_id_is_where_the_agent_says_and_the_output_root_comes_from_the_template(tmp_path, monkeypatch):
    cwd = workspace(tmp_path)
    monkeypatch.delenv(agent.OUTPUT_ROOT_ENV_VAR, raising=False)
    monkeypatch.delenv(agent.SANDBOX_BUCKET_ENV_VAR, raising=False)
    assert agent.run_label(cwd, PAGES) is None and agent.output_root(None) is None
    (cwd / "input" / "page" / "brief.json").write_text(json.dumps({"source": {"kind": "page_run", "page_generation_run_id": 900101}}))
    assert agent.run_label(cwd, PAGES) == "900101"
    assert agent.run_label(cwd, HELLO) is None, "an agent that declares no runId has none"
    assert agent.output_root("900101") == "gs://zyg-ecom-prod-shops-artifacts/page-generation-runs/900101/output"
    monkeypatch.setenv(agent.SANDBOX_BUCKET_ENV_VAR, "shop-builder-local-runs")
    assert agent.output_root("900101") == "gs://shop-builder-local-runs/page-generation-runs/900101/output"
    monkeypatch.setenv(agent.OUTPUT_ROOT_ENV_VAR, "gs://b/page-generation-runs/{run}/output/")
    assert agent.output_root("900101") == "gs://b/page-generation-runs/900101/output"


def fake_cli(monkeypatch, seen: dict, code: int = 0):
    """create_subprocess_exec standing in for marshal-sdk agent-run: records the call."""

    async def fake_exec(*args, env, cwd, **_kwargs):
        seen.setdefault("calls", []).append({"args": list(args), "env": env})

        class Process:
            stdout = asyncio.StreamReader()
            stderr = asyncio.StreamReader()

            async def wait(self):
                return code

        process = Process()
        process.stdout.feed_eof()
        process.stderr.feed_eof()
        return process

    monkeypatch.setattr(agent.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setenv(agent.CLI_ENV_VAR, "/x/cli.js")


async def _collect(stream) -> list:
    return [message async for message in stream]


def test_state_sits_in_the_callers_logs_folder_and_agent_run_is_told_where_it_is_uploaded(tmp_path, monkeypatch):
    """agent-sandbox uploads page-agent-logs/ to <root>/agent/, so the state must be there and named for the sessions."""
    cwd = workspace(tmp_path, run=900102)
    (tmp_path / "page-agent-logs").mkdir()
    monkeypatch.setenv(agent.OUTPUT_ROOT_ENV_VAR, "gs://b/page-generation-runs/{run}/output")
    monkeypatch.delenv(agent.POINTER_PREFIX_ENV_VAR, raising=False)
    monkeypatch.delenv(agent.SANDBOX_BUCKET_ENV_VAR, raising=False)
    seen: dict = {}
    fake_cli(monkeypatch, seen, code=1)
    messages = asyncio.run(_collect(agent.run(ClaudeAgentOptions(cwd=str(cwd), user="Omer@zyg.com", model="m"), PAGES, "build the page")))
    args = seen["calls"][0]["args"]
    assert args[2:5] == ["agent-run", "--agent", "@fixture/pages:page"]
    value = lambda flag: args[args.index(flag) + 1]
    assert value("--state") == str((tmp_path / "page-agent-logs" / "marshal-state").resolve())
    assert value("--state-location") == "gs://b/page-generation-runs/900102/output/agent/marshal-state"
    assert value("--state-link") == value("--state-location")
    assert value("--run-label") == "900102"
    assert value("--person") == "omer@zyg.com" and value("--model") == "m"
    assert Path(value("--prompt")[1:]).read_text() == "build the page"
    assert "--resumed" not in args and "--kit" not in args
    assert isinstance(messages[-1], ResultMessage) and messages[-1].is_error


def test_a_run_that_continues_an_earlier_one_loads_its_state_and_one_whose_state_is_gone_runs_the_callers_agent(tmp_path, monkeypatch):
    earlier = tmp_path / "bucket" / "900201" / "agent" / "marshal-state"
    (earlier / "host").mkdir(parents=True)
    (earlier / "pages.json").write_text('{"pages": 1}')
    seen: dict = {}
    fake_cli(monkeypatch, seen)
    cwd = workspace(tmp_path / "edit", run=900202)
    (cwd.parent / "page-agent-logs").mkdir()
    (cwd / "input" / "page" / "base-page").mkdir()
    (cwd / "input" / "page" / "base-page" / "index.html").write_text(f'<html><head><meta name="marshal-page-state" content="{earlier}"></head></html>')
    messages = asyncio.run(_collect(agent.run(ClaudeAgentOptions(cwd=str(cwd)), PAGES, "make the buttons blue")))
    assert not messages[-1].is_error
    args = seen["calls"][0]["args"]
    assert "--resumed" in args
    state = Path(args[args.index("--state") + 1])
    assert json.loads((state / "pages.json").read_text()) == {"pages": 1}

    gone = workspace(tmp_path / "gone", run=900203)
    (gone / "input" / "page" / "base-page").mkdir()
    (gone / "input" / "page" / "base-page" / "index.html").write_text("<html><head></head></html>")

    async def own_agent():
        yield SystemMessage(subtype="own", data={})

    messages = asyncio.run(_collect(agent.query(ClaudeAgentOptions(cwd=str(gone)), PAGES, "x", own_agent)))
    assert [m.subtype for m in messages][-1] == "own"
    assert len(seen["calls"]) == 1


def test_the_kit_is_the_manifests_unless_the_environment_names_one(monkeypatch):
    monkeypatch.delenv(agent.KIT_ENV_VAR, raising=False)
    assert agent.kit() is None
    monkeypatch.setenv(agent.KIT_ENV_VAR, "brain,memory")
    assert agent.kit() == "brain,memory"
    monkeypatch.setenv(agent.KIT_ENV_VAR, "none")
    assert agent.kit() is None


def test_the_run_pointer_defaults_to_the_explicit_sandbox_bucket_only(monkeypatch):
    monkeypatch.delenv(agent.POINTER_PREFIX_ENV_VAR, raising=False)
    monkeypatch.delenv(agent.SANDBOX_BUCKET_ENV_VAR, raising=False)
    assert agent.pointer_prefix() == ""
    monkeypatch.setenv(agent.SANDBOX_BUCKET_ENV_VAR, "shop-builder-local-runs")
    assert agent.pointer_prefix() == "gs://shop-builder-local-runs/marshal-sdk-cloud-runs"
    monkeypatch.setenv(agent.POINTER_PREFIX_ENV_VAR, "gs://x/y/")
    assert agent.pointer_prefix() == "gs://x/y"


@pytest.mark.skipif(not CLI.is_file(), reason="needs a built marshal-sdk (node build.mjs)")
def test_changing_only_the_manifests_agent_switches_what_the_same_query_runs(tmp_path, monkeypatch):
    """The same caller code and query, run twice on the real CLI: hello, then (one manifest field later) the page agent."""
    import marshal_sdk

    monkeypatch.setenv(agent.CLI_ENV_VAR, str(CLI))
    monkeypatch.setenv(agent.FAKE_ENV_VAR, "1")
    monkeypatch.setenv(agent.STATE_ROOT_ENV_VAR, str(tmp_path / "states"))
    declared = tmp_path / "marshal-sdk.json"

    def run(agent_ref: str, folder: str) -> tuple[Path, list]:
        declared.write_text(json.dumps({"version": 1, "defaults": False, "agent": agent_ref, "extensions": [{"path": str(FIXTURES / "hello")}, {"path": str(FIXTURES / "pages")}]}))
        manifest.reset()
        marshal_sdk.init(declared, ping_brain=False)
        cwd = workspace(tmp_path / folder, run=900301)

        async def go() -> list:
            return [m async for m in marshal_sdk.query(prompt="the brief", options=ClaudeAgentOptions(cwd=str(cwd)))]

        return cwd, asyncio.run(go())

    cwd, messages = run("@fixture/hello", "first")
    assert isinstance(messages[-1], ResultMessage) and not messages[-1].is_error, messages[-1]
    assert messages[-1].result == "said hello" and messages[-1].origin == {"kind": "marshal-agent", "agent": "@fixture/hello:hello"}
    assert (cwd / "out" / "hello.txt").read_text() == "hello from @fixture/hello: the brief\n"
    assert not (cwd / "out" / "index.html").exists()
    assert any(isinstance(m, SystemMessage) and "wrote out/hello.txt" in str(m.data.get("line", "")) for m in messages)

    cwd, messages = run("@fixture/pages", "second")
    assert not messages[-1].is_error, messages[-1]
    page = (cwd / "out" / "index.html").read_text()
    assert "<h1>NIGHT BALM</h1>" in page and not (cwd / "out" / "hello.txt").exists()
    summary = next(m for m in messages if isinstance(m, SystemMessage) and m.subtype == agent.SUMMARY_SUBTYPE)
    key = summary.data["state_key"]
    assert f'content="{key}"' in page and (tmp_path / "states" / key / "pages.json").is_file()
    assert summary.data["summary"]["marshal"]["runLabel"] == "900301"
