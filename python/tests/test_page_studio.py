"""marshal_sdk's Page Studio route: which queries it takes, the page's state key, the edit request, and a dry build."""

import asyncio
import base64
import json
import os
from pathlib import Path

import shutil

import pytest
from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, SystemMessage

from marshal_sdk import manifest, page_studio

PACKAGE_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def no_manifest(monkeypatch):
    """Each test starts with no manifest in force, unless it writes one."""
    manifest.reset()
    monkeypatch.delenv(manifest.MANIFEST_ENV_VAR, raising=False)
    monkeypatch.delenv(page_studio.BRAIN_CALLER_ENV_VAR, raising=False)
    yield
    manifest.reset()


def checked(monkeypatch, identities: list[str], seen: list | None = None):
    """manifest.check standing in for `marshal-sdk check`: a report listing these extensions."""

    def fake_check(path, *, ping_brain, person=None):
        if seen is not None:
            seen.append((str(path), ping_brain))
        return {"ok": True, "manifest": str(path), "extensions": [{"identity": identity} for identity in identities], "problems": []}

    monkeypatch.setattr(manifest, "check", fake_check)


def workspace(tmp_path: Path) -> Path:
    cwd = tmp_path / "page-agent"
    (cwd / "input" / "page").mkdir(parents=True)
    (cwd / "input" / "products" / "1").mkdir(parents=True)
    (cwd / "input" / "page" / "brief.json").write_text("{}")
    return cwd


def test_page_studio_answers_only_when_the_manifest_lists_it_and_claude_opts_out(tmp_path, monkeypatch):
    cwd = workspace(tmp_path)
    monkeypatch.delenv(page_studio.ENGINE_ENV_VAR, raising=False)
    options = ClaudeAgentOptions(cwd=str(cwd))
    # A page request with no manifest runs the caller's own agent, and says why.
    assert page_studio.page_request(options) and not page_studio.routes(options)
    assert "no marshal-sdk.json" in page_studio.not_routed_notice(options).data["notice"]
    declared = tmp_path / "marshal-sdk.json"
    declared.write_text('{"version": 1, "extensions": []}')
    checked(monkeypatch, ["@marshal/brain"])
    assert not page_studio.routes(options)
    assert "does not list @zyg/page-studio" in page_studio.not_routed_notice(options).data["notice"]
    checked(monkeypatch, ["@marshal/brain", "@zyg/page-studio"])
    assert page_studio.routes(options)
    monkeypatch.setenv(page_studio.ENGINE_ENV_VAR, "claude")
    assert not page_studio.routes(options)
    monkeypatch.setenv(page_studio.ENGINE_ENV_VAR, "page-studio")
    assert not page_studio.routes(ClaudeAgentOptions(cwd=str(tmp_path)))
    assert not page_studio.routes(ClaudeAgentOptions())


def test_init_proves_the_manifest_once_and_names_every_problem(tmp_path, monkeypatch):
    import subprocess

    declared = tmp_path / "marshal-sdk.json"
    declared.write_text('{"version": 1, "extensions": []}')
    calls: list = []
    answer = {"ok": True, "extensions": [{"identity": "@zyg/page-studio", "source": "url"}], "problems": []}

    def fake_run(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0 if answer["ok"] else 1, stdout=json.dumps(answer), stderr="")

    monkeypatch.setattr(manifest.subprocess, "run", fake_run)
    monkeypatch.setenv(page_studio.CLI_ENV_VAR, "/x/cli.js")
    import marshal_sdk

    report = marshal_sdk.init(declared)
    assert report["extensions"][0]["identity"] == "@zyg/page-studio"
    assert calls[0][-3:] == ["check", "--manifest", str(declared.resolve())]
    assert marshal_sdk.init(declared) is report and len(calls) == 1
    assert manifest.find() == declared.resolve()
    # Routing reads the checked report: no second check.
    assert manifest.lists(declared.resolve(), manifest.PAGE_STUDIO) and len(calls) == 1

    manifest.reset()
    answer.update(ok=False, problems=["@zyg/page-studio@0.2.0 needs the extension @marshal/brain", "environment variable OPENAI_API_KEY is not set"])
    with pytest.raises(marshal_sdk.MarshalInitError) as raised:
        marshal_sdk.init(declared)
    assert raised.value.problems == answer["problems"] and "OPENAI_API_KEY" in str(raised.value)
    with pytest.raises(marshal_sdk.MarshalInitError, match="No marshal-sdk.json"):
        marshal_sdk.init(tmp_path / "missing.json")


def test_the_person_is_the_options_user_email_never_an_os_user(monkeypatch):
    import marshal_sdk

    assert page_studio.person(ClaudeAgentOptions(user="Omer.Machluf@Zyg.com")) == "omer.machluf@zyg.com"
    assert page_studio.person(ClaudeAgentOptions(user="www-data")) is None
    monkeypatch.setenv(page_studio.BRAIN_CALLER_ENV_VAR, "bar@zyg.com")
    assert page_studio.person(ClaudeAgentOptions()) == "bar@zyg.com"
    monkeypatch.delenv(page_studio.BRAIN_CALLER_ENV_VAR)
    monkeypatch.setenv(marshal_sdk.BRIDGE_ENV_VAR, "/x/marshal-claude")
    monkeypatch.setattr(marshal_sdk, "_claude_cli", lambda _options: "/x/claude")
    # claude_agent_sdk spawns its CLI as the OS user `user` names: an email goes to the Brain, not to the spawn.
    spawned = marshal_sdk.on_marshal(ClaudeAgentOptions(user="omer@zyg.com"))
    assert spawned.user is None and spawned.env[page_studio.BRAIN_CALLER_ENV_VAR] == "omer@zyg.com"
    assert marshal_sdk.on_marshal(ClaudeAgentOptions(user="www-data")).user == "www-data"
    monkeypatch.setenv(marshal_sdk.OFF_ENV_VAR, "1")
    assert marshal_sdk.on_marshal(ClaudeAgentOptions(user="omer@zyg.com")).user is None


def test_state_key_is_stamped_once_and_read_back():
    html = "<!doctype html><html><head><title>x</title></head><body></body></html>"
    once = page_studio.stamp_state_key(html, "a1")
    twice = page_studio.stamp_state_key(once, "b2")
    assert page_studio.page_state_key(once) == "a1"
    assert page_studio.page_state_key(twice) == "b2"
    assert twice.count("marshal-page-state") == 1
    assert page_studio.page_state_key(html) is None
    located = page_studio.stamp_state_key(twice, "gs://b/page-generation-runs/7/output/agent/marshal-state")
    assert page_studio.page_state_key(located) == "gs://b/page-generation-runs/7/output/agent/marshal-state"
    assert page_studio.is_location(page_studio.page_state_key(located)) and not page_studio.is_location("b2")
    assert located.count("marshal-page-state") == 1


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


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def sandbox_pack(root: Path) -> Path:
    """A page-agent input folder the way agent-sandbox writes it, cut down to what a run reads."""
    files: dict[str, str | bytes] = {
        "README.md": "# Input: Acme / Night Balm\n",
        "brand/brand.json": json.dumps({"brand_id": 7, "name": "Acme", "existing_website": "https://www.acme.example"}),
        "page/brief.json": json.dumps(
            {"brand_id": "7", "product_id": "321", "brand_name": "Acme", "product_name": "NIGHT BALM", "positioning": {"brief_markdown": "## Positioning\n\nSleep better."}}
        ),
        "page/operator-request.md": "A page for tired parents.\n",
        "products/321/product.json": json.dumps({"core": {"product_id": 321, "name": "NIGHT BALM", "product_handle": "night-balm"}}),
        "products/321/offers.json": json.dumps({"domain": "acme.example", "offers": [{"price": 30}]}),
        "products/321/facts.md": "- F1 (input): Night Balm costs $30.\n",
        "products/321/pictures.json": json.dumps([{"key": "A01", "file": "pictures/jar.png", "description": "The jar on a white table.", "scope": "product"}]),
        "products/321/pictures/jar.png": PNG,
    }
    for name, body in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body) if isinstance(body, bytes) else target.write_text(body)
    return root


@pytest.mark.skipif(
    not (PACKAGE_ROOT / "dist" / "src" / "cli.js").is_file() or not os.environ.get("MARSHAL_SDK_PAGE_STUDIO"),
    reason="needs a built marshal-sdk and MARSHAL_SDK_PAGE_STUDIO",
)
def test_dry_build_then_edit_through_query(tmp_path, monkeypatch):
    """A page-agent query builds a page on Page Studio's scripted backend, then an edit of it finds its state."""
    import marshal_sdk

    # A real agent-sandbox input pack when given, else the cut-down one test/page-run.test.ts builds.
    given = os.environ.get("MARSHAL_SDK_TEST_PACK")
    pack = Path(given) if given else sandbox_pack(tmp_path / "pack")
    if not pack.is_dir():
        pytest.skip(f"MARSHAL_SDK_TEST_PACK={given} is not a folder")

    monkeypatch.setenv(page_studio.FAKE_ENV_VAR, "1")
    monkeypatch.setenv(page_studio.STATE_ROOT_ENV_VAR, str(tmp_path / "states"))
    monkeypatch.setenv(page_studio.CLI_ENV_VAR, str(PACKAGE_ROOT / "dist" / "src" / "cli.js"))
    # The host is what the manifest declares: Page Studio and the Brain it depends on (no Brain call on the dry path).
    brain = os.environ.get("MARSHAL_SDK_BRAIN_PACKAGE")
    if not brain:
        pytest.skip("needs MARSHAL_SDK_BRAIN_PACKAGE (Page Studio depends on @marshal/brain)")
    declared = tmp_path / "marshal-sdk.json"
    declared.write_text(json.dumps({"version": 1, "defaults": False, "extensions": [{"path": os.environ["MARSHAL_SDK_PAGE_STUDIO"]}, {"path": brain}]}))
    monkeypatch.setenv(manifest.MANIFEST_ENV_VAR, str(declared))
    monkeypatch.delenv("MARSHAL_SDK_PAGE_STUDIO")

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


def test_output_root_comes_from_the_template_and_the_briefs_run(tmp_path, monkeypatch):
    cwd = workspace(tmp_path)
    monkeypatch.delenv(page_studio.OUTPUT_ROOT_ENV_VAR, raising=False)
    monkeypatch.delenv(page_studio.SANDBOX_BUCKET_ENV_VAR, raising=False)
    assert page_studio.run_label(cwd) is None and page_studio.output_root(cwd) is None
    (cwd / "input" / "page" / "brief.json").write_text(json.dumps({"source": {"kind": "page_run", "page_generation_run_id": 900101}}))
    assert page_studio.run_label(cwd) == "900101"
    # agent-sandbox's own layout: its GCS_BUCKET, else its default bucket.
    assert page_studio.output_root(cwd) == "gs://zyg-ecom-prod-shops-artifacts/page-generation-runs/900101/output"
    monkeypatch.setenv(page_studio.SANDBOX_BUCKET_ENV_VAR, "shop-builder-local-runs")
    assert page_studio.output_root(cwd) == "gs://shop-builder-local-runs/page-generation-runs/900101/output"
    monkeypatch.setenv(page_studio.OUTPUT_ROOT_ENV_VAR, "gs://b/page-generation-runs/{run}/output/")
    assert page_studio.output_root(cwd) == "gs://b/page-generation-runs/900101/output"


def test_state_sits_in_the_callers_logs_folder_and_page_run_is_told_where_it_is_uploaded(tmp_path, monkeypatch):
    """agent-sandbox uploads page-agent-logs/ to <root>/agent/, so the state must be there and named for the sessions."""
    cwd = workspace(tmp_path)
    (cwd / "input" / "page" / "brief.json").write_text(json.dumps({"source": {"page_generation_run_id": 900102}}))
    (tmp_path / page_studio.CALLER_LOGS_DIRNAME).mkdir()
    monkeypatch.setenv(page_studio.OUTPUT_ROOT_ENV_VAR, "gs://b/page-generation-runs/{run}/output")
    monkeypatch.delenv(page_studio.POINTER_PREFIX_ENV_VAR, raising=False)
    seen: dict = {}

    async def fake_exec(*args, env, cwd, **_kwargs):
        seen["args"], seen["env"] = list(args), env

        class Process:
            stdout = asyncio.StreamReader()
            stderr = asyncio.StreamReader()

            async def wait(self):
                return 1

        process = Process()
        process.stdout.feed_eof()
        process.stderr.feed_eof()
        return process

    monkeypatch.setattr(page_studio.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setenv(page_studio.CLI_ENV_VAR, "/x/cli.js")

    async def run() -> list:
        return [m async for m in page_studio.run(ClaudeAgentOptions(cwd=str(cwd)))]

    messages = asyncio.run(run())
    state = seen["args"][seen["args"].index("--state") + 1]
    assert state == str((tmp_path / page_studio.CALLER_LOGS_DIRNAME / "marshal-state").resolve())
    assert seen["env"][page_studio.STATE_LOCATION_ENV_VAR] == "gs://b/page-generation-runs/900102/output/agent/marshal-state"
    assert isinstance(messages[-1], ResultMessage) and messages[-1].is_error


def fake_cli(monkeypatch, seen: dict, page: str | None = None):
    """create_subprocess_exec standing in for marshal-sdk: records the call and writes out/index.html when asked."""

    async def fake_exec(*args, env, cwd, **_kwargs):
        seen.setdefault("calls", []).append({"args": list(args), "env": env})
        if page is not None:
            out = Path(args[list(args).index("--out") + 1])
            out.mkdir(parents=True, exist_ok=True)
            (out / "index.html").write_text(page)

        class Process:
            stdout = asyncio.StreamReader()
            stderr = asyncio.StreamReader()

            async def wait(self):
                return 0

        process = Process()
        process.stdout.feed_eof()
        process.stderr.feed_eof()
        return process

    monkeypatch.setattr(page_studio.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setenv(page_studio.CLI_ENV_VAR, "/x/cli.js")


def test_a_build_stamps_where_its_state_is_uploaded_and_an_edit_loads_that_state(tmp_path, monkeypatch):
    """The page names <root>/agent/marshal-state; an edit reads the state there (what a desktop push updates)."""
    monkeypatch.delenv(page_studio.STATE_ROOT_ENV_VAR, raising=False)
    uploaded = tmp_path / "bucket" / "page-generation-runs"
    monkeypatch.setenv(page_studio.OUTPUT_ROOT_ENV_VAR, str(uploaded) + "/{run}/output")
    seen: dict = {}
    fake_cli(monkeypatch, seen, page="<html><head></head><body>v1</body></html>")
    build = tmp_path / "build"
    cwd = workspace(build)
    (cwd / "input" / "page" / "brief.json").write_text(json.dumps({"source": {"page_generation_run_id": 900201}}))
    (build / page_studio.CALLER_LOGS_DIRNAME).mkdir()
    messages = asyncio.run(_collect(page_studio.run(ClaudeAgentOptions(cwd=str(cwd)))))
    assert not messages[-1].is_error
    location = str(uploaded / "900201" / "output" / "agent" / "marshal-state")
    page = (cwd / "out" / "index.html").read_text()
    assert page_studio.page_state_key(page) == location
    assert seen["calls"][0]["args"][2] == "page-run"

    # agent-sandbox uploads page-agent-logs/ to <root>/agent/; a desktop push then updates the page record there.
    shutil.copytree(build / page_studio.CALLER_LOGS_DIRNAME, uploaded / "900201" / "output" / "agent")
    pages = Path(location) / "page-studio" / "pages"
    pages.mkdir(parents=True)
    (pages / "p.json").write_text('{"version": 2}')

    edit = tmp_path / "edit"
    cwd = workspace(edit)
    (cwd / "input" / "page" / "brief.json").write_text(json.dumps({"source": {"page_generation_run_id": 900202}}))
    (cwd / "input" / "page" / "base-page").mkdir()
    (cwd / "input" / "page" / "base-page" / "index.html").write_text(page)
    (cwd / "input" / "page" / "operator-request.md").write_text("Change request: bluer buttons")
    (edit / page_studio.CALLER_LOGS_DIRNAME).mkdir()
    messages = asyncio.run(_collect(page_studio.run(ClaudeAgentOptions(cwd=str(cwd)))))
    assert not messages[-1].is_error
    call = seen["calls"][1]["args"]
    assert call[2] == "page-edit"
    state = Path(call[call.index("--state") + 1])
    assert json.loads((state / "page-studio" / "pages" / "p.json").read_text())["version"] == 2
    assert page_studio.page_state_key((cwd / "out" / "index.html").read_text()) == str(
        uploaded / "900202" / "output" / "agent" / "marshal-state"
    )


def test_an_edit_whose_page_names_no_state_runs_the_callers_agent(tmp_path, monkeypatch):
    monkeypatch.delenv(page_studio.STATE_ROOT_ENV_VAR, raising=False)
    seen: dict = {}
    fake_cli(monkeypatch, seen)
    cwd = workspace(tmp_path)
    (cwd / "input" / "page" / "base-page").mkdir()
    (cwd / "input" / "page" / "base-page" / "index.html").write_text("<html><head></head></html>")

    async def own_agent():
        yield SystemMessage(subtype="own", data={})

    messages = asyncio.run(_collect(page_studio.query(ClaudeAgentOptions(cwd=str(cwd)), own_agent)))
    assert [m.subtype for m in messages][-1] == "own"
    assert "calls" not in seen


def test_the_kit_is_the_manifests_unless_the_environment_names_one(monkeypatch):
    monkeypatch.delenv(page_studio.KIT_ENV_VAR, raising=False)
    assert page_studio.kit() is None
    monkeypatch.setenv(page_studio.KIT_ENV_VAR, "brain,memory")
    assert page_studio.kit() == "brain,memory"
    monkeypatch.setenv(page_studio.KIT_ENV_VAR, "none")
    assert page_studio.kit() is None


def test_a_build_names_its_manifest_and_person_to_page_run(tmp_path, monkeypatch):
    seen: dict = {}
    fake_cli(monkeypatch, seen, page="<html><head></head><body>v1</body></html>")
    cwd = workspace(tmp_path)
    declared = tmp_path / "marshal-sdk.json"
    declared.write_text('{"version": 1, "extensions": []}')
    asyncio.run(_collect(page_studio.run(ClaudeAgentOptions(cwd=str(cwd), user="Omer@zyg.com"))))
    args = seen["calls"][0]["args"]
    assert args[args.index("--manifest") + 1] == str(declared.resolve())
    assert args[args.index("--person") + 1] == "omer@zyg.com"
    assert "--kit" not in args


async def _collect(stream) -> list:
    return [message async for message in stream]


def test_the_run_pointer_defaults_to_the_explicit_sandbox_bucket_only(monkeypatch):
    monkeypatch.delenv(page_studio.POINTER_PREFIX_ENV_VAR, raising=False)
    monkeypatch.delenv(page_studio.SANDBOX_BUCKET_ENV_VAR, raising=False)
    assert page_studio.pointer_prefix() == ""
    monkeypatch.setenv(page_studio.SANDBOX_BUCKET_ENV_VAR, "shop-builder-local-runs")
    assert page_studio.pointer_prefix() == "gs://shop-builder-local-runs/marshal-sdk-cloud-runs"
    monkeypatch.setenv(page_studio.POINTER_PREFIX_ENV_VAR, "gs://x/y/")
    assert page_studio.pointer_prefix() == "gs://x/y"
