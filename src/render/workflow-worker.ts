import { Render } from "@renderinc/sdk";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { Worker } from "../runs/worker.ts";
import { createSweeper } from "../util/sweeper.ts";

export interface RenderWorkflowDispatch {
  state: "submitting" | "submitted";
  taskRunId?: string;
  attempts: number;
  at: number;
}

export function createRenderWorkflowWorker(opts: {
  apiKey: string;
  task: string;
  runs: RunStore;
  store: DurableMap<RenderWorkflowDispatch>;
  lock: AdvisoryLock;
  canClaim: () => boolean;
  onError?: (error: unknown) => void;
  client?: Pick<Render["workflows"], "startTask" | "getTaskRun">;
}): Worker & { sweep(): Promise<void> } {
  const client = opts.client ?? new Render({ token: opts.apiKey }).workflows;
  let stopped = true;
  let pending: Promise<void> | undefined;
  async function scan(): Promise<void> {
    if (!opts.canClaim()) return;
    for (const sessionId of await opts.runs.activeSessionIds()) {
      if (stopped || !opts.canClaim()) return;
      const runs = await opts.runs.inFlightForThread(sessionId);
      if (runs.some((run) => run.status === "running")) continue;
      const next = runs.find((run) => run.status === "pending");
      if (!next) continue;
      await opts.lock
        .withLock(`render-workflow:${next.id}`, async () => {
          if ((await opts.runs.get(next.id))?.status !== "pending") return;
          const saved = await opts.store.get(next.id);
          if (saved?.state === "submitting" && Date.now() - saved.at < 30_000) return;
          let previousAttempts = saved?.attempts ?? 0;
          if (saved?.taskRunId) {
            const run = await client.getTaskRun(saved.taskRunId);
            if (!["completed", "succeeded", "failed", "canceled"].includes(run.status)) return;
            if (Date.now() - saved.at < 30_000) return;
            if (run.status === "completed" || run.status === "succeeded") previousAttempts = 0;
          }
          if (previousAttempts >= 3) {
            const error = `Render Workflow dispatch for ${next.id} failed three times. Inspect the workflow and retry the QM run.`;
            const claimed = await opts.runs.claimById(next.id, "render-workflow-dispatch", 30_000);
            if (claimed?.leaseToken) await opts.runs.fail(next.id, claimed.leaseToken, error, { retry: false });
            throw new Error(error);
          }
          const dispatch: RenderWorkflowDispatch = {
            state: "submitting",
            attempts: previousAttempts + 1,
            at: Date.now(),
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
