import assert from "node:assert/strict";
import { test } from "node:test";

import { globRegExp } from "../src/gcs";

test("** in a REST glob matches any number of folders, * stays inside one", () => {
  const re = globRegExp("gs://b/runs/**/agent/marshal-state/*.json");
  assert.ok(re.test("gs://b/runs/agent/marshal-state/run.json"));
  assert.ok(re.test("gs://b/runs/one/agent/marshal-state/run.json"));
  // Published pages sit two folders down (published/<run>/); a one-level ** hid them from every cloud list.
  assert.ok(re.test("gs://b/runs/published/page-abc/agent/marshal-state/run.json"));
  assert.ok(!re.test("gs://b/runs/one/agent/marshal-state/state/sessions/index.json"));
});
