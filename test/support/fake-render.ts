import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RenderSandboxGoneError,
  RenderSnapshotGoneError,
  type RenderClient,
  type RenderSandboxInfo,
  type RenderSnapshot,
} from "../../src/sandbox/render-client.ts";
import type { RenderApi } from "../../src/deploy/render-api.ts";

export interface FakeRenderApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

export function createFakeRenderApi(
  handle: (call: FakeRenderApiCall) => unknown,
): RenderApi & { calls: FakeRenderApiCall[] } {
  const calls: FakeRenderApiCall[] = [];
  return {
    calls,
    async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
      const url = new URL(path, "https://render.test");
      const call = { method, path: url.pathname, query: url.searchParams, body };
      calls.push(call);
      return (await handle(call)) as T | null;
    },
  };
}

export function createFakeRender() {
  const execute = promisify(execFile);
  const root = mkdtempSync(join(tmpdir(), "fake-render-"));
  const sandboxes = new Map<string, RenderSandboxInfo>();
  const snapshots = new Map<string, RenderSnapshot>();
  const createdFrom: Array<string | undefined> = [];
  const commands: string[] = [];
  const deleted: string[] = [];
  let checkpointError: Error | undefined;
  let terminateError: Error | undefined;
  const terminateErrors = new Map<string, Error>();
  const home = (id: string): string => join(root, id);
  const requireRunning = (id: string): RenderSandboxInfo => {
    const info = sandboxes.get(id);
    if (info?.status !== "running") throw new RenderSandboxGoneError(id);
    return info;
  };
  const mapped = (id: string, path: string): string => path.replace(/^\/root(?![A-Za-z0-9_-])/, home(id));
  const client: RenderClient = {
    async create(snapshotId) {
      const id = `sbx-${sandboxes.size + 1}`;
      const info = { id, status: "running", expiresAtMs: Date.now() + 7200_000 };
      if (snapshotId) {
        if (snapshots.get(snapshotId)?.status !== "available") throw new Error("checkpoint unavailable");
        cpSync(join(root, snapshotId), home(id), { recursive: true });
      } else {
        mkdirSync(home(id), { recursive: true });
      }
      sandboxes.set(id, info);
      createdFrom.push(snapshotId);
      return { ...info };
    },
    async get(id) {
      return sandboxes.get(id) ?? null;
    },
    async terminate(id) {
      if (terminateError ?? terminateErrors.get(id)) throw terminateError ?? terminateErrors.get(id);
      const info = sandboxes.get(id);
      if (info) info.status = "terminated";
      rmSync(home(id), { recursive: true, force: true });
    },
    async runCommand(id, command) {
      requireRunning(id);
      commands.push(command);

      mkdirSync(join(home(id), "tmp"), { recursive: true });
      const wrapped = /^timeout \d+ sh -c '(.*)'$/s.exec(command);
      const unwrapped = wrapped ? wrapped[1]!.replaceAll("'\\''", "'") : command;
      const script = unwrapped
        .replace(/\/tmp\//g, `${home(id)}/tmp/`)
        .replace(/\/root(?![A-Za-z0-9_-])/g, home(id))
        .replace(/tar --no-recursion --null -T ('[^']+') -cf ('[^']+')/g, "xargs -0 tar --no-recursion -cf $2 -- < $1");

      try {
        const result = await execute("/bin/sh", ["-c", script], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home(id), COPYFILE_DISABLE: "1" },
          maxBuffer: 16 * 1024 * 1024,
          timeout: 30_000,
        });

        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (error) {
        const result = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (typeof result.code !== "number") throw new Error(result.message, { cause: error });
        return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code };
      }
    },
    async readFileBytes(id, path) {
      requireRunning(id);
      return existsSync(mapped(id, path)) ? readFileSync(mapped(id, path)) : null;
    },
    async writeFileBytes(id, path, data) {
      requireRunning(id);
      const dest = mapped(id, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    },
    async createSnapshot(id) {
      requireRunning(id);
      if (checkpointError) throw checkpointError;
      const snapshotId = `snp-${snapshots.size + deleted.length + 1}`;
      const snapshot: RenderSnapshot = {
        id: snapshotId,
        sandboxGroupId: "sbg-test",
        status: "available",
        expiresAtMs: Date.now() + 86400_000,
        capturedAtMs: Date.now(),
      };
      cpSync(home(id), join(root, snapshotId), { recursive: true });
      snapshots.set(snapshotId, snapshot);
      return { ...snapshot };
    },
    async getSnapshot(snapshot) {
      const value = snapshots.get(snapshot.id);
      if (!value) throw new RenderSnapshotGoneError(snapshot.id);
      return { ...value };
    },
    async deleteSnapshot(snapshot) {
      deleted.push(snapshot.id);
      snapshots.delete(snapshot.id);
      rmSync(join(root, snapshot.id), { recursive: true, force: true });
    },
  };
  return {
    client,
    sandboxes,
    snapshots,
    createdFrom,
    commands,
    deleted,
    home,
    failCheckpoint(error?: Error) {
      checkpointError = error;
    },
    failTerminate(error?: Error, sandboxId?: string) {
      if (sandboxId) {
        if (error) terminateErrors.set(sandboxId, error);
        else terminateErrors.delete(sandboxId);
      } else terminateError = error;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
