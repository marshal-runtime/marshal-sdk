"""Runs packages/providers/src/backend/antigravity/bridge.py against the real Antigravity harness with a scripted
fake Vertex endpoint (no model is called).

Needs a Python with google-antigravity installed (Marshal's venv: ~/.marshal/antigravity/venv/bin/python):

  <python> -m unittest discover -s test/antigravity -p '*_test.py'
"""

import asyncio
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
  from google.antigravity import models as agy_models
except ImportError:  # pragma: no cover
  agy_models = None

BRIDGE = pathlib.Path(__file__).resolve().parents[2] / "packages/providers/src/backend/antigravity/bridge.py"
COMPACTION_PROMPT = "working on the task described above"


def _load_bridge():
  sys.dont_write_bytecode = True  # no __pycache__ inside the vendored provider tree
  spec = importlib.util.spec_from_file_location("antigravity_bridge_under_test", BRIDGE)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


class FakeVertex:
  """Answers generateContent requests from a script of model turns; compaction requests get a summary."""

  def __init__(self, turns: list[list[dict]], huge_prompt_on: set[int]):
    self.turns = turns
    self.huge_prompt_on = huge_prompt_on
    self.requests: list[dict] = []
    fake = self

    class Handler(BaseHTTPRequestHandler):

      def log_message(self, *args):
        pass

      def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        fake.requests.append(request)
        prompt_tokens = 1
        if COMPACTION_PROMPT in json.dumps(request["contents"][-1]):
          parts = [{"text": "Summary: the user asked to go."}]
        else:
          turn = sum(COMPACTION_PROMPT not in json.dumps(r["contents"][-1]) for r in fake.requests) - 1
          parts = fake.turns[turn] if turn < len(fake.turns) else [{"text": "done"}]
          if turn in fake.huge_prompt_on:
            prompt_tokens = 900_000  # makes the harness compact before the next request
        body = {
            "candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": prompt_tokens, "candidatesTokenCount": 1, "totalTokenCount": 2},
        }
        stream = "stream" in self.path
        data = (f"data: {json.dumps(body)}\r\n\r\n" if stream else json.dumps(body)).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream" if stream else "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
    threading.Thread(target=self.server.serve_forever, daemon=True).start()

  def close(self):
    self.server.shutdown()


def run_command(command: str, wait_ms: int, cwd: str) -> dict:
  return {
      "functionCall": {"name": "run_command", "args": {"CommandLine": command, "Cwd": cwd, "WaitMsBeforeAsync": wait_ms}},
      "thoughtSignature": "c2ln",
  }


@unittest.skipIf(agy_models is None, "google-antigravity is not installed")
class BackgroundTaskAfterCompactionTest(unittest.TestCase):

  def setUp(self):
    self.work = tempfile.mkdtemp(prefix="agy-bridge-test-")
    self.bridge = _load_bridge()
    self.events: list[dict] = []

    async def emit(event):
      self.events.append(event)

    async def ask_host(session, kind, payload):
      return {"allow": True} if kind == "pre_tool" else {"text": ""}

    self.bridge.emit = emit
    self.bridge.ask_host = ask_host

  def tearDown(self):
    shutil.rmtree(self.work, ignore_errors=True)

  def _session(self, fake: FakeVertex, model: str):
    session = self.bridge.BridgeSession(
        "s1",
        {
            "conversationId": uuid.uuid4().hex,
            "saveDir": os.path.join(self.work, "save"),
            "appDataDir": os.path.join(self.work, "app"),
            "workspaces": [self.work],
            "model": model,
            "system": {"mode": "replace", "text": "You are Marshal's test agent."},
        },
    )
    session._endpoint = lambda: agy_models.VertexEndpoint(base_url=fake.url)
    return session

  def _run(self, model: str) -> FakeVertex:
    # The model starts a background command, the conversation is compacted, and the command finishes while the
    # model's next command runs: the harness announces it with a system message right after that command's result.
    fake = FakeVertex(
        turns=[
            [run_command("sleep 2; echo first", 300, self.work)],
            [run_command("sleep 4; echo second", 10_000, self.work)],
            [{"text": "done"}],
        ],
        huge_prompt_on={0},
    )
    self.addCleanup(fake.close)

    async def scenario():
      session = self._session(fake, model)
      await session.open()
      try:
        await session.run_turn("t1", "go", [])
      finally:
        await session.close()

    asyncio.run(asyncio.wait_for(scenario(), timeout=120))
    return fake

  def _assert_turn_survives(self, fake: FakeVertex):
    errors = [event for event in self.events if event.get("ev") == "turn_error"]
    self.assertEqual(errors, [], "the turn failed")
    self.assertTrue(any(event.get("ev") == "turn_end" and event.get("turn") == "t1" for event in self.events))
    after_message = [
        request for request in fake.requests
        if "SYSTEM_MESSAGE" in json.dumps(request["contents"]) and COMPACTION_PROMPT not in json.dumps(request["contents"][-1])
    ]
    self.assertTrue(after_message, "the background task's message never reached the model")
    contents = json.dumps(after_message[-1]["contents"])
    self.assertIn("echo second", contents, "the request after the message lost the model's own last call")
    self.assertIn("Resuming from a compaction", contents, "the request after the message lost the compaction summary")
    system = after_message[-1]["systemInstruction"]["parts"][0]["text"]
    self.assertIn("You are Marshal's test agent.", system)
    self.assertNotIn("You are Antigravity", system, "Google's default prompt leaked into a replace-mode prompt")

  def test_gemini_4_neon(self):
    self._assert_turn_survives(self._run("gemini-4-neon"))

  def test_default_model(self):
    # A model whose default prompt has a section neon's lacks ("guidelines").
    self._assert_turn_survives(self._run(agy_models.DEFAULT_MODEL))


@unittest.skipIf(agy_models is None, "google-antigravity is not installed")
class SwallowedHarnessErrorTest(unittest.TestCase):
  """The SDK only logs a harness error that arrives as a step; the bridge must still fail (and recover) the turn."""

  def test_turn_ending_on_a_system_error_step_is_a_failure(self):
    from google.antigravity import types  # pylint: disable=import-outside-toplevel

    bridge = _load_bridge()
    session = bridge.BridgeSession("s1", {"conversationId": "c1"})
    error = 'agent executor error: template override title \\"guidelines\\" has not been included in the system instructions'
    steps = [
        types.Step(source=types.StepSource.MODEL, status=types.StepStatus.DONE),
        types.Step(source=types.StepSource.SYSTEM, status=types.StepStatus.ERROR, error=error),
    ]

    class Agent:
      conversation = type("Conversation", (), {"history": steps})()

    session.agent = Agent()
    self.assertEqual(session._system_error_since(0), error)
    self.assertIsNone(session._system_error_since(2), "an error from an earlier turn")
    steps.append(types.Step(source=types.StepSource.MODEL, status=types.StepStatus.DONE))
    self.assertIsNone(session._system_error_since(0), "the turn went on after the error")
    self.assertEqual(bridge.ABSENT_SECTION_ERROR.search(error).group(1), "guidelines")


if __name__ == "__main__":
  unittest.main()
