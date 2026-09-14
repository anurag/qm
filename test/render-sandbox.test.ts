import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderSandbox, type StoredRenderSandbox } from "../src/sandbox/render-sandbox.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createLocalBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createMemorySnapshotStore } from "../src/sandbox/home-snapshot.ts";
import type { RenderSnapshotStore } from "../src/sandbox/render-snapshot-store.ts";
import { makeTar } from "../src/sandbox/tar.ts";
import { collectBytes } from "../src/util/bytes.ts";
import { scopeId } from "../src/types.ts";
import { supportsAgentComputerExport, supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { createFakeRender } from "./support/fake-render.ts";

function createTestSnapshotStore(): RenderSnapshotStore {
  const deleted = new Set<string>();
  const base = createMemorySnapshotStore();
  return {
    ...base,
    async open(key) {
      return deleted.has(key) ? null : base.open(key);
    },
    async delete(key) {
      deleted.add(key);
    },
  };
}

async function readBackup(snapshots: RenderSnapshotStore, key: string): Promise<Buffer | null> {
  const backup = await snapshots.open(key);
  return backup ? (await collectBytes(backup.parts)).data : null;
}

function setup(t: { after(fn: () => void): void }) {
  const fake = createFakeRender();
  const dir = mkdtempSync(join(tmpdir(), "render-ws-"));
  const workspace = createLocalWorkspaceStore(dir);
  const blobTransfer = createLocalBlobTransferStore(join(dir, "blobs"));
  const store = createMemoryMap<StoredRenderSandbox>();
  const advisoryLock = createMemoryAdvisoryLock();
  const snapshots = createTestSnapshotStore();
  const make = (snapshotStore: RenderSnapshotStore = snapshots, checkpointIntervalMs = 0) =>
    createRenderSandbox(workspace, {
      client: fake.client,
      store,
      advisoryLock,
      blobTransfer,
      snapshots: snapshotStore,
      checkpointIntervalMs,
    });
  const scope = scopeId("personal", "tester");
  const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
  t.after(() => {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  return { fake, store, make, scope, layers, blobTransfer, snapshots, dir, workspace, advisoryLock };
}

test("Render provisions one durable sandbox across two cores and executes in its workspace", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const first = make();
  const second = make();
  const [a, b] = await Promise.all([
    first.provision(layers, { env: { QM_TEST_VALUE: "hello" } }),
    second.provision(layers),
  ]);
  assert.equal(fake.createdFrom.length, 1);
  assert.equal(a.id, b.id);
  assert.equal(first.profile.backend, "render");
  assert.equal(first.profile.writablePersistence, "provider_managed");
  assert.ok(supportsAgentComputerExport(first));
  assert.ok(supportsProcessSessions(first));
  assert.ok((await store.get(scope))?.checkpoint);
  const result = await first.run(a, "printf '%s\\n' \"$QM_TEST_VALUE\"; pwd; printf problem >&2; exit 7");
  assert.match(result.stdout, /^hello\n.*workspace\n$/);
  assert.equal(result.stderr, "problem");
  assert.equal(result.code, 7);
});

test("Render restores files from its checkpoint after sandbox expiry and a core restart", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const first = make();
  const handle = await first.provision(layers);
  await first.writeFile(handle, "nested/work.txt", "retained");
  await first.teardown(handle);
  const stored = (await store.get(scope))!;
  const checkpointId = stored.checkpoint!.id;
  await fake.client.terminate(stored.sandboxId);
  const second = make();
  const restored = await second.provision(layers);
  assert.equal(restored.coldStart, false);
  assert.equal(fake.createdFrom[1], checkpointId);
  assert.equal(await second.readFile(restored, "nested/work.txt"), "retained");
  assert.equal(await second.readFile(restored, "missing"), null);
  const binary = Buffer.from([0, 255, 4, 0, 128]);
  await second.writeFileBytes(restored, "binary", binary);
  assert.deepEqual(await second.readFileBytes(restored, "binary"), binary);
});

test("Render checkpoint failure leaves the source and last checkpoint intact", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  await sandbox.writeFile(handle, "new", "not checkpointed");
  fake.failCheckpoint(new Error("snapshot outage"));
  await sandbox.teardown(handle);
  const after = (await store.get(scope))!;
  assert.equal(after.checkpoint!.id, before.checkpoint!.id);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
  assert.equal(await sandbox.readFile(handle, "new"), "not checkpointed");
  assert.equal(after.recoveryError, "snapshot outage");
});

test("Render uses its durable home archive when a native checkpoint expires", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const source = make();
  const before = await source.provision(layers);
  await source.writeFile(before, "long-lived", "retained after expiry");
  await source.teardown(before);
  const stored = (await store.get(scope))!;
  fake.snapshots.get(stored.checkpoint!.id)!.expiresAtMs = Date.now() - 1;
  await fake.client.terminate(stored.sandboxId);
  const target = make();
  const restored = await target.provision(layers);
  assert.equal(await target.readFile(restored, "long-lived"), "retained after expiry");
  assert.equal(restored.coldStart, false);
  assert.equal(fake.createdFrom.length, 2);
  assert.equal(fake.createdFrom[1], undefined);
});

test("Render rotates a sandbox near expiry only after it saves a new checkpoint", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "new", "latest");
  const stored = (await store.get(scope))!;
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = Date.now() + 60_000;
  const rotated = await make().provision(layers);
  assert.equal(rotated.coldStart, false);
  assert.equal(await sandbox.readFile(rotated, "new"), "latest");
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
});

test("Render scratch sandboxes are shared only until the last handle is released", async (t) => {
  const { make, fake, layers, store } = setup(t);
  const sandbox = make();
  const a = await sandbox.provision(layers, { scratch: { key: "job" } });
  const b = await sandbox.provision(layers, { scratch: { key: "job" } });
  assert.equal(fake.createdFrom.length, 1);
  assert.equal((await store.entries()).length, 0);
  await sandbox.teardown(a);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "running");
  await sandbox.teardown(b);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
  assert.equal(fake.snapshots.size, 0);
});

test("Render destroys both the sandbox and its checkpoint", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.teardown(handle, { destroy: true });
  assert.equal(await store.get(scope), null);
  assert.equal(fake.snapshots.size, 0);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
});

test("Render imports a home archive and captures a native checkpoint", async (t) => {
  const { make, fake, layers, store, scope, blobTransfer } = setup(t);
  const sandbox = make();
  const tar = await makeTar([{ path: "workspace/imported", data: Buffer.from("imported home") }]);
  const blob = await blobTransfer.put(tar);
  await sandbox.adoptHomeSnapshot!(scope, blob.blobId);
  const handle = await sandbox.provision(layers);
  assert.equal(handle.coldStart, false);
  assert.equal(await sandbox.readFile(handle, "imported"), "imported home");
  const stored = (await store.get(scope))!;
  assert.ok(fake.snapshots.has(stored.checkpoint!.id));
});

test("Render does not replay a command when an exec call fails", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  await assert.rejects(sandbox.run(handle, "side-effect"), /no longer running/);
  assert.equal(fake.createdFrom.length, 1);
});

test("Render restores the latest portable backup after a native checkpoint fails", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "latest", "new work");
  fake.failCheckpoint(new Error("native snapshot unavailable"));
  await sandbox.teardown(handle);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  fake.failCheckpoint();
  const target = make();
  const restored = await target.provision(layers);
  assert.equal(await target.readFile(restored, "latest"), "new work");
  assert.equal(fake.createdFrom[1], undefined);
});

test("Render clears expired temporary credentials after a native restore", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const source = make();
  const handle = await source.provision(layers);
  await fake.client.writeFileBytes(
    (await store.get(scope))!.sandboxId,
    "/root/.cred-state-secret",
    Buffer.from("expired"),
  );
  await source.teardown(handle);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  const target = make();
  await target.provision(layers);
  assert.equal(await fake.client.readFileBytes((await store.get(scope))!.sandboxId, "/root/.cred-state-secret"), null);
});

test("Render recovers from an expired pending native checkpoint with the durable home", async (t) => {
  const { make, fake, layers, store, scope, snapshots } = setup(t);
  await snapshots.put("backup-key", await makeTar([{ path: "workspace/recovered", data: Buffer.from("retained") }]));
  await store.put(scope, {
    sandboxId: "sbx-missing",
    createdAtMs: Date.now() - 7200_000,
    expiresAtMs: Date.now() - 1,
    lastActivityMs: Date.now() - 7200_000,
    homeCheckpointAtMs: Date.now() - 3600_000,
    homeSnapshotKey: "backup-key",
    checkpointCurrent: false,
    pendingCheckpoint: { id: "snp-gone", sandboxGroupId: "sbg-test", status: "available", expiresAtMs: Date.now() - 1 },
  });
  const target = make();
  const restored = await target.provision(layers);
  assert.equal(await target.readFile(restored, "recovered"), "retained");
  assert.equal(fake.createdFrom[0], undefined);
  assert.equal((await store.get(scope))?.homeSnapshotKey, "backup-key");
});

test("Render refuses a stale local backup when another core publishes a newer home", async (t) => {
  const { make, fake, layers, store, scope, snapshots } = setup(t);
  const otherSnapshots = createTestSnapshotStore();
  const first = make();
  const original = await first.provision(layers);
  await first.writeFile(original, "work", "old value");
  await first.teardown(original);
  const oldKey = (await store.get(scope))!.homeSnapshotKey!;
  const second = make(otherSnapshots);
  const current = await second.provision(layers);
  await second.writeFile(current, "work", "new value");
  await second.teardown(current);
  const stored = (await store.get(scope))!;
  assert.notEqual(stored.homeSnapshotKey, oldKey);
  assert.ok(await readBackup(snapshots, oldKey));
  assert.equal(await snapshots.open(stored.homeSnapshotKey!), null);
  assert.ok(await readBackup(otherSnapshots, stored.homeSnapshotKey!));
  fake.snapshots.get(stored.checkpoint!.id)!.expiresAtMs = Date.now() - 1;
  await fake.client.terminate(stored.sandboxId);
  await assert.rejects(first.provision(layers), /home checkpoint is missing/);
  const restored = await second.provision(layers);
  assert.equal(await second.readFile(restored, "work"), "new value");
});

test("Render keeps the original body and backup when import checkpoint creation fails", async (t) => {
  const { make, fake, layers, store, scope, blobTransfer, snapshots } = setup(t);
  const source = make();
  const handle = await source.provision(layers);
  await source.writeFile(handle, "work", "original value");
  await source.teardown(handle);
  const before = (await store.get(scope))!;
  const blob = await blobTransfer.put(await makeTar([{ path: "workspace/work", data: Buffer.from("replacement") }]));
  fake.failCheckpoint(new Error("native snapshot outage"));
  await assert.rejects(source.adoptHomeSnapshot!(scope, blob.blobId), /native snapshot outage/);
  assert.deepEqual(await store.get(scope), before);
  assert.equal(await source.readFile(handle, "work"), "original value");
  assert.ok(await readBackup(snapshots, before.homeSnapshotKey!));
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
  assert.equal(fake.sandboxes.get("sbx-2")?.status, "terminated");
  assert.equal(fake.snapshots.size, 1);
});

test("Render retains old-body cleanup after an import and retries it from another core", async (t) => {
  const { make, fake, layers, store, scope, blobTransfer, snapshots } = setup(t);
  const source = make();
  await source.provision(layers);
  const before = (await store.get(scope))!;
  fake.failTerminate(new Error("terminate outage"), before.sandboxId);
  const blob = await blobTransfer.put(await makeTar([{ path: "workspace/work", data: Buffer.from("replacement") }]));
  await source.adoptHomeSnapshot!(scope, blob.blobId);
  const published = (await store.get(scope))!;
  assert.notEqual(published.sandboxId, before.sandboxId);
  assert.equal(published.retiredResources?.[0]?.sandboxId, before.sandboxId);
  assert.equal(published.retirementError, "terminate outage");
  assert.ok(await readBackup(snapshots, before.homeSnapshotKey!));
  fake.failTerminate(undefined, before.sandboxId);
  const next = make();
  const handle = await next.provision(layers);
  assert.equal(await next.readFile(handle, "work"), "replacement");
  assert.equal((await store.get(scope))!.retiredResources, undefined);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
  assert.equal(await snapshots.open(before.homeSnapshotKey!), null);
});

test("Render keeps a running process during monitor provisioning near sandbox expiry", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const source = make();
  await source.provision(layers);
  const stored = (await store.get(scope))!;
  const processPath = "/root/.agent-proc/11111111-1111-1111-1111-111111111111";
  await fake.client.writeFileBytes(stored.sandboxId, `${processPath}/cmd`, Buffer.from("long-running-work"));
  await fake.client.writeFileBytes(stored.sandboxId, `${processPath}/started`, Buffer.from("1"));
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = Date.now() + 650_000;
  const monitor = make();
  await monitor.provision(layers);
  assert.equal(fake.createdFrom.length, 1);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  await fake.client.writeFileBytes(stored.sandboxId, `${processPath}/code`, Buffer.from("0"));
  await monitor.provision(layers);
  assert.equal(fake.createdFrom.length, 2);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
});

test("Render retains an old backup after deletion fails and removes it when the scope is destroyed", async (t) => {
  const { make, fake, layers, store, scope, snapshots } = setup(t);
  let blockedKey: string | undefined;
  const sandbox = make({
    ...snapshots,
    async delete(key) {
      if (key === blockedKey) throw new Error("archive delete outage");
      await snapshots.delete!(key);
    },
  });
  const handle = await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  blockedKey = before.homeSnapshotKey;
  await sandbox.writeFile(handle, "work", "latest value");
  await sandbox.teardown(handle);
  const after = (await store.get(scope))!;
  assert.notEqual(after.homeSnapshotKey, before.homeSnapshotKey);
  assert.deepEqual(after.retiredResources?.[0], { homeSnapshotKey: before.homeSnapshotKey });
  assert.equal(after.retirementError, "archive delete outage");
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
  assert.equal(await sandbox.readFile(handle, "work"), "latest value");
  assert.ok(await readBackup(snapshots, before.homeSnapshotKey!));
  await assert.rejects(sandbox.destroyScope!(scope), /archive delete outage/);
  assert.ok(await store.get(scope));
  blockedKey = undefined;
  await sandbox.destroyScope!(scope);
  assert.equal(await store.get(scope), null);
  assert.equal(await snapshots.open(before.homeSnapshotKey!), null);
  assert.equal(await snapshots.open(after.homeSnapshotKey!), null);
  assert.equal(fake.snapshots.size, 0);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
});

test("Render retains failed first-import cleanup and never provisions its discarded sandbox", async (t) => {
  const { make, fake, layers, store, scope, blobTransfer, snapshots } = setup(t);
  const sandbox = make();
  const blob = await blobTransfer.put(await makeTar([{ path: "workspace/work", data: Buffer.from("discarded") }]));
  fake.failCheckpoint(new Error("native snapshot outage"));
  fake.failTerminate(new Error("terminate outage"), "sbx-1");
  await assert.rejects(sandbox.adoptHomeSnapshot!(scope, blob.blobId), /native snapshot outage/);
  const discarded = (await store.get(scope))!;
  assert.equal(discarded.discarded, true);
  assert.equal(discarded.retiredResources?.[0]?.sandboxId, "sbx-1");
  assert.equal(discarded.retirementError, "terminate outage");
  const stagedKey = discarded.retiredResources![0]!.homeSnapshotKey!;
  assert.ok(await readBackup(snapshots, stagedKey));
  assert.equal((await sandbox.computerStatus!(scope)).provisioned, false);
  await assert.rejects(make().provision(layers), /import cleanup is incomplete/);
  await assert.rejects(sandbox.persistHomeSnapshot!(scope), /not provisioned/);
  assert.equal(fake.createdFrom.length, 1);
  fake.failCheckpoint();
  fake.failTerminate(undefined, "sbx-1");
  const next = make();
  const handle = await next.provision(layers);
  assert.equal(handle.coldStart, true);
  assert.equal(await next.readFile(handle, "work"), null);
  assert.equal((await store.get(scope))!.discarded, undefined);
  assert.equal((await store.get(scope))!.retiredResources, undefined);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
  assert.equal(await snapshots.open(stagedKey), null);
});

test("Render cleans a first-import native checkpoint when its staging record write fails", async (t) => {
  const { make, fake, store, scope, blobTransfer } = setup(t);
  const put = store.put;
  let failed = false;
  store.put = async (key, value) => {
    if (!failed && value.discarded && value.retiredResources?.some((resource) => resource.checkpoint)) {
      failed = true;
      throw new Error("checkpoint record outage");
    }
    await put(key, value);
  };
  const blob = await blobTransfer.put(await makeTar([{ path: "workspace/work", data: Buffer.from("discarded") }]));
  await assert.rejects(make().adoptHomeSnapshot!(scope, blob.blobId), /checkpoint record outage/);
  assert.equal(await store.get(scope), null);
  assert.equal(fake.snapshots.size, 0);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
});

test("Render cleans an import after the first staging write fails over an existing home", async (t) => {
  const { make, fake, layers, store, scope, blobTransfer } = setup(t);
  const sandbox = make();
  await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  const merge = store.merge;
  let failed = false;
  store.merge = async (key, patch) => {
    if (!failed && patch.retiredResources?.some((resource) => resource.sandboxId === "sbx-2")) {
      failed = true;
      throw new Error("staging record outage");
    }
    return merge(key, patch);
  };
  const blob = await blobTransfer.put(await makeTar([{ path: "workspace/work", data: Buffer.from("discarded") }]));
  await assert.rejects(sandbox.adoptHomeSnapshot!(scope, blob.blobId), /staging record outage/);
  assert.deepEqual(await store.get(scope), before);
  assert.equal(fake.snapshots.size, 1);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
  assert.equal(fake.sandboxes.get("sbx-2")?.status, "terminated");
});

test("Render retains a new native checkpoint when its pending record write fails", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const info = await fake.client.create();
  await store.put(scope, {
    sandboxId: info.id,
    createdAtMs: Date.now(),
    expiresAtMs: info.expiresAtMs,
    lastActivityMs: Date.now(),
  });
  const merge = store.merge;
  let failed = false;
  store.merge = async (key, patch) => {
    if (!failed && patch.pendingCheckpoint) {
      failed = true;
      throw new Error("pending record outage");
    }
    return merge(key, patch);
  };
  const sandbox = make();
  await sandbox.persistHomeSnapshot!(scope);
  const stored = (await store.get(scope))!;
  assert.equal(stored.recoveryError, "pending record outage");
  assert.equal(stored.pendingCheckpoint?.id, [...fake.snapshots.keys()][0]);
  assert.equal(fake.snapshots.size, 1);
  await sandbox.destroyScope!(scope);
  assert.equal(fake.snapshots.size, 0);
  assert.equal(await store.get(scope), null);
});

test("Render saves portable files before it replaces a pending native snapshot", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  const pending = await fake.client.createSnapshot(stored.sandboxId);
  await store.merge(scope, { pendingCheckpoint: { ...pending, status: "creating" } });
  await sandbox.writeFile(handle, "work", "after pending snapshot");
  fake.failCheckpoint(new Error("native snapshot unavailable"));
  await sandbox.teardown(handle);
  assert.ok((await store.get(scope))!.homeSnapshotKey);
  assert.equal(fake.snapshots.has(pending.id), false);
  await fake.client.terminate(stored.sandboxId);
  const restored = await make().provision(layers);
  assert.equal(await sandbox.readFile(restored, "work"), "after pending snapshot");
});

test("Render checkpoints background changes before TTL even when idle reaping is disabled", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make(undefined, 5 * 60_000);
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  const processPath = "/root/.agent-proc/11111111-1111-1111-1111-111111111111";
  await fake.client.writeFileBytes(stored.sandboxId, `${processPath}/cmd`, Buffer.from("background work"));
  await fake.client.writeFileBytes(stored.sandboxId, `${processPath}/started`, Buffer.from("1"));
  await sandbox.writeFile(handle, "background", "retained output");
  const expiresAtMs = Date.now() + 16 * 60_000;
  await store.merge(scope, { homeCheckpointAtMs: Date.now() - 360_000, expiresAtMs });
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = expiresAtMs;
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  const checkpointKey = (await store.get(scope))!.homeSnapshotKey;
  assert.notEqual(checkpointKey, stored.homeSnapshotKey);
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal((await store.get(scope))!.homeSnapshotKey, checkpointKey);
  await fake.client.terminate(stored.sandboxId);
  const other = make();
  const restored = await other.provision(layers);
  assert.equal(await other.readFile(restored, "background"), "retained output");
});

for (const operation of ["file import", "provision preparation"] as const) {
  test(`Render completes ${operation} before another core checkpoints and expires its sandbox`, async (t) => {
    const { make, fake, layers, store, scope, workspace, advisoryLock } = setup(t);
    const sandbox = make();
    const other = make();
    const handle = await sandbox.provision(layers);
    const stored = (await store.get(scope))!;
    const layerScope = scopeId("personal", "reference");
    await workspace.write(layerScope, "latest", "completed operation");
    const uploading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const archivePath = operation === "file import" ? "/.extract.tar" : "/.ro-layers.tar";
    const write = fake.client.writeFileBytes;
    fake.client.writeFileBytes = async (id, path, data) => {
      await write(id, path, data);
      if (path.endsWith(archivePath)) {
        uploading.resolve();
        await release.promise;
      }
    };
    const pending =
      operation === "file import"
        ? sandbox.importFiles!(handle, [{ path: "latest", data: Buffer.from("completed operation") }])
        : sandbox.provision([...layers, { scopeId: layerScope, mountPath: "", mode: "ro" }]);
    await uploading.promise;
    const expiresAtMs = Date.now() + 60_000;
    fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = expiresAtMs;
    await store.merge(scope, { expiresAtMs });
    let reaped = false;
    const reaping = other.reapDeepIdle!(0).then((result) => {
      reaped = true;
      return result;
    });
    try {
      assert.equal(await advisoryLock.tryWithLock!(`render-sandbox:${handle.id}`, async () => true), null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reaped, false);
      assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
    } finally {
      release.resolve();
      await pending;
      await reaping;
    }
    assert.deepEqual(await reaping, { reaped: 1 });
    assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
    const restored = await other.provision(layers);
    assert.equal(await other.readFile(restored, "latest"), "completed operation");
  });
}

test("Render skips remote probes and checkpoints for a recently used sandbox", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(layers);
  await store.merge(scope, { homeCheckpointAtMs: Date.now() - 360_000 });
  const before = (await store.get(scope))!;
  const get = t.mock.method(fake.client, "get");
  const commands = fake.commands.length;
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal(get.mock.callCount(), 0);
  assert.equal(fake.commands.length, commands);
  assert.equal((await store.get(scope))!.homeSnapshotKey, before.homeSnapshotKey);
  await make().provision(layers);
  assert.ok(fake.commands.slice(commands).every((command) => !command.includes(".agent-proc")));
  assert.equal((await store.get(scope))!.homeSnapshotKey, before.homeSnapshotKey);
});

test("Render leaves an idle sandbox with a running process alone until its TTL is near", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  const processPath = "/root/.agent-proc/11111111-1111-1111-1111-111111111111";
  await fake.client.writeFileBytes(before.sandboxId, `${processPath}/cmd`, Buffer.from("background work"));
  await fake.client.writeFileBytes(before.sandboxId, `${processPath}/started`, Buffer.from("1"));
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000, homeCheckpointAtMs: Date.now() - 360_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal((await store.get(scope))!.homeSnapshotKey, before.homeSnapshotKey);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
});

test("Render records command and file activity without a write for each operation", async (t) => {
  const { make, layers, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await store.merge(scope, { lastActivityMs: now - 7200_000 });
  const merge = t.mock.method(store, "merge");
  await sandbox.run(handle, "true");
  await sandbox.writeFile(handle, "activity", "retained");
  assert.equal(await sandbox.readFile(handle, "activity"), "retained");
  assert.equal((await store.get(scope))!.lastActivityMs, now);
  assert.equal(merge.mock.callCount(), 1);
  assert.deepEqual(await make().reapDeepIdle!(3600_000), { reaped: 0 });
  now += 60_000;
  assert.equal(await sandbox.readFile(handle, "activity"), "retained");
  assert.equal((await store.get(scope))!.lastActivityMs, now);
  assert.equal(merge.mock.callCount(), 2);
});

test("Render rechecks activity after it waits for a sandbox operation", async (t) => {
  const { make, fake, layers, store, scope, advisoryLock } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = advisoryLock.withLock(`render-sandbox:${handle.id}`, async () => {
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const listed = Promise.withResolvers<void>();
  const entries = store.entries;
  t.mock.method(store, "entries", async () => {
    const result = await entries();
    listed.resolve();
    return result;
  });
  const get = t.mock.method(fake.client, "get");
  const reaping = sandbox.reapDeepIdle!(3600_000);
  await listed.promise;
  await store.merge(scope, { lastActivityMs: Date.now() });
  release.resolve();
  await holding;
  assert.deepEqual(await reaping, { reaped: 0 });
  assert.equal(get.mock.callCount(), 0);
});

test("Render saves a home before the rotation window without stopping its sandbox", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "latest", "retained before rotation");
  const before = (await store.get(scope))!;
  const expiresAtMs = Date.now() + 16 * 60_000;
  fake.sandboxes.get(before.sandboxId)!.expiresAtMs = expiresAtMs;
  await store.merge(scope, { homeCheckpointAtMs: Date.now() - 360_000, expiresAtMs });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.notEqual((await store.get(scope))!.homeSnapshotKey, before.homeSnapshotKey);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
  const rotationExpiresAtMs = Date.now() + 10 * 60_000;
  fake.sandboxes.get(before.sandboxId)!.expiresAtMs = rotationExpiresAtMs;
  await store.merge(scope, { expiresAtMs: rotationExpiresAtMs });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 1 });
  const next = make();
  const restored = await next.provision(layers);
  assert.equal(await next.readFile(restored, "latest"), "retained before rotation");
});

test("Render checkpoints at teardown once per interval and skips an unused computer", async (t) => {
  const { make, layers, store, scope } = setup(t);
  const sandbox = make(undefined, 5 * 60_000);
  const handle = await sandbox.provision(layers);
  const initial = (await store.get(scope))!.homeSnapshotKey;
  await sandbox.writeFile(handle, "recent", "written within the interval");
  await sandbox.teardown(handle, { keepWarm: true });
  assert.equal((await store.get(scope))!.homeSnapshotKey, initial);
  await store.merge(scope, { homeCheckpointAtMs: Date.now() - 6 * 60_000 });
  await sandbox.teardown(handle, { keepWarm: true });
  const afterWrite = (await store.get(scope))!.homeSnapshotKey;
  assert.notEqual(afterWrite, initial);
  await store.merge(scope, { homeCheckpointAtMs: Date.now() - 6 * 60_000 });
  await sandbox.teardown(handle, { homeUnchanged: true });
  assert.equal((await store.get(scope))!.homeSnapshotKey, afterWrite);
  await sandbox.teardown(handle);
  assert.notEqual((await store.get(scope))!.homeSnapshotKey, afterWrite);
});

test("Render leaves scopes whose sandbox already expired alone until they are provisioned again", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(layers);
  await store.merge(scope, { expiresAtMs: Date.now() - 1, lastActivityMs: Date.now() - 7200_000 });
  const get = t.mock.method(fake.client, "get");
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal(get.mock.callCount(), 0);
});

test("Render reaper checkpoints changes a throttled teardown left behind", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make(undefined, 5 * 60_000);
  const handle = await sandbox.provision(layers);
  const initial = (await store.get(scope))!;
  await sandbox.writeFile(handle, "late", "written after the checkpoint");
  await sandbox.teardown(handle, { keepWarm: true });
  assert.equal((await store.get(scope))!.homeSnapshotKey, initial.homeSnapshotKey);
  assert.equal((await store.get(scope))!.homeDirty, true);
  await store.merge(scope, { homeCheckpointAtMs: Date.now() - 6 * 60_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  const saved = (await store.get(scope))!;
  assert.notEqual(saved.homeSnapshotKey, initial.homeSnapshotKey);
  assert.equal(saved.homeDirty, false);
  assert.equal(fake.sandboxes.get(initial.sandboxId)?.status, "running");
  await store.merge(scope, { homeCheckpointAtMs: Date.now() - 6 * 60_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal((await store.get(scope))!.homeSnapshotKey, saved.homeSnapshotKey);
});
