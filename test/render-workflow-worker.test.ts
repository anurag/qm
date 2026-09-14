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
  const readiness = new Map<string, boolean>();
  let canClaim = true;
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
      canClaim: () => canClaim,
      isReady: async (runId) => readiness.get(runId) ?? true,
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
    client,
    readiness,
    drain: () => {
      canClaim = false;
    },
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

test("A run must be ready before a Workflow task starts", async () => {
  const f = fixture();
  const run = await f.enqueue("one");
  f.readiness.set(run.id, false);
  const worker = f.create();
  worker.start();
  await worker.sweep();
  assert.equal(f.inputs.length, 0);
  assert.equal(await f.store.get(run.id), null);
  f.readiness.set(run.id, true);
  await worker.sweep();
  await worker.stop();
  assert.equal(f.inputs.length, 1);
});

for (const status of ["completed", "succeeded"]) {
  test(`Tasks that report ${status} without a QM claim exhaust the dispatch budget`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const f = fixture();
    const run = await f.enqueue("one");
    t.mock.method(f.client, "getTaskRun", async () => ({ status }));
    for (let attempt = 0; attempt < 4; attempt++) {
      const worker = f.create();
      worker.start();
      await worker.sweep();
      await worker.stop();
      t.mock.timers.tick(30_000);
    }
    assert.equal(f.inputs.length, 3);
    assert.equal((await f.runs.get(run.id))?.status, "failed");
  });
}

for (const status of ["completed", "failed"]) {
  test(`A QM claim resets the dispatch budget when the task is ${status}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const f = fixture();
    const run = await f.enqueue("one");
    await f.store.put(run.id, {
      state: "submitted",
      taskRunId: "old-task",
      attempts: 3,
      runAttempts: 0,
      at: Date.now() - 60_000,
    });
    const claimed = await f.runs.claimById(run.id, "worker", 60_000);
    await f.runs.fail(run.id, claimed!.leaseToken!, "temporary error");
    t.mock.method(f.client, "getTaskRun", async () => ({ status }));
    const worker = f.create();
    worker.start();
    await worker.sweep();
    await worker.stop();
    assert.equal(f.inputs.length, 1);
    assert.equal((await f.store.get(run.id))?.attempts, 1);
    assert.equal((await f.store.get(run.id))?.runAttempts, 1);
    assert.equal((await f.runs.get(run.id))?.status, "pending");
  });
}

for (const message of ["401 Unauthorized", "404 Not Found", "connection closed"]) {
  test(`Repeated task lookup errors (${message}) fail the QM run across core restarts`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const f = fixture();
    const run = await f.enqueue("one");
    await f.store.put(run.id, { state: "submitted", taskRunId: "old-task", attempts: 1, at: 1 });
    const lookup = t.mock.method(f.client, "getTaskRun", async () => {
      throw new Error(message);
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const worker = f.create();
      worker.start();
      await worker.sweep();
      assert.equal((await f.store.get(run.id))?.lookupFailures, attempt);
      if (attempt < 3) {
        await worker.sweep();
        assert.equal(lookup.mock.callCount(), attempt);
        assert.equal((await f.runs.get(run.id))?.status, "pending");
      }
      await worker.stop();
      t.mock.timers.tick(30_000);
    }
    assert.equal(lookup.mock.callCount(), 3);
    assert.equal(f.inputs.length, 0);
    assert.equal((await f.runs.get(run.id))?.status, "failed");
    const replacement = f.create();
    replacement.start();
    await replacement.sweep();
    await replacement.stop();
    assert.equal(await f.store.get(run.id), null);
  });
}

test("A successful task lookup clears consecutive errors even while the task runs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const f = fixture();
  const run = await f.enqueue("one");
  await f.store.put(run.id, {
    state: "submitted",
    taskRunId: "old-task",
    attempts: 1,
    at: 1,
    lookupFailures: 2,
    lookupAt: 1,
  });
  t.mock.method(f.client, "getTaskRun", async () => ({ status: "running" }));
  const worker = f.create();
  worker.start();
  await worker.sweep();
  assert.equal((await f.store.get(run.id))?.lookupFailures, 0);
  t.mock.method(f.client, "getTaskRun", async () => {
    throw new Error("temporary error");
  });
  await worker.sweep();
  await worker.stop();
  assert.equal((await f.store.get(run.id))?.lookupFailures, 1);
  assert.equal((await f.runs.get(run.id))?.status, "pending");
  assert.equal(f.inputs.length, 0);
});

test("A task lookup timeout is counted as a durable failure", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const f = fixture();
  const run = await f.enqueue("one");
  await f.store.put(run.id, { state: "submitted", taskRunId: "old-task", attempts: 1, at: 1 });
  const started = Promise.withResolvers<void>();
  t.mock.method(f.client, "getTaskRun", () => {
    started.resolve();
    return new Promise(() => {});
  });
  const worker = f.create();
  worker.start();
  const sweep = worker.sweep();
  await started.promise;
  t.mock.timers.tick(30_000);
  await sweep;
  await worker.stop();
  assert.equal((await f.store.get(run.id))?.lookupFailures, 1);
  assert.match(String(f.failures[0]), /lookup timed out/);
  assert.equal(f.inputs.length, 0);
});

test("A run that enters backoff during task lookup is not dispatched", async (t) => {
  const f = fixture();
  const run = await f.enqueue("one");
  await f.store.put(run.id, { state: "submitted", taskRunId: "old-task", attempts: 1, at: 1 });
  t.mock.method(f.client, "getTaskRun", async () => {
    const claimed = await f.runs.claimById(run.id, "old-task", 60_000);
    await f.runs.fail(run.id, claimed!.leaseToken!, "temporary error", { retryAfterMs: 60_000 });
    f.readiness.set(run.id, false);
    return { status: "failed" };
  });
  const worker = f.create();
  worker.start();
  await worker.sweep();
  await worker.stop();
  assert.equal(f.inputs.length, 0);
  assert.equal((await f.store.get(run.id))?.taskRunId, "old-task");
  assert.equal(await f.runs.claimById(run.id, "worker", 60_000), null);
});

for (const outcome of ["done", "failed", "withdrawn"]) {
  test(`Dispatch records for ${outcome} runs are removed after a core restart`, async () => {
    const f = fixture();
    const run = await f.enqueue("one");
    const worker = f.create();
    worker.start();
    await worker.sweep();
    await worker.stop();
    if (outcome === "withdrawn") await f.runs.withdraw(run.id);
    else {
      const claimed = await f.runs.claimById(run.id, "task", 60_000);
      if (outcome === "done") await f.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", sessionId: "one" });
      else await f.runs.fail(run.id, claimed!.leaseToken!, "failure", { retry: false });
    }
    f.drain();
    const replacement = f.create();
    replacement.start();
    await replacement.sweep();
    await replacement.stop();
    assert.deepEqual(await f.store.entries(), []);
    assert.equal(f.inputs.length, 1);
  });
}

test("Cleanup keeps dispatch records for running QM runs", async () => {
  const f = fixture();
  const run = await f.enqueue("one");
  const worker = f.create();
  worker.start();
  await worker.sweep();
  await f.runs.claimById(run.id, "task", 60_000);
  await worker.sweep();
  await worker.stop();
  assert.equal((await f.store.get(run.id))?.taskRunId, "trn-1");
  assert.equal(f.inputs.length, 1);
});

test("Cleanup removes a dispatch when the QM run completes before submission returns", async (t) => {
  const f = fixture();
  const run = await f.enqueue("one");
  t.mock.method(f.client, "startTask", async () => {
    const claimed = await f.runs.claimById(run.id, "task", 60_000);
    await f.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", sessionId: "one" });
    return { taskRunId: "completed-task" };
  });
  const worker = f.create();
  worker.start();
  await worker.sweep();
  assert.equal((await f.store.get(run.id))?.taskRunId, "completed-task");
  await worker.sweep();
  await worker.stop();
  assert.deepEqual(await f.store.entries(), []);
});

for (const action of ["drain", "stop"]) {
  test(`A third lookup failure does not claim the QM run after ${action}`, async (t) => {
    const f = fixture();
    const run = await f.enqueue("one");
    await f.store.put(run.id, {
      state: "submitted",
      taskRunId: "old-task",
      attempts: 1,
      at: 1,
      lookupFailures: 2,
      lookupAt: 1,
    });
    const started = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<never>();
    t.mock.method(f.client, "getTaskRun", () => {
      started.resolve();
      return lookup.promise;
    });
    const worker = f.create();
    worker.start();
    const sweep = worker.sweep();
    await started.promise;
    const stop = action === "stop" ? worker.stop() : undefined;
    if (action === "drain") f.drain();
    lookup.reject(new Error("connection closed"));
    await sweep;
    await stop;
    await worker.stop();
    assert.equal((await f.store.get(run.id))?.lookupFailures, 3);
    assert.equal((await f.runs.get(run.id))?.status, "pending");
    assert.equal((await f.runs.get(run.id))?.attempts, 0);
    assert.equal(f.inputs.length, 0);
  });
}
