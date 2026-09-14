import { randomUUID } from "node:crypto";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { collectBytes } from "../util/bytes.ts";
import { createHomeSnapshotOps, HOME_SNAPSHOT_PRUNE, snapshotDue } from "./home-snapshot.ts";
import type { RenderSnapshotStore } from "./render-snapshot-store.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { CredentialPathSpec } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { createExecSandboxBase, sandboxScopeName } from "./exec-sandbox-base.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import {
  createExecFileOps,
  createExecExport,
  createBackendBlobStaging,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import { visibleTools, type ComputerStatus, type ExecResult, type Sandbox, type SandboxHandle } from "./sandbox.ts";
import {
  RenderSnapshotGoneError,
  type RenderClient,
  type RenderSandboxInfo,
  type RenderSnapshot,
} from "./render-client.ts";

interface RenderSandboxResources {
  sandboxId?: string;
  checkpoint?: RenderSnapshot;
  pendingCheckpoint?: RenderSnapshot;
  homeSnapshotKey?: string;
}

export interface StoredRenderSandbox extends RenderSandboxResources {
  sandboxId: string;
  discarded?: boolean;
  createdAtMs: number;
  expiresAtMs: number;
  lastActivityMs: number;
  homeCheckpointAtMs?: number;
  homeDirty?: boolean;
  retiredResources?: RenderSandboxResources[];
  retirementError?: string;
  checkpointCurrent?: boolean;
  recoveryError?: string;
}

export interface RenderSandboxOptions extends BlobStagingOptions {
  client: RenderClient;
  store: DurableMap<StoredRenderSandbox>;
  advisoryLock: AdvisoryLock;
  snapshots: RenderSnapshotStore;
  namePrefix?: string;
  homeDir?: string;
  defaultTimeoutSec?: number;
  checkpointIntervalMs?: number;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createRenderSandbox(workspace: WorkspaceStore, opts: RenderSandboxOptions): Sandbox {
  const { client, store, advisoryLock } = opts;
  const prefix = opts.namePrefix ?? "qm";
  const homeDir = opts.homeDir ?? "/root";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const checkpointIntervalMs = opts.checkpointIntervalMs ?? 5 * 60_000;
  const expiryCheckpointWindowMs = Math.max((defaultTimeoutSec + 60) * 1000, 20 * 60_000);
  const scratch = new Map<string, RenderSandboxInfo>();
  const nameFor = (scope: string): string => sandboxScopeName(prefix, scope);
  const withLock = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    advisoryLock.withLock(`render-sandbox:${name}`, fn);
  const lockHandle =
    <Args extends unknown[], Result>(
      operation: (handle: SandboxHandle, ...args: Args) => Promise<Result>,
    ): ((handle: SandboxHandle, ...args: Args) => Promise<Result>) =>
    (handle, ...args) =>
      withLock(handle.id, () => operation(handle, ...args));
  const reportError = (code: string, error: unknown, scopeLabel?: string): void =>
    opts.onError?.({
      category: "sandbox_snapshot",
      code,
      message: errMessage(error),
      ...(scopeLabel ? { scopeLabel } : {}),
    });
  const scopeFor = (name: string): string => {
    const scope = base.scopeFor(name);
    if (!scope) throw new Error(`Render sandbox scope is unknown: ${name}`);
    return scope;
  };
  const idFor = async (name: string): Promise<string> => {
    const temporary = scratch.get(name);
    if (temporary) return temporary.id;
    const scope = scopeFor(name);
    const stored = await store.get(scope);
    if (!stored || stored.discarded) throw new Error(`Render sandbox is not provisioned: ${name}`);
    const touch = Date.now() - stored.lastActivityMs >= 60_000;
    if (touch || stored.homeDirty === false)
      await store.merge(scope, { homeDirty: true, ...(touch ? { lastActivityMs: Date.now() } : {}) });
    return stored.sandboxId;
  };
  const exec = async (name: string, script: string, timeoutSec: number): Promise<ExecResult> => {
    const id = await idFor(name);
    const result = await client.runCommand(
      id,
      `timeout ${timeoutSec} sh -c ${shq(script)}`,
      timeoutSec * 1000 + 30_000,
    );
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode, timedOut: result.exitCode === 124 };
  };
  const writeAbsBytes = async (name: string, path: string, data: Uint8Array): Promise<void> =>
    client.writeFileBytes(await idFor(name), path, data);
  const readAbsBytes = async (name: string, path: string): Promise<Uint8Array | null> =>
    client.readFileBytes(await idFor(name), path);

  const homeSnapshots = createHomeSnapshotOps<string>({
    label: "render",
    homeDir,
    homeTarPath: `${homeDir}/.qm-home.tar`,
    prunePaths: [
      ...HOME_SNAPSHOT_PRUNE,
      ...ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => `./${rel}`),
    ],
    store: opts.snapshots,
    io: {
      runCommand: (id, command, timeoutMs) => client.runCommand(id, command, timeoutMs),
      readFileBytes: (id, path) => client.readFileBytes(id, path),
      writeFileBytes: (id, path, data) => client.writeFileBytes(id, path, data),
    },
  });

  async function waitCheckpoint(snapshot: RenderSnapshot): Promise<RenderSnapshot> {
    const deadline = Date.now() + 180_000;
    while (snapshot.status === "creating") {
      if (Date.now() >= deadline) throw new Error(`Render checkpoint ${snapshot.id} did not finish within 180 seconds`);
      await sleep(1000);
      snapshot = await client.getSnapshot(snapshot);
    }
    if (snapshot.status !== "available") throw new RenderSnapshotGoneError(snapshot.id);
    if (snapshot.expiresAtMs <= Date.now()) throw new RenderSnapshotGoneError(snapshot.id);
    return snapshot;
  }

  const resourcesFor = (stored: StoredRenderSandbox): RenderSandboxResources => ({
    sandboxId: stored.sandboxId,
    checkpoint: stored.checkpoint,
    pendingCheckpoint: stored.pendingCheckpoint,
    homeSnapshotKey: stored.homeSnapshotKey,
  });

  async function disposeResources(resources: RenderSandboxResources): Promise<void> {
    if (resources.sandboxId) await client.terminate(resources.sandboxId);
    for (const snapshot of [resources.pendingCheckpoint, resources.checkpoint]) {
      if (snapshot) await client.deleteSnapshot(snapshot);
    }
    if (resources.homeSnapshotKey) await opts.snapshots.delete?.(resources.homeSnapshotKey);
  }

  async function cleanupRetired(scope: string, stored: StoredRenderSandbox): Promise<StoredRenderSandbox> {
    const retired = [...(stored.retiredResources ?? [])];
    while (retired.length) {
      try {
        await disposeResources(retired[0]!);
      } catch (error) {
        reportError("retirement_failed", error, scope);
        return (await store.merge(scope, { retirementError: errMessage(error) }))!;
      }
      retired.shift();
      stored = (await store.merge(scope, {
        retiredResources: retired.length ? retired : undefined,
        retirementError: undefined,
      }))!;
    }
    return stored;
  }

  async function recoverStored(scope: string, stored: StoredRenderSandbox): Promise<StoredRenderSandbox | null> {
    stored = await cleanupRetired(scope, stored);
    if (!stored.discarded) return stored;
    if (stored.retiredResources?.length)
      throw new Error(`Render import cleanup is incomplete: ${stored.retirementError}`);
    await store.delete(scope);
    return null;
  }

  async function finishCheckpoint(scope: string, stored: StoredRenderSandbox): Promise<StoredRenderSandbox> {
    let snapshot = stored.pendingCheckpoint;
    try {
      if (!snapshot) {
        snapshot = await client.createSnapshot(stored.sandboxId);
        await store.merge(scope, { pendingCheckpoint: snapshot });
      }
      snapshot = await waitCheckpoint(snapshot);
      const previous = stored.checkpoint;
      const saved = await store.merge(scope, {
        checkpoint: snapshot,
        checkpointCurrent: true,
        pendingCheckpoint: undefined,
        recoveryError: undefined,
        ...(previous && previous.id !== snapshot.id
          ? {
              retiredResources: [...(stored.retiredResources ?? []), { checkpoint: previous }],
            }
          : {}),
      });
      if (!saved) throw new Error(`Render sandbox checkpoint lost its scope: ${scope}`);
      return cleanupRetired(scope, saved);
    } catch (error) {
      const failed = await store.merge(scope, {
        recoveryError: errMessage(error),
        ...(snapshot ? { pendingCheckpoint: snapshot } : {}),
        ...(error instanceof RenderSnapshotGoneError
          ? {
              pendingCheckpoint: undefined,
              ...(snapshot ? { retiredResources: [...(stored.retiredResources ?? []), { checkpoint: snapshot }] } : {}),
            }
          : {}),
      });
      if (failed && error instanceof RenderSnapshotGoneError) await cleanupRetired(scope, failed);
      throw error;
    }
  }

  async function checkpoint(scope: string, stored: StoredRenderSandbox): Promise<StoredRenderSandbox> {
    if (stored.discarded) throw new Error(`Render sandbox is not provisioned: ${scope}`);
    const homeSnapshotKey = randomUUID();
    const pending = await store.merge(scope, {
      retiredResources: [...(stored.retiredResources ?? []), { homeSnapshotKey }],
    });
    if (!pending) throw new Error(`Render sandbox home backup lost its scope: ${scope}`);
    let published = false;
    try {
      await homeSnapshots.snapshotHome(homeSnapshotKey, stored.sandboxId);
      const retiredResources = [
        ...(stored.retiredResources ?? []),
        ...(stored.homeSnapshotKey ? [{ homeSnapshotKey: stored.homeSnapshotKey }] : []),
        ...(stored.pendingCheckpoint ? [{ checkpoint: stored.pendingCheckpoint }] : []),
      ];
      const saved = await store.merge(scope, {
        homeSnapshotKey,
        homeCheckpointAtMs: Date.now(),
        homeDirty: false,
        checkpointCurrent: false,
        pendingCheckpoint: undefined,
        retiredResources: retiredResources.length ? retiredResources : undefined,
      });
      if (!saved) throw new Error(`Render sandbox home backup lost its scope: ${scope}`);
      published = true;
      stored = await cleanupRetired(scope, saved);
      return await finishCheckpoint(scope, stored);
    } catch (error) {
      if (!published) {
        await cleanupRetired(scope, (await store.get(scope)) ?? pending);
        throw error;
      }
      reportError("native_checkpoint_failed", error, scope);
      return (await store.get(scope))!;
    }
  }

  async function hasLiveProcesses(sandboxId: string): Promise<boolean> {
    const sessions = await createExecProcessSessions({
      async run(_handle, command, options) {
        const result = await client.runCommand(sandboxId, command, options?.timeoutMs ?? 30_000);
        if (result.exitCode !== 0) throw new Error(`Render process probe failed: ${result.stderr}`);
        return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode, timedOut: false };
      },
    }).listProcesses({ id: sandboxId, rootDir: `${homeDir}/workspace`, homeDir });
    return sessions.some((process) => process.status.state === "running");
  }

  async function ensureResident(name: string, onStatus?: (text: string) => void): Promise<{ coldStart: boolean }> {
    const scope = scopeFor(name);
    let stored = await store.get(scope);
    if (stored) stored = await recoverStored(scope, stored);
    let snapshotId: string | undefined;
    if (stored) {
      const info = await client.get(stored.sandboxId);
      if (info?.status === "running") {
        if (info.expiresAtMs > Date.now() + (defaultTimeoutSec + 60) * 1000 || (await hasLiveProcesses(info.id))) {
          await store.merge(scope, { lastActivityMs: Date.now() });
          return { coldStart: false };
        }
        stored = await checkpoint(scope, stored);
        await client.terminate(info.id);
      } else if (info && info.status !== "terminated" && info.status !== "errored") {
        throw new Error(`Render sandbox ${info.id} is ${info.status}; retry after its transition ends`);
      }
      if (stored.checkpointCurrent && stored.checkpoint && stored.checkpoint.expiresAtMs > Date.now()) {
        const snapshot = await client.getSnapshot(stored.checkpoint).catch((error) => {
          if (error instanceof RenderSnapshotGoneError) return null;
          throw error;
        });
        if (snapshot?.status === "available" && snapshot.expiresAtMs > Date.now()) snapshotId = snapshot.id;
      }
      if (!snapshotId && !stored.homeSnapshotKey) {
        throw new Error(
          "Render sandbox is gone and has no durable home checkpoint. Import a recovery copy before replacing its home.",
        );
      }
    }
    try {
      onStatus?.(stored ? "Restoring your computer…" : "Starting your computer…");
    } catch (error) {
      void error;
    }
    const info = await client.create(snapshotId);
    try {
      if (info.expiresAtMs <= Date.now() + (defaultTimeoutSec + 60) * 1000) {
        throw new Error("Render sandbox lifetime must exceed the command timeout by at least 60 seconds");
      }
      if (stored && !snapshotId && !(await homeSnapshots.hydrateHome(stored.homeSnapshotKey!, info.id))) {
        throw new Error("Render sandbox home checkpoint is missing; refusing a blank replacement");
      }
      if (snapshotId) {
        const scrub = await client.runCommand(info.id, `rm -rf /tmp/agent-creds ${shq(homeDir)}/.cred-state*`, 30_000);
        if (scrub.exitCode !== 0)
          throw new Error(`Render sandbox could not clear expired credentials: ${scrub.stderr}`);
      }
      await store.put(scope, {
        ...stored,
        sandboxId: info.id,
        createdAtMs: Date.now(),
        expiresAtMs: info.expiresAtMs,
        lastActivityMs: Date.now(),
        ...(stored?.checkpoint ? { checkpoint: stored.checkpoint } : {}),
      });
    } catch (error) {
      await client.terminate(info.id).catch(swallowAs("render-sandbox: discard untracked sandbox", undefined));
      throw error;
    }
    return { coldStart: !stored };
  }

  async function destroyScope(scope: string): Promise<void> {
    return withLock(nameFor(scope), async () => {
      const stored = await store.get(scope);
      if (!stored) return;
      for (const retired of stored.retiredResources ?? []) await disposeResources(retired);
      await disposeResources(resourcesFor(stored));
      await store.delete(scope);
    });
  }

  const base = createExecSandboxBase({
    workspace,
    label: "render",
    prefix,
    homeDir,
    defaultTimeoutSec,
    credentialPaths: opts.credentialPaths ?? [],
    deleteFailureCode: "render_destroy_failed",
    onError: opts.onError,
    exec,
    writeAbsBytes,
    readAbsBytes,
    ensureResident,
    isProvisioned: (name) => scratch.has(name),
    async recreateScratch(name) {
      scratch.set(name, await client.create());
    },
    async deleteInstance(name) {
      const temporary = scratch.get(name);
      if (temporary) {
        await client.terminate(temporary.id);
        scratch.delete(name);
      } else {
        await destroyScope(scopeFor(name));
      }
    },
    ...(opts.layerToolFiles ? { installLayerTools: createLayerToolInstaller(opts.layerToolFiles) } : {}),
  });
  const processes = createExecProcessSessions({
    run: (handle, command, options) =>
      exec(handle.id, command, options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : defaultTimeoutSec),
  });
  const staging = createBackendBlobStaging("render", exec, opts);
  const files = createExecFileOps({ label: "render", exec, writeInline: writeAbsBytes });
  const exports = createExecExport({
    label: "render",
    exec,
    readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  return {
    profile: {
      backend: "render",
      writablePersistence: "provider_managed",
      processSessions: true,
      egressEnforcement: "none",
      spec: {
        os: "Render sandbox; filesystem checkpoints restore files after the sandbox expires",
        homeDir,
        workdir: base.workspaceDir,
        get tools() {
          return visibleTools(opts.extraTools ?? []);
        },
      },
    },
    async provision(layers, options) {
      const writable = layers.find((layer) => layer.mode === "rw") ?? layers[0];
      const name = options?.scratch
        ? sandboxScopeName(`${prefix}-scratch`, options.scratch.key)
        : nameFor(writable?.scopeId ?? "default");
      return withLock(name, async () => {
        const handle = await base.provision(layers, options);
        if (!handle.scratch) {
          const scope = scopeFor(handle.id);
          const stored = await store.get(scope);
          if (stored && !stored.homeSnapshotKey) await checkpoint(scope, stored);
        }
        return handle;
      });
    },
    run: lockHandle(base.run),
    readFile: lockHandle(base.readFile),
    writeFile: lockHandle(base.writeFile),
    readFileBytes: lockHandle(base.readFileBytes),
    writeFileBytes: lockHandle(base.writeFileBytes),
    importFiles: lockHandle(files.importFiles),
    listDir: lockHandle(files.listDir),
    removeDir: lockHandle(files.removeDir),
    exportFiles: lockHandle(exports.exportFiles),
    ...(staging ? { stageIn: lockHandle(staging.stageIn), stageOut: lockHandle(staging.stageOut) } : {}),
    startProcess: lockHandle(processes.startProcess),
    readProcess: lockHandle(processes.readProcess),
    writeStdin: lockHandle(processes.writeStdin),
    signalProcess: lockHandle(processes.signalProcess),
    listProcesses: lockHandle(processes.listProcesses),
    destroyScope,
    async adoptHomeSnapshot(scope, blobId) {
      const blob = await opts.blobTransfer?.open(blobId);
      if (!blob) throw new Error(`Render home import could not read blob ${blobId}`);
      if (blob.sizeBytes > 256 * 1024 * 1024) {
        blob.stream.destroy();
        throw new Error("Render home import exceeds the 256 MiB limit");
      }
      const archive = (await collectBytes(blob.stream, { maxBytes: 256 * 1024 * 1024 })).data;
      await withLock(nameFor(scope), async () => {
        let previous = await store.get(scope);
        if (previous) previous = await recoverStored(scope, previous);
        const info = await client.create();
        const resources: RenderSandboxResources = { sandboxId: info.id, homeSnapshotKey: randomUUID() };
        let published = false;
        const retainStaging = async (): Promise<void> => {
          const retiredResources = [...(previous?.retiredResources ?? []), { ...resources }];
          if (previous) {
            await store.merge(scope, { retiredResources });
          } else {
            await store.put(scope, {
              sandboxId: info.id,
              discarded: true,
              createdAtMs: Date.now(),
              expiresAtMs: info.expiresAtMs,
              lastActivityMs: 0,
              retiredResources,
            });
          }
        };
        try {
          await retainStaging();
          await client.writeFileBytes(info.id, `${homeDir}/.qm-import.tar`, archive);
          const restored = await client.runCommand(
            info.id,
            `mkdir -p ${shq(homeDir)} && tar -tf ${shq(homeDir)}/.qm-import.tar > /dev/null && tar -xf ${shq(homeDir)}/.qm-import.tar -C ${shq(homeDir)} && rm -f ${shq(homeDir)}/.qm-import.tar`,
            180_000,
          );
          if (restored.exitCode !== 0) throw new Error(`Render home import failed: ${restored.stderr}`);
          await homeSnapshots.snapshotHome(resources.homeSnapshotKey!, info.id);
          resources.checkpoint = await client.createSnapshot(info.id);
          await retainStaging();
          resources.checkpoint = await waitCheckpoint(resources.checkpoint);
          const imported: StoredRenderSandbox = {
            ...resources,
            sandboxId: info.id,
            createdAtMs: Date.now(),
            expiresAtMs: info.expiresAtMs,
            lastActivityMs: Date.now(),
            homeCheckpointAtMs: Date.now(),
            checkpointCurrent: true,
            ...(previous ? { retiredResources: [...(previous.retiredResources ?? []), resourcesFor(previous)] } : {}),
          };
          await store.put(scope, imported);
          published = true;
          await cleanupRetired(scope, imported);
        } catch (error) {
          if (!published) {
            try {
              await retainStaging();
              const staged = (await store.get(scope))!;
              const cleaned = await cleanupRetired(scope, staged);
              if (cleaned.discarded && !cleaned.retiredResources?.length) await store.delete(scope);
            } catch {
              await disposeResources(resources).catch(async (cleanupError) => {
                await retainStaging();
                await store.merge(scope, { retirementError: errMessage(cleanupError) });
              });
            }
          }
          throw error;
        }
      });
    },

    async persistHomeSnapshot(scope) {
      await withLock(nameFor(scope), async () => {
        const stored = await store.get(scope);
        if (!stored) throw new Error(`Render sandbox is not provisioned: ${scope}`);
        await checkpoint(scope, stored);
      });
    },
    async teardown(handle, options) {
      if (handle.scratch) return withLock(handle.id, () => base.teardown(handle, options));
      const scope = scopeFor(handle.id);
      if (options?.destroy) return destroyScope(scope);
      await withLock(handle.id, async () => {
        const stored = await store.get(scope);
        if (!stored) return;
        const bookkeeping = { lastSnapshotMs: stored.homeCheckpointAtMs, homeDirty: stored.homeDirty };
        if (snapshotDue(bookkeeping, options, checkpointIntervalMs)) await checkpoint(scope, stored);
        await store.merge(scope, { lastActivityMs: Date.now() });
      });
    },
    async restartComputer(scope) {
      await withLock(nameFor(scope), async () => {
        const stored = await store.get(scope);
        if (!stored) return;
        const info = await client.get(stored.sandboxId);
        if (info?.status === "running") {
          await checkpoint(scope, stored);
          await client.terminate(info.id);
        }
      });
    },
    async reapDeepIdle(idleMs) {
      let reaped = 0;
      const cutoff = idleMs > 0 ? Date.now() - idleMs : -Infinity;
      const due = (stored: StoredRenderSandbox): boolean =>
        stored.expiresAtMs > Date.now() &&
        (stored.lastActivityMs <= cutoff || stored.expiresAtMs <= Date.now() + expiryCheckpointWindowMs);
      for (const [scope, candidate] of await store.entries()) {
        if (!due(candidate) && !candidate.discarded && !candidate.retiredResources?.length) continue;
        await withLock(nameFor(scope), async () => {
          let stored = await store.get(scope);
          if (stored) stored = await recoverStored(scope, stored);
          if (!stored || !due(stored)) return;
          const info = await client.get(stored.sandboxId);
          if (info?.status !== "running") return;
          const expiresSoon = info.expiresAtMs <= Date.now() + expiryCheckpointWindowMs;
          const rotate = info.expiresAtMs <= Date.now() + (defaultTimeoutSec + 60) * 1000;
          const idle = stored.lastActivityMs <= cutoff;
          if (!expiresSoon && !idle) return;
          const active = await hasLiveProcesses(info.id);
          if (active && !expiresSoon) return;
          if ((!active && (idle || rotate)) || Date.now() - (stored.homeCheckpointAtMs ?? 0) >= 5 * 60_000)
            await checkpoint(scope, stored);
          if (active || (!idle && !rotate)) return;
          await client.terminate(info.id);
          reaped++;
        }).catch((error) => reportError("idle_checkpoint_failed", error, scope));
      }
      return { reaped };
    },
    async computerStatus(scope): Promise<ComputerStatus> {
      const stored = await store.get(scope);
      if (!stored) return { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
      if (stored.discarded)
        return {
          machine: "Render import cleanup pending",
          provisioned: false,
          guestResponsive: false,
          recovery: { strategy: "provider_snapshot", state: "cleanup_pending", error: stored.retirementError },
        };
      const recovery = {
        strategy: "provider_snapshot" as const,
        ...(stored.checkpoint
          ? {
              checkpointId: stored.checkpoint.id,
              checkpointAtMs: stored.checkpoint.capturedAtMs,
              checkpointExpiresAtMs: stored.checkpoint.expiresAtMs,
            }
          : {}),
        ...((stored.recoveryError ?? stored.retirementError)
          ? { error: stored.recoveryError ?? stored.retirementError }
          : {}),
      };
      try {
        const info = await client.get(stored.sandboxId);
        const running = info?.status === "running";
        const response = running ? await client.runCommand(stored.sandboxId, "true", 10_000) : null;
        return {
          machine: `Render sandbox ${stored.sandboxId}: ${info?.status ?? "missing"}`,
          provisioned: running,
          guestResponsive: response?.exitCode === 0,
          expiresAtMs: stored.expiresAtMs,
          recovery,
          ...(running ? { lifecycleState: "running" } : {}),
        };
      } catch (error) {
        return {
          machine: `Render sandbox ${stored.sandboxId}`,
          guestResponsive: false,
          recovery,
          probeError: errMessage(error),
        };
      }
    },
  };
}
