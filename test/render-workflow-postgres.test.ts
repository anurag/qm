import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Render } from "@renderinc/sdk";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createRenderAdvisoryLock } from "../src/persistence/render-advisory-lock.ts";
import {
  createRenderWorkflowWorker,
  renderWorkflowRunReady,
  type RenderWorkflowDispatch,
} from "../src/render/workflow-worker.ts";

const request: OrchestratorInput = {
  actor: { id: "workflow-test", type: "internal" },
  conversation: { kind: "dm", threadRef: "workflow-test", audience: [] },
  origin: { kind: "direct" },
  text: "test",
};

async function fixture(t: TestContext) {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const schema = `render_workflow_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const close: Array<() => Promise<void>> = [];
  const workers: Array<ReturnType<typeof createRenderWorkflowWorker>> = [];
  const submissions: string[] = [];
  const errors: unknown[] = [];
  const client = {
    async startTask(_task: string, input: unknown[]) {
      submissions.push(input[0] as string);
      return { taskRunId: `trn-${submissions.length}` };
    },
    async getTaskRun() {
      return { status: "failed" };
    },
  } as unknown as Pick<Render["workflows"], "startTask" | "getTaskRun">;
  t.after(async () => {
    t.mock.timers.reset();
    for (const worker of workers) await worker.stop();
    for (const stop of close) await stop();
    try {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });
  const open = () => {
    const runtime = createPostgresRunStore(url.toString());
    const maps = createPostgresMapFactory(url.toString());
    const store = maps.map<RenderWorkflowDispatch>("render_workflow_dispatches");
    const stop = async () => {
      await runtime.close();
      await maps.pool.close();
    };
    close.push(stop);
    const worker = (canClaim = true) => {
      const result = createRenderWorkflowWorker({
        apiKey: "test",
        task: "tsk-test",
        runs: runtime.runs,
        store,
        lock: createRenderAdvisoryLock(maps.pool),
        canClaim: () => canClaim,
        isReady: (runId) => renderWorkflowRunReady(maps.pool, runId),
        client,
        onError: (error) => errors.push(error),
      });
      workers.push(result);
      return result;
    };
    return {
      runs: runtime.runs,
      store,
      ready: (runId: string) => renderWorkflowRunReady(maps.pool, runId),
      enqueue: async (sessionId: string = randomUUID()) => (await runtime.runs.enqueue({ sessionId, request })).run,
      worker,
      stop,
    };
  };
  return { open, submissions, errors };
}

test(
  "Postgres Workflow dispatch preserves retry deadlines and session order across restart",
  {
    skip: !process.env.DATABASE_URL,
  },
  async (t) => {
    const f = await fixture(t);
    const first = f.open();
    const retry = await first.enqueue();
    const lease = await first.runs.claimById(retry.id, "worker-1", 60_000);
    assert.ok(lease?.leaseToken);
    assert.equal(await first.ready(retry.id), false);
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now });
    await first.runs.fail(retry.id, lease.leaseToken, "temporary outage", { retryAfterMs: 60_000 });
    const later = await first.enqueue(retry.sessionId);
    const other = await first.enqueue();
    await first.store.put(retry.id, {
      state: "submitted",
      taskRunId: "trn-before-retry",
      attempts: 1,
      runAttempts: 0,
      at: now - 60_000,
    });
    assert.equal(await first.ready(retry.id), false);
    assert.equal(await first.ready(later.id), false);
    assert.equal(await first.ready(other.id), true);
    assert.equal(await first.ready(randomUUID()), false);
    const worker = first.worker();
    worker.start();
    await worker.sweep();
    assert.deepEqual(f.submissions, [other.id]);
    assert.equal(await first.runs.claimById(retry.id, "worker-2", 60_000), null);
    assert.equal(await first.runs.claimById(later.id, "worker-2", 60_000), null);
    const otherLease = await first.runs.claimById(other.id, "worker-2", 60_000);
    assert.ok(otherLease?.leaseToken);
    await first.runs.complete(other.id, otherLease.leaseToken, { status: "ok", sessionId: other.sessionId });
    assert.equal(await first.ready(other.id), false);
    await worker.stop();
    await first.stop();

    const second = f.open();
    const replacement = second.worker();
    replacement.start();
    await replacement.sweep();
    assert.deepEqual(f.submissions, [other.id]);
    t.mock.timers.tick(59_999);
    await replacement.sweep();
    assert.equal(await second.ready(retry.id), false);
    assert.equal(await second.ready(later.id), false);
    assert.deepEqual(f.submissions, [other.id]);
    t.mock.timers.tick(1);
    assert.equal(await second.ready(retry.id), true);
    await replacement.sweep();
    assert.deepEqual(f.submissions, [other.id, retry.id]);
    const retried = await second.runs.claimById(retry.id, "worker-3", 60_000);
    assert.ok(retried?.leaseToken);
    assert.equal(retried.attempts, 2);
    assert.equal(retried.errorAttempts, 1);
    assert.equal(await second.ready(retry.id), false);
    assert.equal(await second.ready(later.id), false);
    await second.runs.complete(retry.id, retried.leaseToken, { status: "ok", sessionId: retry.sessionId });
    assert.equal(await second.ready(later.id), true);
    await replacement.sweep();
    assert.deepEqual(f.submissions, [other.id, retry.id, later.id]);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "Postgres Workflow cleanup persists across maps and restart while claims are disabled",
  {
    skip: !process.env.DATABASE_URL,
  },
  async (t) => {
    const f = await fixture(t);
    const first = f.open();
    const done = await first.enqueue();
    const failed = await first.enqueue();
    const removed = await first.enqueue();
    const pending = await first.enqueue();
    const running = await first.enqueue();
    const doneLease = await first.runs.claimById(done.id, "worker-1", 60_000);
    assert.ok(doneLease?.leaseToken);
    await first.runs.complete(done.id, doneLease.leaseToken, { status: "ok", sessionId: done.sessionId });
    const failedLease = await first.runs.claimById(failed.id, "worker-1", 60_000);
    assert.ok(failedLease?.leaseToken);
    await first.runs.fail(failed.id, failedLease.leaseToken, "permanent failure", { retry: false });
    assert.equal(await first.runs.withdraw(removed.id), true);
    const runningLease = await first.runs.claimById(running.id, "worker-1", 60_000);
    assert.ok(runningLease?.leaseToken);
    for (const run of [done, failed, removed, pending, running]) {
      await first.store.put(run.id, { state: "submitted", taskRunId: `trn-${run.id}`, attempts: 1, at: Date.now() });
    }
    assert.equal((await first.store.entries()).length, 5);
    const observer = f.open();
    assert.equal((await observer.store.entries()).length, 5);
    await first.stop();

    const replacement = f.open();
    const worker = replacement.worker(false);
    worker.start();
    await worker.sweep();
    await worker.stop();
    for (const run of [done, failed, removed]) {
      assert.equal(await observer.store.get(run.id), null);
      assert.equal(await replacement.ready(run.id), false);
    }
    assert.deepEqual((await observer.store.entries()).map(([id]) => id).sort(), [pending.id, running.id].sort());
    const pendingLease = await observer.runs.claimById(pending.id, "worker-2", 60_000);
    assert.ok(pendingLease?.leaseToken);
    await observer.runs.complete(pending.id, pendingLease.leaseToken, { status: "ok", sessionId: pending.sessionId });
    await observer.runs.complete(running.id, runningLease.leaseToken, { status: "ok", sessionId: running.sessionId });
    await replacement.stop();
    const restarted = f.open();
    const restartedWorker = restarted.worker(false);
    restartedWorker.start();
    await restartedWorker.sweep();
    assert.deepEqual(await observer.store.entries(), []);
    assert.deepEqual(await restarted.store.entries(), []);
    assert.deepEqual(f.submissions, []);
    assert.deepEqual(f.errors, []);
  },
);
