import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { collectBytes } from "../util/bytes.ts";
import {
  createHomeSnapshotOps,
  HOME_SNAPSHOT_PRUNE,
  HomeExtractError,
  snapshotDue,
  SnapshotTooLargeError,
  type HomeSnapshotStore,
} from "./home-snapshot.ts";
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
  RenderCheckpointUnconfirmedError,
  RenderSnapshotGoneError,
  type RenderClient,
  type RenderSandboxInfo,
  type RenderSnapshot,
} from "./render-client.ts";

const UNCONFIRMED_CHECKPOINT_SKEW_MS = 60_000;
const UNCONFIRMED_CHECKPOINT_SETTLE_MS = 5 * 60_000;
const UNCONFIRMED_CHECKPOINT_EXPIRY_MS = 24 * 3600_000;

interface RenderSandboxResources {
  sandboxId?: string;
  checkpoint?: RenderSnapshot;
}

export interface StoredRenderSandbox extends RenderSandboxResources {
  sandboxId: string;
  discarded?: boolean;
  expiresAtMs: number;
  lastActivityMs: number;
  homeCheckpointAtMs?: number;
  homeDirty?: boolean;
  savedAtMs?: number;
  checkpointBehindHome?: boolean;
  unconfirmedCheckpoints?: Array<{ sandboxId: string; requestedAtMs: number; lastRequestedAtMs: number }>;
  retiredResources?: RenderSandboxResources[];
  retirementError?: string;
  recoveryError?: string;
}

export interface RenderSandboxOptions extends BlobStagingOptions {
  client: RenderClient;
  store: DurableMap<StoredRenderSandbox>;
  advisoryLock: AdvisoryLock;
  snapshots: HomeSnapshotStore;
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
  const rotationMarginMs = (defaultTimeoutSec + 60) * 1000;
  const expiryCheckpointWindowMs = Math.max(rotationMarginMs, 20 * 60_000);
  const scratch = new Map<string, RenderSandboxInfo>();
  const nameFor = (scope: string): string => sandboxScopeName(prefix, scope);
  const lifecycleKey = (name: string): string => `render-sandbox:${name}`;
  const useKey = (name: string): string => `render-sandbox-use:${name}`;
  const withLifecycle = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    advisoryLock.withLock(lifecycleKey(name), fn);
  const withUse = <T>(name: string, fn: () => Promise<T>): Promise<T> => advisoryLock.withLock(useKey(name), fn);
  const tryLock = advisoryLock.tryWithLock ?? advisoryLock.withLock;
  const tryUse = <T>(name: string, fn: () => Promise<T>): Promise<T | null> => tryLock(useKey(name), fn);
  const shared = advisoryLock.withSharedLock ?? advisoryLock.withLock;
  const lockHandle =
    <Args extends unknown[], Result>(
      operation: (handle: SandboxHandle, ...args: Args) => Promise<Result>,
    ): ((handle: SandboxHandle, ...args: Args) => Promise<Result>) =>
    (handle, ...args) =>
      shared(useKey(handle.id), () => operation(handle, ...args));
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
  const cleanupOnly = (stored: StoredRenderSandbox): boolean => stored.discarded === true;
  const recentlySaved = (stored: StoredRenderSandbox): boolean =>
    stored.savedAtMs !== undefined && Date.now() - stored.savedAtMs < checkpointIntervalMs;
  const idFor = async (name: string): Promise<string> => {
    const temporary = scratch.get(name);
    if (temporary) return temporary.id;
    const scope = scopeFor(name);
    const stored = await store.get(scope);
    if (!stored || cleanupOnly(stored)) throw new Error(`Render sandbox is not provisioned: ${name}`);
    if (Date.now() - stored.lastActivityMs >= 60_000) await store.merge(scope, { lastActivityMs: Date.now() });
    return stored.sandboxId;
  };
  const exec = async (name: string, script: string, timeoutSec: number): Promise<ExecResult> => {
    const result = await client.runScript(await idFor(name), script, timeoutSec);
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
      runCommand: (id, command, timeoutMs) => client.runScript(id, command, Math.ceil(timeoutMs / 1000)),
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
  });

  async function disposeResources(resources: RenderSandboxResources): Promise<void> {
    if (resources.sandboxId) await client.terminate(resources.sandboxId);
    if (resources.checkpoint) await client.deleteSnapshot(resources.checkpoint);
  }

  const unconfirmed = (
    stored: StoredRenderSandbox,
    error: RenderCheckpointUnconfirmedError,
  ): NonNullable<StoredRenderSandbox["unconfirmedCheckpoints"]> => {
    const pending = stored.unconfirmedCheckpoints ?? [];
    const earlier = pending.find((request) => request.sandboxId === error.sandboxId);
    return [
      ...pending.filter((request) => request !== earlier),
      {
        sandboxId: error.sandboxId,
        requestedAtMs: Math.min(error.requestedAtMs, earlier?.requestedAtMs ?? Infinity),
        lastRequestedAtMs: Math.max(error.requestedAtMs, earlier?.lastRequestedAtMs ?? 0),
      },
    ];
  };

  async function retireUnconfirmed(scope: string, stored: StoredRenderSandbox): Promise<StoredRenderSandbox> {
    const pending = stored.unconfirmedCheckpoints ?? [];
    if (!pending.length) return stored;
    const known = new Set([
      stored.checkpoint?.id,
      ...(stored.retiredResources ?? []).map((resources) => resources.checkpoint?.id),
    ]);
    const strays: RenderSnapshot[] = [];
    const remaining: typeof pending = [];
    for (const request of pending) {
      const age = Date.now() - request.lastRequestedAtMs;
      let settled = false;
      try {
        const found = await client.findSnapshots(
          request.sandboxId,
          request.requestedAtMs - UNCONFIRMED_CHECKPOINT_SKEW_MS,
        );
        const unknown = found.filter((snapshot) => !known.has(snapshot.id));
        const ready = unknown.filter((snapshot) => snapshot.status !== "creating");
        for (const snapshot of ready) {
          known.add(snapshot.id);
          strays.push(snapshot);
        }
        settled = ready.length === unknown.length && age >= UNCONFIRMED_CHECKPOINT_SETTLE_MS;
      } catch (error) {
        reportError("unconfirmed_checkpoint_search_failed", error, scope);
      }
      if (settled) continue;
      if (age < UNCONFIRMED_CHECKPOINT_EXPIRY_MS) remaining.push(request);
      else
        reportError(
          "unconfirmed_checkpoint_abandoned",
          new Error(`Render did not confirm the checkpoints of sandbox ${request.sandboxId} within a day`),
          scope,
        );
    }
    if (!strays.length && remaining.length === pending.length) return stored;
    const retired = [...(stored.retiredResources ?? []), ...strays.map((checkpoint) => ({ checkpoint }))];
    return (
      (await store.merge(scope, {
        unconfirmedCheckpoints: remaining.length ? remaining : undefined,
        retiredResources: retired.length ? retired : undefined,
      })) ?? stored
    );
  }

  async function cleanupRetired(scope: string, stored: StoredRenderSandbox): Promise<StoredRenderSandbox> {
    stored = await retireUnconfirmed(scope, stored);
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
    if (!cleanupOnly(stored)) return stored;
    if (stored.retiredResources?.length || stored.unconfirmedCheckpoints?.length)
      throw new Error(
        `Render sandbox cleanup is incomplete${stored.retirementError ? `: ${stored.retirementError}` : ""}`,
      );
    await store.delete(scope);
    return null;
  }

  const retire = (stored: StoredRenderSandbox, resources: RenderSandboxResources): RenderSandboxResources[] => [
    ...(stored.retiredResources ?? []),
    resources,
  ];

  async function checkpoint(
    scope: string,
    stored: StoredRenderSandbox,
    active?: boolean,
  ): Promise<StoredRenderSandbox> {
    if (cleanupOnly(stored)) throw new Error(`Render sandbox is not provisioned: ${scope}`);
    const live =
      active ??
      ((await hasLiveProcesses(stored.sandboxId)) || (await tryUse(nameFor(scope), async () => true)) === null);
    let homeError: unknown;
    try {
      await homeSnapshots.snapshotHome(scope, stored.sandboxId);
      const savedAtMs = Date.now();
      const published = await store.merge(scope, {
        homeCheckpointAtMs: savedAtMs,
        savedAtMs,
        homeDirty: live,
        ...(stored.checkpoint ? { checkpointBehindHome: true } : {}),
      });
      if (!published) throw new Error(`Render sandbox home backup lost its scope: ${scope}`);
      stored = published;
    } catch (error) {
      homeError = error;
    }
    stored = await cleanupRetired(scope, stored);
    let snapshot: RenderSnapshot | undefined;
    let saved: StoredRenderSandbox;
    try {
      snapshot = await client.createSnapshot(stored.sandboxId);
      const staged = await store.merge(scope, { retiredResources: retire(stored, { checkpoint: snapshot }) });
      if (!staged) throw new Error(`Render sandbox checkpoint lost its scope: ${scope}`);
      const available = await waitCheckpoint(snapshot);
      const merged = await store.merge(scope, {
        checkpoint: available,
        savedAtMs: Date.now(),
        ...(homeError instanceof SnapshotTooLargeError ? { homeDirty: live } : {}),
        checkpointBehindHome: undefined,
        recoveryError: undefined,
        retiredResources: stored.checkpoint
          ? retire(stored, { checkpoint: stored.checkpoint })
          : stored.retiredResources,
      });
      if (!merged) throw new Error(`Render sandbox checkpoint lost its scope: ${scope}`);
      saved = merged;
    } catch (error) {
      reportError("native_checkpoint_failed", error, scope);
      const failed = await store.merge(scope, {
        recoveryError: errMessage(error),
        ...(snapshot ? { retiredResources: retire(stored, { checkpoint: snapshot }) } : {}),
        ...(error instanceof RenderCheckpointUnconfirmedError
          ? { unconfirmedCheckpoints: unconfirmed(stored, error) }
          : {}),
      });
      if (homeError !== undefined) throw homeError;
      return failed ? cleanupRetired(scope, failed) : stored;
    }
    if (homeError !== undefined) reportError("home_backup_failed", homeError, scope);
    return cleanupRetired(scope, saved);
  }

  async function hasLiveProcesses(sandboxId: string): Promise<boolean> {
    const sessions = await createExecProcessSessions({
      async run(_handle, command, options) {
        const result = await client.runScript(sandboxId, command, Math.ceil((options?.timeoutMs ?? 30_000) / 1000));
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
    const info = stored ? await client.get(stored.sandboxId) : null;
    if (!stored || info?.status !== "running") return withUse(name, () => replace(scope, stored, info, onStatus));
    const running = stored;
    const rotated =
      info.expiresAtMs > Date.now() + rotationMarginMs
        ? null
        : await tryUse(name, async () =>
            (await hasLiveProcesses(info.id)) ? null : replace(scope, running, info, onStatus),
          );
    if (rotated) return rotated;
    await store.merge(scope, { lastActivityMs: Date.now() });
    return { coldStart: false };
  }

  async function replace(
    scope: string,
    stored: StoredRenderSandbox | null,
    info: RenderSandboxInfo | null,
    onStatus?: (text: string) => void,
  ): Promise<{ coldStart: boolean }> {
    let snapshotId: string | undefined;
    if (stored) {
      if (info?.status === "running") {
        stored = await checkpoint(scope, stored, false);
        await client.terminate(info.id);
      } else if (info?.status === "suspended") {
        await client.terminate(info.id);
      } else if (info && info.status !== "terminated" && info.status !== "errored") {
        throw new Error(`Render sandbox ${info.id} is ${info.status}; retry after its transition ends`);
      }
      if (stored.checkpoint && stored.checkpoint.expiresAtMs > Date.now()) {
        const snapshot = await client.getSnapshot(stored.checkpoint).catch((error) => {
          if (error instanceof RenderSnapshotGoneError) return null;
          throw error;
        });
        if (snapshot?.status === "available" && snapshot.expiresAtMs > Date.now()) snapshotId = snapshot.id;
      }
      if (!snapshotId && stored.homeCheckpointAtMs === undefined && (stored.homeDirty === true || stored.checkpoint)) {
        throw new Error(
          "Render sandbox is gone and has no durable home checkpoint. Import a recovery copy before replacing its home.",
        );
      }
    }
    const restoreHome =
      stored?.homeCheckpointAtMs !== undefined && (!snapshotId || stored.checkpointBehindHome === true);
    try {
      onStatus?.(stored ? "Restoring your computer…" : "Starting your computer…");
    } catch (error) {
      void error;
    }
    let started = await start(scope, stored, snapshotId, restoreHome, false);
    if (started === "stopped") started = await start(scope, stored, snapshotId, restoreHome, false);
    if (started !== "started") {
      snapshotId = undefined;
      await start(scope, stored, undefined, restoreHome, true);
    }
    return { coldStart: !stored || (!snapshotId && !restoreHome) };
  }

  async function start(
    scope: string,
    stored: StoredRenderSandbox | null,
    from: string | undefined,
    restoreHome: boolean,
    keepCheckpoint: boolean,
  ): Promise<"started" | "stopped" | "unextractable"> {
    const created = await client.create(from);
    try {
      if (created.expiresAtMs <= Date.now() + rotationMarginMs) {
        throw new Error("Render sandbox lifetime must exceed the command timeout by at least 60 seconds");
      }
      if (from) {
        const scrub = await client.runScript(created.id, `rm -rf /tmp/agent-creds ${shq(homeDir)}/.cred-state*`, 30);
        if (scrub.exitCode !== 0)
          throw new Error(`Render sandbox could not clear expired credentials: ${scrub.stderr}`);
      }
      if (restoreHome) {
        let hydrated: boolean;
        try {
          hydrated = await homeSnapshots.hydrateHome(scope, created.id, { replace: from !== undefined });
        } catch (error) {
          if (!from || !(error instanceof HomeExtractError)) throw error;
          reportError("home_restore_failed", error, scope);
          await client.terminate(created.id).catch(swallowAs("render-sandbox: discard untracked sandbox", undefined));
          return error.stopped ? "stopped" : "unextractable";
        }
        if (!hydrated && !from)
          throw new Error("Render sandbox home checkpoint is missing; refusing a blank replacement");
        if (!hydrated)
          reportError(
            "home_backup_missing",
            new Error("Render home backup is missing; the older native checkpoint is restored"),
            scope,
          );
      }
      await store.put(scope, {
        ...stored,
        sandboxId: created.id,
        expiresAtMs: created.expiresAtMs,
        lastActivityMs: Date.now(),
        ...(from || keepCheckpoint || !stored?.checkpoint
          ? {}
          : {
              checkpoint: undefined,
              checkpointBehindHome: undefined,
              retiredResources: retire(stored, { checkpoint: stored.checkpoint }),
            }),
      });
      return "started";
    } catch (error) {
      await client.terminate(created.id).catch(swallowAs("render-sandbox: discard untracked sandbox", undefined));
      throw error;
    }
  }

  async function destroyScope(scope: string): Promise<void> {
    const name = nameFor(scope);
    return withLifecycle(name, () =>
      withUse(name, async () => {
        const stored = await store.get(scope);
        if (!stored) return;
        await disposeResources(resourcesFor(stored));
        await opts.snapshots.delete?.(scope);
        const discarded: StoredRenderSandbox = {
          sandboxId: stored.sandboxId,
          discarded: true,
          expiresAtMs: stored.expiresAtMs,
          lastActivityMs: 0,
          retiredResources: stored.retiredResources,
          unconfirmedCheckpoints: stored.unconfirmedCheckpoints,
        };
        await store.put(scope, discarded);
        const cleaned = await cleanupRetired(scope, discarded);
        if (!cleaned.retiredResources?.length && !cleaned.unconfirmedCheckpoints?.length) await store.delete(scope);
      }),
    );
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
        await withUse(name, () => client.terminate(temporary.id));
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
      concurrentUse: true,
      concurrentProvision: true,
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
      return withLifecycle(name, async () => {
        const handle = await base.provision(layers, options);
        if (!handle.scratch) {
          const scope = scopeFor(handle.id);
          const stored = await store.get(scope);
          if (stored && stored.homeCheckpointAtMs === undefined && !recentlySaved(stored))
            await checkpoint(scope, stored);
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
      const name = nameFor(scope);
      await withLifecycle(name, () =>
        withUse(name, async () => {
          let previous = await store.get(scope);
          if (previous) previous = await recoverStored(scope, previous);
          const info = await client.create();
          const resources: RenderSandboxResources = { sandboxId: info.id };
          let published = false;
          const retainStaging = async (): Promise<void> => {
            const retiredResources = [...(previous?.retiredResources ?? []), { ...resources }];
            if (previous) {
              await store.merge(scope, { retiredResources });
            } else {
              await store.put(scope, {
                sandboxId: info.id,
                discarded: true,
                expiresAtMs: info.expiresAtMs,
                lastActivityMs: 0,
                retiredResources,
              });
            }
          };
          try {
            await retainStaging();
            await client.writeFileBytes(info.id, `${homeDir}/.qm-import.tar`, archive);
            const restored = await client.runScript(
              info.id,
              `mkdir -p ${shq(homeDir)} && tar -tf ${shq(homeDir)}/.qm-import.tar > /dev/null && tar -xf ${shq(homeDir)}/.qm-import.tar -C ${shq(homeDir)} && rm -f ${shq(homeDir)}/.qm-import.tar`,
              180,
            );
            if (restored.exitCode !== 0) throw new Error(`Render home import failed: ${restored.stderr}`);
            resources.checkpoint = await client.createSnapshot(info.id);
            await retainStaging();
            resources.checkpoint = await waitCheckpoint(resources.checkpoint);
            const imported: StoredRenderSandbox = {
              ...resources,
              sandboxId: info.id,
              expiresAtMs: info.expiresAtMs,
              lastActivityMs: Date.now(),
              ...(previous ? { retiredResources: [...(previous.retiredResources ?? []), resourcesFor(previous)] } : {}),
              ...(previous?.unconfirmedCheckpoints ? { unconfirmedCheckpoints: previous.unconfirmedCheckpoints } : {}),
            };
            await store.put(scope, imported);
            published = true;
            await homeSnapshots.snapshotHome(scope, info.id);
            const savedAtMs = Date.now();
            await store.merge(scope, { homeCheckpointAtMs: savedAtMs, savedAtMs, homeDirty: false });
            await cleanupRetired(scope, imported);
          } catch (error) {
            if (!published) {
              try {
                await retainStaging();
                let staged = (await store.get(scope))!;
                if (error instanceof RenderCheckpointUnconfirmedError)
                  staged = (await store.merge(scope, { unconfirmedCheckpoints: unconfirmed(staged, error) })) ?? staged;
                const cleaned = await cleanupRetired(scope, staged);
                if (
                  cleanupOnly(cleaned) &&
                  !cleaned.retiredResources?.length &&
                  !cleaned.unconfirmedCheckpoints?.length
                )
                  await store.delete(scope);
              } catch {
                await disposeResources(resources).catch(async (cleanupError) => {
                  await retainStaging();
                  await store.merge(scope, { retirementError: errMessage(cleanupError) });
                });
              }
            }
            throw error;
          }
        }),
      );
    },

    async persistHomeSnapshot(scope) {
      await withLifecycle(nameFor(scope), async () => {
        const stored = await store.get(scope);
        if (!stored) throw new Error(`Render sandbox is not provisioned: ${scope}`);
        await checkpoint(scope, stored);
      });
    },
    async teardown(handle, options) {
      if (handle.scratch) return withLifecycle(handle.id, () => base.teardown(handle, options));
      const scope = scopeFor(handle.id);
      if (options?.destroy) return destroyScope(scope);
      await withLifecycle(handle.id, async () => {
        let stored = await store.get(scope);
        if (!stored) return;
        if (!options?.homeUnchanged && stored.homeDirty !== true)
          stored = (await store.merge(scope, { homeDirty: true })) ?? stored;
        const bookkeeping = { lastSnapshotMs: stored.savedAtMs, homeDirty: stored.homeDirty };
        if (
          snapshotDue(bookkeeping, options, checkpointIntervalMs) ||
          (stored.homeDirty === true && stored.expiresAtMs <= Date.now() + expiryCheckpointWindowMs)
        )
          await checkpoint(scope, stored).catch((error) => reportError("teardown_checkpoint_failed", error, scope));
        await store.merge(scope, { lastActivityMs: Date.now() });
      });
    },
    async restartComputer(scope) {
      const name = nameFor(scope);
      await withLifecycle(name, async () => {
        const stored = await store.get(scope);
        if (!stored) return;
        const info = await client.get(stored.sandboxId);
        if (info?.status !== "running") return;
        await withUse(name, async () => {
          await checkpoint(scope, stored, await hasLiveProcesses(info.id));
          await client.terminate(info.id);
        });
      });
    },
    async reapDeepIdle(idleMs) {
      let reaped = 0;
      const cutoff = idleMs > 0 ? Date.now() - idleMs : -Infinity;
      const stale = (stored: StoredRenderSandbox): boolean => stored.homeDirty !== false && !recentlySaved(stored);
      const due = (stored: StoredRenderSandbox): boolean =>
        stored.expiresAtMs > Date.now() &&
        (stored.lastActivityMs <= cutoff ||
          stored.expiresAtMs <= Date.now() + expiryCheckpointWindowMs ||
          stale(stored));
      for (const [scope, candidate] of await store.entries()) {
        if (
          !due(candidate) &&
          !candidate.discarded &&
          !candidate.retiredResources?.length &&
          !candidate.unconfirmedCheckpoints?.length
        )
          continue;
        const name = nameFor(scope);
        await tryLock(lifecycleKey(name), async () => {
          let stored = await store.get(scope);
          if (stored) stored = await recoverStored(scope, stored);
          if (!stored || !due(stored)) return;
          const info = await client.get(stored.sandboxId);
          if (info?.status !== "running") return;
          const expiresSoon = info.expiresAtMs <= Date.now() + expiryCheckpointWindowMs;
          const rotate = info.expiresAtMs <= Date.now() + rotationMarginMs;
          const idle = stored.lastActivityMs <= cutoff;
          if (!expiresSoon && !idle && !stale(stored)) return;
          const active = await hasLiveProcesses(info.id);
          if (active && !expiresSoon && !stale(stored)) return;
          const save = (!active && (idle || rotate || stale(stored))) || !recentlySaved(stored);
          const current = stored;
          const stopped =
            !active &&
            (idle || rotate) &&
            (await tryUse(name, async () => {
              if (await hasLiveProcesses(info.id)) return false;
              if (save) await checkpoint(scope, current, false);
              await client.terminate(info.id);
              return true;
            }));
          if (stopped) reaped++;
          else if (save) await checkpoint(scope, stored, active || undefined);
        }).catch((error) => reportError("idle_checkpoint_failed", error, scope));
      }
      return { reaped };
    },
    async computerStatus(scope): Promise<ComputerStatus> {
      const stored = await store.get(scope);
      if (!stored) return { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
      if (cleanupOnly(stored))
        return {
          machine: "Render cleanup pending",
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
        const response = running ? await client.runScript(stored.sandboxId, "true", 10) : null;
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
