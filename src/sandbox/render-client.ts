import { ClientError, Render, SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import { dirname } from "node:path/posix";
import { sleep } from "../util/async.ts";
import { shq } from "../util/shell.ts";

type RenderSandboxPlan = "starter" | "standard" | "pro";

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
  runCommand(
    sandboxId: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFileBytes(sandboxId: string, absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(sandboxId: string, absPath: string, data: Uint8Array): Promise<void>;
  createSnapshot(sandboxId: string): Promise<RenderSnapshot>;
  getSnapshot(snapshot: RenderSnapshot): Promise<RenderSnapshot>;
  deleteSnapshot(snapshot: RenderSnapshot): Promise<void>;
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
      return normalizeInfo(await api.get(sandboxId));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };
  const runCommand: RenderClient["runCommand"] = async (sandboxId, command, timeoutMs) => {
    const stream = await api.exec(sandboxId, command, undefined, AbortSignal.timeout(timeoutMs));
    let stdout = "";
    let stderr = "";
    for await (const event of stream) {
      if (event.type === "exit") return { stdout, stderr, exitCode: event.exit_code };
      if (event.stream === "stdout") stdout += event.data;
      else stderr += event.data;
    }
    throw new Error(`Render sandbox ${sandboxId}: command stream ended without an exit code`);
  };
  return {
    async create(snapshotId) {
      let info = normalizeInfo(
        await api.create({
          plan: opts.plan ?? "starter",
          timeoutSeconds: opts.ttlSec ?? 7200,
          ...(snapshotId ? { snapshotId } : {}),
        }),
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
        await api.terminate(info.id).catch(() => undefined);
        throw error;
      }
    },
    get,
    async terminate(sandboxId) {
      try {
        await api.terminate(sandboxId);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
    runCommand,
    async readFileBytes(sandboxId, absPath) {
      const exists = await runCommand(sandboxId, `test -f ${shq(absPath)}`, 30_000);
      if (exists.exitCode === 1) return null;
      if (exists.exitCode !== 0) throw new Error(`Render sandbox could not read ${absPath}: ${exists.stderr}`);
      return (await api.download(sandboxId, absPath)).data;
    },
    async writeFileBytes(sandboxId, absPath, data) {
      const prep = await runCommand(sandboxId, `mkdir -p ${shq(dirname(absPath))}`, 30_000);
      if (prep.exitCode !== 0)
        throw new Error(`Render sandbox could not create the parent of ${absPath}: ${prep.stderr}`);
      await api.upload(sandboxId, absPath, data);
    },
    async createSnapshot(sandboxId) {
      return normalizeSnapshot(await api.snapshots.create({ sandboxId, kind: "filesystem" }));
    },
    async getSnapshot(snapshot) {
      try {
        return normalizeSnapshot(
          await api.snapshots.get({ sandboxGroupId: snapshot.sandboxGroupId, snapshotId: snapshot.id }),
        );
      } catch (error) {
        if (error instanceof SandboxSnapshotNotFoundError) throw new RenderSnapshotGoneError(snapshot.id);
        throw error;
      }
    },
    async deleteSnapshot(snapshot) {
      try {
        await api.snapshots.delete({ sandboxGroupId: snapshot.sandboxGroupId, snapshotId: snapshot.id });
      } catch (error) {
        if (!(error instanceof SandboxSnapshotNotFoundError)) throw error;
      }
    },
  };
}
