import { ClientError, Render, SandboxSnapshotNotFoundError, ServerError } from "@renderinc/sdk";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path/posix";
import { retryOperation, sleep, withAbort } from "../util/async.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";

type RenderSandboxPlan = "starter" | "standard" | "pro";

export const RENDER_SCRIPT_DIR = "/dev/.qm-run";
const CONTROL_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 300_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const CHECKPOINT_SETTLE_MS = 180_000;
const STALE_SCRIPT_MINUTES = 5;

const sdkErrors = {
  statusOf: (error: unknown): number | undefined =>
    error instanceof ClientError || error instanceof ServerError ? error.statusCode : undefined,
  networkError: (error: unknown): boolean => error instanceof TypeError,
};

export interface RenderSandboxInfo {
  id: string;
  status: string;
  expiresAtMs: number;
}

export interface RenderSnapshot {
  id: string;
  sandboxGroupId: string;
  status: "creating" | "available" | "failed";
  expiresAtMs: number;
  capturedAtMs?: number;
  error?: string;
}

export interface RenderClient {
  create(snapshotId?: string): Promise<RenderSandboxInfo>;
  get(sandboxId: string): Promise<RenderSandboxInfo | null>;
  terminate(sandboxId: string): Promise<void>;
  runScript(
    sandboxId: string,
    script: string,
    timeoutSec: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFileBytes(sandboxId: string, absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(sandboxId: string, absPath: string, data: Uint8Array): Promise<void>;
  createSnapshot(sandboxId: string): Promise<RenderSnapshot>;
  getSnapshot(snapshot: RenderSnapshot): Promise<RenderSnapshot>;
  deleteSnapshot(snapshot: RenderSnapshot): Promise<void>;
  findSnapshots(sourceSandboxId: string, sinceMs: number): Promise<RenderSnapshot[]>;
}

export interface SdkRenderClientOptions {
  apiKey: string;
  workspaceId: string;
  region?: string;
  plan?: RenderSandboxPlan;
  ttlSec?: number;
}

export class RenderSandboxGoneError extends Error {
  constructor(sandboxId: string) {
    super(`Render sandbox ${sandboxId} is no longer running`);
    this.name = "RenderSandboxGoneError";
  }
}

export class RenderSnapshotGoneError extends Error {
  constructor(snapshotId: string) {
    super(`Render checkpoint ${snapshotId} is no longer available`);
    this.name = "RenderSnapshotGoneError";
  }
}

export class RenderCheckpointUnconfirmedError extends Error {
  readonly sandboxId: string;
  readonly requestedAtMs: number;
  constructor(sandboxId: string, requestedAtMs: number, cause: unknown) {
    super(`Render did not confirm a checkpoint of sandbox ${sandboxId}: ${errMessage(cause)}`, { cause });
    this.name = "RenderCheckpointUnconfirmedError";
    this.sandboxId = sandboxId;
    this.requestedAtMs = requestedAtMs;
  }
}

export function createSdkRenderClient(opts: SdkRenderClientOptions): RenderClient {
  const api = new Render({ token: opts.apiKey, ownerId: opts.workspaceId, region: opts.region }).experimental.sandboxes;
  const normalizeInfo = (value: Awaited<ReturnType<typeof api.create>>): RenderSandboxInfo => ({
    id: value.id,
    status: value.status,
    expiresAtMs: Date.parse(value.createdAt) + value.timeoutSeconds * 1000,
  });
  const normalizeSnapshot = (value: Awaited<ReturnType<typeof api.snapshots.create>>): RenderSnapshot => ({
    id: value.id,
    sandboxGroupId: value.sandboxGroupId,
    status: value.status,
    expiresAtMs: Date.parse(value.expiresAt),
    ...(value.capturedAt ? { capturedAtMs: Date.parse(value.capturedAt) } : {}),
    ...(value.error ? { error: value.error } : {}),
  });
  const isMissing = (error: unknown): boolean => error instanceof ClientError && error.statusCode === 404;
  const get = async (sandboxId: string): Promise<RenderSandboxInfo | null> => {
    try {
      return normalizeInfo(
        await retryOperation(() => api.get(sandboxId), "idempotent", { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS }),
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };
  const terminate = async (sandboxId: string): Promise<void> => {
    try {
      await retryOperation(() => api.terminate(sandboxId), "idempotent", {
        ...sdkErrors,
        timeoutMs: CONTROL_TIMEOUT_MS,
      });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
  const exec = (sandboxId: string, command: string, signal: AbortSignal) =>
    withAbort(async () => {
      const stream = await api.exec(sandboxId, command, undefined, signal);
      let stdout = "";
      let stderr = "";
      for await (const event of stream) {
        if (event.type === "exit") return { stdout, stderr, exitCode: event.exit_code };
        if (event.stream === "stdout") stdout += event.data;
        else stderr += event.data;
      }
      throw new Error(`Render sandbox ${sandboxId}: command stream ended without an exit code`);
    }, signal);
  const getSnapshot = async (snapshot: RenderSnapshot): Promise<RenderSnapshot> => {
    try {
      return normalizeSnapshot(
        await retryOperation(
          () => api.snapshots.get({ sandboxGroupId: snapshot.sandboxGroupId, snapshotId: snapshot.id }),
          "idempotent",
          { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS },
        ),
      );
    } catch (error) {
      if (error instanceof SandboxSnapshotNotFoundError) throw new RenderSnapshotGoneError(snapshot.id);
      throw error;
    }
  };
  const discardLateCheckpoint = async (late: RenderSnapshot): Promise<void> => {
    let snapshot = late;
    const deadline = Date.now() + CHECKPOINT_SETTLE_MS;
    try {
      while (snapshot.status === "creating" && Date.now() < deadline) {
        await sleep(1000, { unref: true });
        snapshot = await getSnapshot(snapshot);
      }
    } catch (error) {
      if (error instanceof RenderSnapshotGoneError) return;
      throw error;
    }
    await deleteSnapshot(snapshot);
  };
  const deleteSnapshot = async (snapshot: RenderSnapshot): Promise<void> => {
    try {
      await retryOperation(
        () => api.snapshots.delete({ sandboxGroupId: snapshot.sandboxGroupId, snapshotId: snapshot.id }),
        "idempotent",
        { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS },
      );
    } catch (error) {
      if (!(error instanceof SandboxSnapshotNotFoundError)) throw error;
    }
  };
  const runScript: RenderClient["runScript"] = async (sandboxId, script, timeoutSec) => {
    const path = `${RENDER_SCRIPT_DIR}/${randomUUID()}.sh`;
    const signal = AbortSignal.timeout(timeoutSec * 1000 + Math.min(CONTROL_TIMEOUT_MS, timeoutSec * 1000));
    const prelude = `rm -f ${shq(path)}; find ${shq(RENDER_SCRIPT_DIR)} -type f -mmin +${STALE_SCRIPT_MINUTES} -delete 2>/dev/null\n`;
    try {
      await retryOperation(
        (attempt) => api.upload(sandboxId, path, Buffer.from(prelude + script), undefined, { signal: attempt }),
        "idempotent",
        { ...sdkErrors, signal, timeoutMs: TRANSFER_TIMEOUT_MS },
      );
      return await exec(sandboxId, `timeout ${timeoutSec} sh ${shq(path)}`, signal);
    } catch (error) {
      await exec(sandboxId, `rm -f ${shq(path)}`, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(
        swallowAs(`render-client: remove uploaded script ${path}`, undefined),
      );
      throw error;
    }
  };
  return {
    async create(snapshotId) {
      let info = normalizeInfo(
        await retryOperation(
          () =>
            api.create({
              plan: opts.plan ?? "starter",
              timeoutSeconds: opts.ttlSec ?? 7200,
              ...(snapshotId ? { snapshotId } : {}),
            }),
          "refused",
          {
            ...sdkErrors,
            timeoutMs: SUBMIT_TIMEOUT_MS,
            onLate: (late) =>
              terminate(late.id).catch(swallowAs(`render-client: terminate late sandbox ${late.id}`, undefined)),
          },
        ),
      );
      const deadline = Date.now() + 180_000;
      try {
        while (info.status !== "running") {
          if (info.status === "terminated" || info.status === "errored") throw new RenderSandboxGoneError(info.id);
          if (Date.now() >= deadline) throw new Error(`Render sandbox ${info.id} did not start within 180 seconds`);
          await sleep(1000);
          const refreshed = await get(info.id);
          if (!refreshed) throw new RenderSandboxGoneError(info.id);
          info = refreshed;
        }
        return info;
      } catch (error) {
        await terminate(info.id).catch(swallowAs(`render-client: terminate unready sandbox ${info.id}`, undefined));
        throw error;
      }
    },
    get,
    terminate,
    runScript,
    async readFileBytes(sandboxId, absPath) {
      const exists = await exec(sandboxId, `test -f ${shq(absPath)}`, AbortSignal.timeout(CONTROL_TIMEOUT_MS));
      if (exists.exitCode === 1) return null;
      if (exists.exitCode !== 0) throw new Error(`Render sandbox could not read ${absPath}: ${exists.stderr}`);
      return (
        await retryOperation((signal) => api.download(sandboxId, absPath, undefined, signal), "idempotent", {
          ...sdkErrors,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        })
      ).data;
    },
    async writeFileBytes(sandboxId, absPath, data) {
      const prep = await exec(sandboxId, `mkdir -p ${shq(dirname(absPath))}`, AbortSignal.timeout(CONTROL_TIMEOUT_MS));
      if (prep.exitCode !== 0)
        throw new Error(`Render sandbox could not create the parent of ${absPath}: ${prep.stderr}`);
      await retryOperation((signal) => api.upload(sandboxId, absPath, data, undefined, { signal }), "idempotent", {
        ...sdkErrors,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
    },
    async createSnapshot(sandboxId) {
      const requestedAtMs = Date.now();
      try {
        return normalizeSnapshot(
          await retryOperation(() => api.snapshots.create({ sandboxId, kind: "filesystem" }), "refused", {
            ...sdkErrors,
            timeoutMs: SUBMIT_TIMEOUT_MS,
            onLate: (late) =>
              discardLateCheckpoint(normalizeSnapshot(late)).catch(
                swallowAs(`render-client: delete late checkpoint ${late.id}`, undefined),
              ),
          }),
        );
      } catch (error) {
        if (error instanceof ClientError) throw error;
        throw new RenderCheckpointUnconfirmedError(sandboxId, requestedAtMs, error);
      }
    },
    getSnapshot,
    deleteSnapshot,
    async findSnapshots(sourceSandboxId, sinceMs) {
      const control = { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS };
      const found: RenderSnapshot[] = [];
      for (const { sandboxGroup } of await retryOperation(() => api.listGroups(), "idempotent", control)) {
        let cursor: string | undefined;
        for (;;) {
          const page = await retryOperation(
            () =>
              api.snapshots.list({
                sandboxGroupId: sandboxGroup.id,
                status: ["creating", "available"],
                limit: 100,
                ...(cursor ? { cursor } : {}),
              }),
            "idempotent",
            control,
          );
          for (const { snapshot } of page)
            if (snapshot.sourceSandboxId === sourceSandboxId && Date.parse(snapshot.requestedAt) >= sinceMs)
              found.push(normalizeSnapshot(snapshot));
          const last = page.at(-1);
          if (page.length < 100 || !last?.cursor || Date.parse(last.snapshot.requestedAt) < sinceMs) break;
          cursor = last.cursor;
        }
      }
      return found;
    },
  };
}
