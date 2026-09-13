import { test } from "node:test";
import assert from "node:assert/strict";
import type { Render } from "@renderinc/sdk";
import { createRenderWorkflowWorker, type RenderWorkflowDispatch } from "../src/render/workflow-worker.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

function fixture() {
  const { runs } = createMemoryRunStore();
  const store = createMemoryMap<RenderWorkflowDispatch>();
  const lock = createMemoryAdvisoryLock();
  const inputs: unknown[][] = [];
  const failures: unknown[] = [];
  let fail = false;
  const client = {
    async startTask(task: string, input: unknown[]) {
      inputs.push([task, ...input]);
      if (fail) throw new Error("connection closed after submission");
      return { taskRunId: `trn-${inputs.length}` };
    },
    async getTaskRun() {
      return { status: "pending" };
    },
  } as unknown as Pick<Render["workflows"], "startTask" | "getTaskRun">;
  const create = () =>
    createRenderWorkflowWorker({
      apiKey: "test",
      task: "tsk-version-one",
      runs,
      store,
      lock,
      canClaim: () => true,
      client,
      onError: (error) => failures.push(error),
    });
  const enqueue = async (sessionId: string) =>
    (
      await runs.enqueue({
        sessionId,
        request: {
          actor: { id: "test@example.com", type: "internal" },
          conversation: { kind: "dm", threadRef: sessionId, audience: [] },
          text: "private task text",
          origin: { kind: "direct" },
        },
      })
    ).run;
  return {
    runs,
    store,
    inputs,
    failures,
    create,
    enqueue,
    fail: () => {
      fail = true;
    },
  };
}

test("Workflow dispatch survives a core restart and sends only the durable run ID", async () => {
  const f = fixture();
  const run = await f.enqueue("one");
  const worker = f.create();
  worker.start();
  await worker.sweep();
  await worker.stop();
  const replacement = f.create();
  replacement.start();
  await replacement.sweep();
  await replacement.stop();
  assert.deepEqual(f.inputs, [["tsk-version-one", run.id]]);
  assert.equal((await f.runs.get(run.id))?.status, "pending");
});

test("Concurrent cores submit one workflow per queued run", async () => {
  const f = fixture();
  await f.enqueue("one");
  const a = f.create();
  const b = f.create();
  a.start();
  b.start();
  await Promise.all([a.sweep(), b.sweep()]);
  await Promise.all([a.stop(), b.stop()]);
  assert.equal(f.inputs.length, 1);
});

test("An uncertain submission is retained without a duplicate request", async () => {
  const f = fixture();
  const run = await f.enqueue("one");
  f.fail();
  const worker = f.create();
  worker.start();
  await worker.sweep();
  await worker.sweep();
  await worker.stop();
  assert.equal(f.inputs.length, 1);
  assert.equal(f.failures.length, 1);
  assert.equal((await f.store.get(run.id))?.state, "submitting");
});

test("A timed-out submission can be retried and repeated failures park the QM run", async () => {
  const f = fixture();
  const run = await f.enqueue("one");
  const worker = f.create();
  await f.store.put(run.id, { state: "submitting", attempts: 1, at: Date.now() - 60_000 });
  worker.start();
  await worker.sweep();
  assert.equal(f.inputs.length, 1);
  assert.equal((await f.store.get(run.id))?.state, "submitted");
  await f.store.put(run.id, { state: "submitting", attempts: 3, at: Date.now() - 60_000 });
  await worker.sweep();
  await worker.stop();
  assert.equal((await f.runs.get(run.id))?.status, "failed");
  assert.equal(f.inputs.length, 1);
});

test("A blocked session does not block another session and running sessions are not dispatched", async () => {
  const f = fixture();
  const blocked = await f.enqueue("blocked");
  await f.store.put(blocked.id, { state: "submitting", attempts: 1, at: Date.now() });
  const active = await f.enqueue("active");
  await f.runs.claimById(active.id, "worker", 60_000);
  await f.enqueue("active");
  const ready = await f.enqueue("ready");
  const worker = f.create();
  worker.start();
  await worker.sweep();
  await worker.stop();
  assert.deepEqual(f.inputs, [["tsk-version-one", ready.id]]);
});
