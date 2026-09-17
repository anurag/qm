import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";

const request: TurnRequest = {
  surface: "slack",
  liveActor: true,
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef: "zero-workers" },
  text: "Build a website",
  async: true,
};

test("WORKERS=0 queues runs for another instance's workers instead of claiming them", async () => {
  const built = buildApp(testConfig({ workers: 0 }));
  built.runtime.start();
  try {
    const queued = await built.app.turn(request);
    assert.equal(queued.status, "queued");
    await assert.rejects(built.runs.waitFor(queued.runId!, 300), /did not finish/);
    assert.equal((await built.app.getRun(queued.runId!))?.status, "pending");
  } finally {
    await built.runtime.stop();
  }
});

test("a single worker claims the same queued run", async () => {
  const built = buildApp(testConfig({ workers: 1 }));
  built.runtime.start();
  try {
    const queued = await built.app.turn(request);
    assert.equal((await built.runs.waitFor(queued.runId!, 5000)).status, "done");
  } finally {
    await built.runtime.stop();
  }
});
