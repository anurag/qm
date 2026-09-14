import { Render } from "@renderinc/sdk";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { isTerminal, type RunStore } from "../runs/run-store.ts";
import type { Worker } from "../runs/worker.ts";
import { createSweeper } from "../util/sweeper.ts";
import { withTimeout } from "../util/async.ts";

export interface RenderWorkflowDispatch {
  state: "submitting" | "submitted";
  taskRunId?: string;
  attempts: number;
  at: number;
  runAttempts?: number;
  lookupFailures?: number;
  lookupAt?: number;
}

export async function renderWorkflowRunReady(pg: PgPool, runId: string): Promise<boolean> {
  const rows = await pg.q(
    `SELECT 1 FROM runs r WHERE r.id=$1 AND r.status='pending' AND r.retry_after <= $2
       AND NOT EXISTS (SELECT 1 FROM runs b WHERE b.session_id=r.session_id
         AND (b.status='running' OR (b.status='pending' AND b.retry_after > $2)))`,
    [runId, Date.now()],
  );
  return rows.length > 0;
}

export function createRenderWorkflowWorker(opts: {
  apiKey: string;
  task: string;
  runs: RunStore;
  store: DurableMap<RenderWorkflowDispatch>;
  lock: AdvisoryLock;
  canClaim: () => boolean;
  isReady: (runId: string) => Promise<boolean>;
  onError?: (error: unknown) => void;
  client?: Pick<Render["workflows"], "startTask" | "getTaskRun">;
}): Worker & { sweep(): Promise<void> } {
  const client = opts.client ?? new Render({ token: opts.apiKey }).workflows;
  let stopped = true;
  let pending: Promise<void> | undefined;
  async function failDispatch(runId: string): Promise<void> {
    if (stopped || !opts.canClaim()) return;
    const error = `Render Workflow dispatch for ${runId} failed three times. Inspect the workflow and retry the QM run.`;
    const claimed = await opts.runs.claimById(runId, "render-workflow-dispatch", 30_000);
    if (claimed?.leaseToken) await opts.runs.fail(runId, claimed.leaseToken, error, { retry: false });
    throw new Error(error);
  }
  async function scan(): Promise<void> {
    for (const [runId] of await opts.store.entries()) {
      if (stopped) return;
      await opts.lock
        .withLock(`render-workflow:${runId}`, async () => {
          const run = await opts.runs.get(runId);
          if (!run || isTerminal(run.status)) await opts.store.delete(runId);
        })
        .catch((error) => opts.onError?.(error));
    }
    if (!opts.canClaim()) return;
    for (const sessionId of await opts.runs.activeSessionIds()) {
      if (stopped || !opts.canClaim()) return;
      const runs = await opts.runs.inFlightForThread(sessionId);
      if (runs.some((run) => run.status === "running")) continue;
      const next = runs.find((run) => run.status === "pending");
      if (!next) continue;
      await opts.lock
        .withLock(`render-workflow:${next.id}`, async () => {
          if (stopped || !opts.canClaim()) return;
          if ((await opts.runs.get(next.id))?.status !== "pending" || !(await opts.isReady(next.id))) return;
          const saved = await opts.store.get(next.id);
          if (saved?.state === "submitting" && Date.now() - saved.at < 30_000) return;
          let previousAttempts = saved?.attempts ?? 0;
          if (saved?.taskRunId) {
            if ((saved.lookupFailures ?? 0) >= 3) return failDispatch(next.id);
            if (saved.lookupAt !== undefined && Date.now() - saved.lookupAt < 30_000) return;
            const taskRunId = saved.taskRunId;
            const run = await withTimeout(() => client.getTaskRun(taskRunId), 30_000, "Render Workflow lookup").catch(
              async (error: unknown) => {
                const lookupFailures = (saved.lookupFailures ?? 0) + 1;
                await opts.store.put(next.id, { ...saved, lookupFailures, lookupAt: Date.now() });
                if (lookupFailures >= 3) await failDispatch(next.id);
                throw error;
              },
            );
            if (saved.lookupFailures)
              await opts.store.put(next.id, { ...saved, lookupFailures: 0, lookupAt: undefined });
            if (!["completed", "succeeded", "failed", "canceled"].includes(run.status)) return;
            if (Date.now() - saved.at < 30_000) return;
          }
          const current = await opts.runs.get(next.id);
          if (current?.status !== "pending") return;
          if (stopped || !opts.canClaim() || !(await opts.isReady(next.id))) return;
          if (current.attempts > (saved?.runAttempts ?? 0)) previousAttempts = 0;
          if (previousAttempts >= 3) return failDispatch(next.id);
          const dispatch: RenderWorkflowDispatch = {
            state: "submitting",
            attempts: previousAttempts + 1,
            at: Date.now(),
            runAttempts: current.attempts,
          };
          await opts.store.put(next.id, dispatch);
          const started = await client.startTask(opts.task, [next.id], AbortSignal.timeout(30_000));
          await opts.store.put(next.id, { ...dispatch, state: "submitted", taskRunId: started.taskRunId });
        })
        .catch((error) => opts.onError?.(error));
    }
  }
  function sweep(): Promise<void> {
    if (pending) return pending;
    pending = scan().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  const loop = createSweeper(sweep, 2_000, { immediate: true, label: "render-workflow-dispatch" });
  return {
    sweep,
    start() {
      stopped = false;
      loop.start();
    },
    busy: () => false,
    releaseInFlight: () => Promise.resolve(),
    async stop() {
      stopped = true;
      loop.stop();
      await pending;
    },
  };
}
