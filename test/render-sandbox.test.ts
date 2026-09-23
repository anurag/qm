import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderSandbox, type StoredRenderSandbox } from "../src/sandbox/render-sandbox.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createLocalBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import {
  createMemorySnapshotStore,
  SnapshotTooLargeError,
  type HomeSnapshotStore,
} from "../src/sandbox/home-snapshot.ts";
import { makeTar } from "../src/sandbox/tar.ts";
import { collectBytes } from "../src/util/bytes.ts";
import { scopeId } from "../src/types.ts";
import { supportsAgentComputerExport, supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { pollProcess } from "../src/sandbox/process-poll.ts";
import { createSdkRenderClient } from "../src/sandbox/render-client.ts";
import { createSandboxResources } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter, type SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import { createFakeRender, serveFakeRenderApi } from "./support/fake-render.ts";

async function readBackup(snapshots: HomeSnapshotStore, key: string): Promise<Buffer | null> {
  const backup = await snapshots.open(key);
  return backup ? (await collectBytes(backup.parts)).data : null;
}

function setup(
  t: TestContext,
  options: { http?: boolean; intercept?: (request: Request) => Response | undefined } = {},
) {
  const fake = createFakeRender();
  const http = options.http ? serveFakeRenderApi(t, fake, options.intercept) : undefined;
  const client = http ? createSdkRenderClient({ apiKey: "render-test-key", workspaceId: "tea-test" }) : fake.client;
  const dir = mkdtempSync(join(tmpdir(), "render-ws-"));
  const workspace = createLocalWorkspaceStore(dir);
  const blobTransfer = createLocalBlobTransferStore(join(dir, "blobs"));
  const store = createMemoryMap<StoredRenderSandbox>();
  const advisoryLock = createMemoryAdvisoryLock();
  const snapshots = createMemorySnapshotStore();
  const errors: Array<{ code: string; message: string }> = [];
  const make = (snapshotStore: HomeSnapshotStore = snapshots, checkpointIntervalMs = -1) =>
    createRenderSandbox(workspace, {
      client,
      store,
      advisoryLock,
      blobTransfer,
      snapshots: snapshotStore,
      checkpointIntervalMs,
      onError: (error) => errors.push({ code: error.code, message: error.message }),
    });
  const scope = scopeId("personal", "tester");
  const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
  t.after(() => {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  return { fake, http, store, make, scope, layers, blobTransfer, snapshots, dir, workspace, advisoryLock, errors };
}

const processPath = "/root/.agent-proc/11111111-1111-1111-1111-111111111111";
async function startBackgroundProcess(fake: ReturnType<typeof createFakeRender>, sandboxId: string): Promise<void> {
  await fake.client.writeFileBytes(sandboxId, `${processPath}/cmd`, Buffer.from("background work"));
  await fake.client.writeFileBytes(sandboxId, `${processPath}/started`, Buffer.from("1"));
}
const finishBackgroundProcess = (fake: ReturnType<typeof createFakeRender>, sandboxId: string): Promise<void> =>
  fake.client.writeFileBytes(sandboxId, `${processPath}/code`, Buffer.from("0"));

test("Render keeps turn and background process secrets out of run token requests and runs scripts past the argument limit", async (t) => {
  const { make, http, layers } = setup(t, { http: true });
  const sandbox = make();
  const turnSecret = "turn-secret-8d1f";
  const processSecret = "process-secret-2c7a";
  const handle = await sandbox.provision(layers, { env: { QM_TURN_TOKEN: turnSecret } });
  assert.equal((await sandbox.run(handle, 'printf %s "$QM_TURN_TOKEN"')).stdout, turnSecret);
  const payload = "y".repeat(200 * 1024);
  assert.equal(
    (await sandbox.run(handle, `payload='${payload}'; printf %s "\${#payload}"`)).stdout,
    String(payload.length),
  );
  assert.ok(supportsProcessSessions(sandbox));
  const { processId } = await sandbox.startProcess(handle, 'printf %s "$QM_PROCESS_TOKEN:$QM_TURN_TOKEN"', {
    env: { QM_PROCESS_TOKEN: processSecret },
  });
  const { output, status } = await pollProcess(sandbox, handle, processId, { deadlineMs: 20_000, waitMs: 100 });
  assert.deepEqual(status, { state: "exited", code: 0 });
  assert.equal(output, `${processSecret}:${turnSecret}`);
  const runs = http!.tokenRequests.filter((request) => request.operation === "stream");
  assert.ok(runs.length > 3);
  for (const request of http!.tokenRequests) {
    for (const value of [turnSecret, processSecret, payload.slice(0, 64), "export "])
      assert.equal(request.body.includes(value), false, `${request.operation} token request carried ${value}`);
  }
  for (const request of runs) {
    const { command } = JSON.parse(request.body) as { command: string };
    assert.match(command, /^(timeout \d+ sh '\/dev\/\.qm-run\/[0-9a-f-]{36}\.sh'|test -f '[^']+'|mkdir -p '[^']+')$/);
  }
});

test("Render resumes from its native checkpoint through transient API errors and sends a failed exec once", async (t) => {
  const failures: Array<{ method: string; path: RegExp; status: number }> = [];
  const injected: string[] = [];
  const { make, fake, http, layers, store, scope } = setup(t, {
    http: true,
    intercept: (request) => {
      const url = new URL(request.url);
      const index = failures.findIndex((item) => item.method === request.method && item.path.test(url.pathname));
      if (index < 0) return undefined;
      const [failure] = failures.splice(index, 1);
      injected.push(`${failure!.status} ${request.method} ${url.pathname}`);
      return Response.json({ message: "transient" }, { status: failure!.status, headers: { "retry-after": "0" } });
    },
  });
  const sandbox = make();
  await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  const checkpoint = stored.checkpoint!.id;
  await fake.client.terminate(stored.sandboxId);
  failures.push(
    { method: "GET", path: new RegExp(`^/v1/sandboxes/${stored.sandboxId}$`), status: 503 },
    { method: "GET", path: new RegExp(`/snapshots/${checkpoint}$`), status: 429 },
  );
  const resumed = await sandbox.provision(layers);
  assert.equal((await sandbox.run(resumed, "echo resumed")).stdout, "resumed\n");
  assert.deepEqual(injected, [
    `503 GET /v1/sandboxes/${stored.sandboxId}`,
    `429 GET /v1/sandbox-groups/sbg-test/snapshots/${checkpoint}`,
  ]);
  assert.equal(fake.createdFrom.at(-1), checkpoint);
  const runs = () => http!.tokenRequests.filter((request) => request.operation === "stream");
  const before = runs().length;
  failures.push({ method: "POST", path: /\/runs\/stream\/token$/, status: 503 });
  await assert.rejects(sandbox.run(resumed, "touch /root/workspace/never-created"), /transient/);
  assert.equal(injected.filter((entry) => entry.startsWith("503 POST")).length, 1);
  assert.deepEqual(
    runs()
      .slice(before)
      .map((request) => (JSON.parse(request.body) as { command: string }).command.split(" ").slice(0, 2).join(" ")),
    ["rm -f"],
  );
  assert.equal(
    await fake.client.readFileBytes((await store.get(scope))!.sandboxId, "/root/workspace/never-created"),
    null,
  );
});

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

test("Render checkpoint failure keeps the sandbox running and its last native checkpoint until a new one exists", async (t) => {
  const { make, fake, layers, store, scope, snapshots } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  await sandbox.writeFile(handle, "new", "not checkpointed");
  fake.failCheckpoint(new Error("snapshot outage"));
  await sandbox.teardown(handle);
  const after = (await store.get(scope))!;
  assert.equal(after.checkpoint?.id, before.checkpoint!.id);
  assert.equal(after.checkpointBehindHome, true);
  assert.equal(fake.snapshots.has(before.checkpoint!.id), true);
  assert.ok(await readBackup(snapshots, scope));
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
  assert.equal(await sandbox.readFile(handle, "new"), "not checkpointed");
  assert.equal(after.recoveryError, "snapshot outage");
  fake.failCheckpoint();
  await sandbox.teardown(handle);
  const recovered = (await store.get(scope))!;
  assert.notEqual(recovered.checkpoint!.id, before.checkpoint!.id);
  assert.equal(recovered.checkpointBehindHome, undefined);
  assert.equal(recovered.recoveryError, undefined);
  assert.equal(fake.snapshots.has(before.checkpoint!.id), false);
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
  assert.deepEqual(
    (await store.get(scope))!.retiredResources?.map((resources) => resources.checkpoint?.id),
    [stored.checkpoint!.id],
  );
  await target.teardown(restored);
  assert.ok(fake.deleted.includes(stored.checkpoint!.id));
  assert.equal((await store.get(scope))!.retiredResources, undefined);
});

for (const native of ["expired", "missing"])
  test(`Render restores a newer home archive when its native checkpoint is ${native}`, async (t) => {
    const { make, fake, layers, store, scope, snapshots } = setup(t);
    await make().provision(layers);
    const stored = (await store.get(scope))!;
    await snapshots.put(scope, await makeTar([{ path: "workspace/retained", data: Buffer.from("newer backup") }]));
    if (native === "expired") fake.snapshots.get(stored.checkpoint!.id)!.expiresAtMs = Date.now() - 1;
    else await fake.client.deleteSnapshot(stored.checkpoint!);
    await fake.client.terminate(stored.sandboxId);
    const target = make();
    const restored = await target.provision(layers);
    assert.equal(restored.coldStart, false);
    assert.equal(await target.readFile(restored, "retained"), "newer backup");
    assert.equal(fake.createdFrom[1], undefined);
    await target.teardown(restored);
    assert.ok(await readBackup(snapshots, scope));
    assert.equal(fake.snapshots.has(stored.checkpoint!.id), false);
    await target.destroyScope!(scope);
    assert.equal(await readBackup(snapshots, scope), null);
  });

test("Render keeps a native checkpoint when the home backup fails and reports a teardown that saves nothing", async (t) => {
  const { make, fake, layers, snapshots, errors, store, scope } = setup(t);
  let uploads = 0;
  const failing: HomeSnapshotStore = {
    ...snapshots,
    createUpload: async (key) => {
      if (uploads++) throw new Error("archive store outage");
      return snapshots.createUpload(key);
    },
  };
  const sandbox = make(failing);
  const handle = await sandbox.provision(layers);
  const before = (await store.get(scope))!.checkpoint!.id;
  await sandbox.writeFile(handle, "later", "unsaved");
  await sandbox.teardown(handle);
  assert.deepEqual(errors, [{ code: "home_backup_failed", message: "archive store outage" }]);
  const saved = (await store.get(scope))!;
  assert.equal(saved.homeDirty, true);
  assert.notEqual(saved.checkpoint!.id, before);
  assert.equal(saved.checkpointBehindHome, undefined);
  errors.length = 0;
  fake.failCheckpoint(new Error("snapshot outage"));
  await sandbox.teardown(handle);
  assert.deepEqual(errors, [
    { code: "native_checkpoint_failed", message: "snapshot outage" },
    { code: "teardown_checkpoint_failed", message: "archive store outage" },
  ]);
  assert.equal((await store.get(scope))!.checkpoint!.id, saved.checkpoint!.id);
});

test("Render replaces a suspended sandbox from its checkpoint", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "kept", "before suspension");
  await sandbox.teardown(handle);
  const stored = (await store.get(scope))!;
  fake.sandboxes.get(stored.sandboxId)!.status = "suspended";
  const restored = await make().provision(layers);
  assert.equal(restored.coldStart, false);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
  assert.equal(fake.createdFrom[1], stored.checkpoint!.id);
  assert.equal(await sandbox.readFile(restored, "kept"), "before suspension");
});

test("Render starts a blank replacement for a sandbox that never saved a home", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  await make().provision(layers);
  const stored = (await store.get(scope))!;
  await store.put(scope, { sandboxId: stored.sandboxId, expiresAtMs: stored.expiresAtMs, lastActivityMs: 0 });
  await fake.client.terminate(stored.sandboxId);
  const replaced = await make().provision(layers);
  assert.equal(replaced.coldStart, true);
  assert.equal(fake.createdFrom[1], undefined);
  assert.ok((await store.get(scope))!.checkpoint);
});

function blockCommands(fake: ReturnType<typeof createFakeRender>) {
  const gate = Promise.withResolvers<void>();
  const run = fake.client.runScript;
  fake.client.runScript = async (id, script, timeoutSec) => {
    if (script.includes("blocked-command")) await gate.promise;
    return run(id, script, timeoutSec);
  };
  return gate;
}

test(
  "Render lets other turns provision, tear down, and checkpoint during a command and restarts after it ends",
  { timeout: 60_000 },
  async (t) => {
    const { make, fake, layers, store, scope, advisoryLock } = setup(t);
    const sandbox = make();
    const handle = await sandbox.provision(layers);
    const gate = blockCommands(fake);
    const blocked = sandbox.run(handle, "echo blocked-command");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await advisoryLock.tryWithLock!(`render-sandbox-use:${handle.id}`, async () => true), null);
    assert.equal((await sandbox.run(handle, "echo concurrent")).stdout, "concurrent\n");
    const before = (await store.get(scope))!;
    const other = make();
    const second = await other.provision(layers);
    await other.writeFile(second, "second-turn", "saved");
    await other.teardown(second);
    assert.equal((await store.get(scope))!.homeDirty, true);
    await sandbox.persistHomeSnapshot!(scope);
    assert.notEqual((await store.get(scope))!.checkpoint!.id, before.checkpoint!.id);
    let restarted = false;
    const restarting = sandbox.restartComputer!(scope).then(() => {
      restarted = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(restarted, false);
    assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
    gate.resolve();
    assert.equal((await blocked).stdout, "blocked-command\n");
    await restarting;
    assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
    assert.equal((await store.get(scope))!.homeDirty, false);
    const restored = await make().provision(layers);
    assert.equal(await sandbox.readFile(restored, "second-turn"), "saved");
  },
);

for (const enabled of [false, true])
  test(
    `Render turns share one computer through the sandbox router with sandbox resources ${enabled ? "on" : "off"}`,
    { timeout: 60_000 },
    async (t) => {
      const { make, fake, layers, scope, advisoryLock } = setup(t);
      const render = make();
      const routes = createMemoryMap<SandboxRoute>();
      const resources = createSandboxResources({
        enabled,
        rollout: createMemoryMap(),
        legacyScopes: async () => [scope],
        records: createMemoryMap(),
        defaults: createMemoryMap(),
        routes,
        backends: { render },
        defaultBackend: "render",
        lock: advisoryLock,
        canUseScope: async () => true,
      });
      const router = createSandboxRouter({ routes, backends: { render }, defaultBackend: "render", resources });
      const first = await router.provision(layers);
      assert.ok(first.resourceId);
      const gate = blockCommands(fake);
      const blocked = router.run(first, "echo blocked-command");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const second = await router.provision(layers);
      assert.equal((await router.run(second, "echo concurrent")).stdout, "concurrent\n");
      await router.teardown(second);
      gate.resolve();
      assert.equal((await blocked).stdout, "blocked-command\n");
      await router.teardown(first);
    },
  );

test("Render reaping keeps a sandbox whose background process starts after the first process probe", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  const expiresAtMs = Date.now() + 60_000;
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = expiresAtMs;
  await store.merge(scope, { expiresAtMs });
  const run = fake.client.runScript;
  let started = false;
  fake.client.runScript = async (id, script, timeoutSec) => {
    const result = await run(id, script, timeoutSec);
    if (script.includes(".agent-proc") && !started) {
      started = true;
      await startBackgroundProcess(fake, id);
    }
    return result;
  };
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal(started, true);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  assert.equal((await sandbox.listProcesses!(handle)).length, 1);
});

test("Render keeps an expiring sandbox that another turn is using and rotates it after the command", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = Date.now() + 60_000;
  const gate = blockCommands(fake);
  const blocked = sandbox.run(handle, "echo blocked-command");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await make().provision(layers);
  assert.equal(fake.createdFrom.length, 1);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  gate.resolve();
  await blocked;
  await make().provision(layers);
  assert.equal(fake.createdFrom.length, 2);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
});

test("Render refuses a blank replacement when the recorded home archive is missing", async (t) => {
  const { make, fake, layers, store, scope, snapshots } = setup(t);
  const source = make();
  const handle = await source.provision(layers);
  await source.writeFile(handle, "long-lived", "must not vanish");
  await source.teardown(handle);
  const stored = (await store.get(scope))!;
  fake.snapshots.get(stored.checkpoint!.id)!.expiresAtMs = Date.now() - 1;
  await fake.client.terminate(stored.sandboxId);
  await snapshots.delete?.(scope);
  await assert.rejects(make().provision(layers), /home checkpoint is missing; refusing a blank replacement/);
  assert.equal(fake.sandboxes.get("sbx-2")?.status, "terminated");
  assert.equal((await store.get(scope))!.sandboxId, stored.sandboxId);
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

test("Render restores its last native checkpoint and then the newer home backup after a native checkpoint fails", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "removed", "only in the native checkpoint");
  await sandbox.writeFile(handle, "node_modules/cached/index.js", "cache");
  await sandbox.teardown(handle);
  const native = (await store.get(scope))!.checkpoint!.id;
  assert.equal((await sandbox.run(handle, "rm removed")).code, 0);
  await sandbox.writeFile(handle, "latest", "new work");
  fake.failCheckpoint(new Error("native snapshot unavailable"));
  await sandbox.teardown(handle);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  fake.failCheckpoint();
  const target = make();
  const restored = await target.provision(layers);
  assert.equal(restored.coldStart, false);
  assert.equal(fake.createdFrom.at(-1), native);
  assert.equal(await target.readFile(restored, "latest"), "new work");
  assert.equal(await target.readFile(restored, "removed"), null);
  assert.equal(await target.readFile(restored, "node_modules/cached/index.js"), "cache");
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

test("Render recovers from an expired staged native checkpoint with the durable home", async (t) => {
  const { make, fake, layers, store, scope, snapshots } = setup(t);
  await snapshots.put(scope, await makeTar([{ path: "workspace/recovered", data: Buffer.from("retained") }]));
  await store.put(scope, {
    sandboxId: "sbx-missing",
    expiresAtMs: Date.now() - 1,
    lastActivityMs: Date.now() - 7200_000,
    homeCheckpointAtMs: Date.now() - 3600_000,
    retiredResources: [
      { checkpoint: { id: "snp-gone", sandboxGroupId: "sbg-test", status: "available", expiresAtMs: Date.now() - 1 } },
    ],
  });
  const target = make();
  const restored = await target.provision(layers);
  assert.equal(await target.readFile(restored, "recovered"), "retained");
  assert.equal(fake.createdFrom[0], undefined);
  assert.equal((await store.get(scope))?.retiredResources, undefined);
});

test("Render keeps the previous home archive when an import cannot publish its record", async (t) => {
  const { make, fake, layers, store, scope, blobTransfer, snapshots } = setup(t);
  const source = make();
  const handle = await source.provision(layers);
  await source.writeFile(handle, "work", "original value");
  await source.teardown(handle);
  const before = (await store.get(scope))!;
  const put = store.put;
  let failed = false;
  store.put = async (key, value) => {
    if (
      !failed &&
      value.sandboxId !== before.sandboxId &&
      !value.retiredResources?.some((r) => r.sandboxId === value.sandboxId)
    ) {
      failed = true;
      throw new Error("publish record outage");
    }
    await put(key, value);
  };
  const blob = await blobTransfer.put(await makeTar([{ path: "workspace/work", data: Buffer.from("replacement") }]));
  await assert.rejects(source.adoptHomeSnapshot!(scope, blob.blobId), /publish record outage/);
  assert.deepEqual(await store.get(scope), before);
  assert.ok((await readBackup(snapshots, scope))!.includes("original value"));
  assert.equal(fake.snapshots.size, 1);
  assert.equal(fake.sandboxes.get("sbx-2")?.status, "terminated");
  const restored = await make().provision(layers);
  assert.equal(await source.readFile(restored, "work"), "original value");
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
  assert.ok(await readBackup(snapshots, scope));
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
  assert.ok(await readBackup(snapshots, scope));
  fake.failTerminate(undefined, before.sandboxId);
  const next = make();
  const handle = await next.provision(layers);
  assert.equal(await next.readFile(handle, "work"), "replacement");
  assert.equal((await store.get(scope))!.retiredResources, undefined);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
});

test("Render keeps a running process during monitor provisioning near sandbox expiry", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const source = make();
  await source.provision(layers);
  const stored = (await store.get(scope))!;
  await startBackgroundProcess(fake, stored.sandboxId);
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = Date.now() + 650_000;
  const monitor = make();
  await monitor.provision(layers);
  assert.equal(fake.createdFrom.length, 1);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  await finishBackgroundProcess(fake, stored.sandboxId);
  await monitor.provision(layers);
  assert.equal(fake.createdFrom.length, 2);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
});

test("Render keeps its record while the home archive cannot be deleted and removes both once it can", async (t) => {
  const { make, fake, layers, store, scope, snapshots } = setup(t);
  let blocked = false;
  const sandbox = make({
    ...snapshots,
    async delete(key) {
      if (blocked) throw new Error("archive delete outage");
      await snapshots.delete?.(key);
    },
  });
  const handle = await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  await sandbox.writeFile(handle, "work", "latest value");
  await sandbox.teardown(handle);
  assert.ok(await readBackup(snapshots, scope));
  blocked = true;
  await assert.rejects(sandbox.destroyScope!(scope), /archive delete outage/);
  assert.ok(await store.get(scope));
  assert.ok(await readBackup(snapshots, scope));
  blocked = false;
  await sandbox.destroyScope!(scope);
  assert.equal(await store.get(scope), null);
  assert.equal(await snapshots.open(scope), null);
  assert.equal(fake.snapshots.size, 0);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
});

test("Render retains failed first-import cleanup and never provisions its abandoned sandbox", async (t) => {
  const { make, fake, layers, store, scope, blobTransfer, snapshots } = setup(t);
  const sandbox = make();
  const blob = await blobTransfer.put(await makeTar([{ path: "workspace/work", data: Buffer.from("discarded") }]));
  fake.failCheckpoint(new Error("native snapshot outage"));
  fake.failTerminate(new Error("terminate outage"), "sbx-1");
  await assert.rejects(sandbox.adoptHomeSnapshot!(scope, blob.blobId), /native snapshot outage/);
  const abandoned = (await store.get(scope))!;
  assert.equal(abandoned.sandboxId, "sbx-1");
  assert.equal(abandoned.retiredResources?.[0]?.sandboxId, "sbx-1");
  assert.equal(abandoned.retirementError, "terminate outage");
  assert.equal(await snapshots.open(scope), null);
  assert.equal((await sandbox.computerStatus!(scope)).provisioned, false);
  await assert.rejects(make().provision(layers), /cleanup is incomplete/);
  await assert.rejects(sandbox.persistHomeSnapshot!(scope), /not provisioned/);
  assert.equal(fake.createdFrom.length, 1);
  fake.failCheckpoint();
  fake.failTerminate(undefined, "sbx-1");
  const next = make();
  const handle = await next.provision(layers);
  assert.equal(handle.coldStart, true);
  assert.equal(await next.readFile(handle, "work"), null);
  assert.equal((await store.get(scope))!.retiredResources, undefined);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
  assert.ok(await readBackup(snapshots, scope));
});

test("Render cleans a first-import native checkpoint when its staging record write fails", async (t) => {
  const { make, fake, store, scope, blobTransfer } = setup(t);
  const put = store.put;
  let failed = false;
  store.put = async (key, value) => {
    if (!failed && value.retiredResources?.some((resource) => resource.checkpoint)) {
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

test("Render retries abandoned import cleanup after its record deletion fails", async (t) => {
  const { make, fake, layers, store, scope, blobTransfer } = setup(t);
  const blob = await blobTransfer.put(await makeTar([{ path: "workspace/work", data: Buffer.from("discarded") }]));
  fake.failCheckpoint(new Error("native snapshot outage"));
  fake.failTerminate(new Error("terminate outage"), "sbx-1");
  await assert.rejects(make().adoptHomeSnapshot!(scope, blob.blobId), /native snapshot outage/);
  fake.failCheckpoint();
  fake.failTerminate(undefined, "sbx-1");
  const remove = store.delete;
  let failDelete = true;
  t.mock.method(store, "delete", async (key: string) => {
    if (failDelete) {
      failDelete = false;
      throw new Error("record delete outage");
    }
    await remove(key);
  });
  await assert.rejects(make().provision(layers), /record delete outage/);
  assert.equal((await store.get(scope))!.discarded, true);
  assert.equal((await store.get(scope))!.retiredResources, undefined);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
  const next = make();
  assert.equal((await next.computerStatus!(scope)).provisioned, false);
  const handle = await next.provision(layers);
  assert.equal(handle.coldStart, true);
  assert.equal(await next.readFile(handle, "work"), null);
  assert.equal((await store.get(scope))!.discarded, undefined);
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

test("Render disposes a new native checkpoint when its staging record write fails", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const info = await fake.client.create();
  await store.put(scope, {
    sandboxId: info.id,
    expiresAtMs: info.expiresAtMs,
    lastActivityMs: Date.now(),
  });
  const merge = store.merge;
  let failed = false;
  store.merge = async (key, patch) => {
    if (!failed && patch.retiredResources?.some((resource) => resource.checkpoint)) {
      failed = true;
      throw new Error("pending record outage");
    }
    return merge(key, patch);
  };
  const sandbox = make();
  await sandbox.persistHomeSnapshot!(scope);
  const stored = (await store.get(scope))!;
  assert.equal(stored.recoveryError, "pending record outage");
  assert.equal(stored.checkpoint, undefined);
  assert.equal(stored.retiredResources, undefined);
  assert.equal(fake.snapshots.size, 0);
  await sandbox.destroyScope!(scope);
  assert.equal(await store.get(scope), null);
});

test("Render restores a newer home backup into a fresh sandbox when it cannot extract it over the native checkpoint", async (t) => {
  const { make, fake, layers, store, scope, errors } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "app/node_modules/cache/index.js", "cache");
  await sandbox.writeFile(handle, "app/main.js", "old app");
  await sandbox.teardown(handle);
  const native = (await store.get(scope))!.checkpoint!.id;
  assert.equal((await sandbox.run(handle, "rm -rf app && printf 'now a file' > app")).code, 0);
  fake.failCheckpoint(new Error("native snapshot unavailable"));
  await sandbox.teardown(handle);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  fake.failCheckpoint();
  const target = make();
  const restored = await target.provision(layers);
  assert.equal(restored.coldStart, false);
  assert.deepEqual(fake.createdFrom.slice(-2), [native, undefined]);
  assert.equal(await target.readFile(restored, "app"), "now a file");
  assert.ok(errors.some((error) => error.code === "home_restore_failed"));
  const saved = (await store.get(scope))!;
  assert.equal(saved.checkpoint?.id, native);
  assert.equal(saved.checkpointBehindHome, true);
});

async function stageNewerHomeBackup(t: TestContext) {
  const env = setup(t);
  const { make, fake, layers, store, scope } = env;
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "app/node_modules/dep/index.js", "dependency");
  await sandbox.writeFile(handle, "app/main.js", "v1");
  await sandbox.teardown(handle);
  const native = (await store.get(scope))!.checkpoint!.id;
  await sandbox.writeFile(handle, "app/main.js", "v2");
  fake.failCheckpoint(new Error("native snapshot unavailable"));
  await sandbox.teardown(handle);
  fake.failCheckpoint();
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  const run = fake.client.runScript;
  const stopRestores = (count: number): void => {
    fake.client.runScript = async (sandboxId, script, timeoutSec) =>
      script.includes("xargs -0 rmdir") && count-- > 0
        ? { stdout: "", stderr: "", exitCode: 124 }
        : run(sandboxId, script, timeoutSec);
  };
  return { ...env, native, stopRestores };
}

test("Render tries a restore of a newer home backup once more after it times out", async (t) => {
  const { make, fake, layers, errors, native, stopRestores } = await stageNewerHomeBackup(t);
  stopRestores(1);
  const target = make();
  const restored = await target.provision(layers);
  assert.deepEqual(fake.createdFrom.slice(-2), [native, native]);
  assert.equal(await target.readFile(restored, "app/main.js"), "v2");
  assert.equal(await target.readFile(restored, "app/node_modules/dep/index.js"), "dependency");
  assert.equal(errors.filter((error) => error.code === "home_restore_failed").length, 1);
});

test("Render restores a newer home backup into a fresh sandbox when its restore times out twice", async (t) => {
  const { make, fake, layers, store, scope, native, stopRestores } = await stageNewerHomeBackup(t);
  stopRestores(2);
  const target = make();
  const restored = await target.provision(layers);
  assert.deepEqual(fake.createdFrom.slice(-3), [native, native, undefined]);
  assert.equal(await target.readFile(restored, "app/main.js"), "v2");
  assert.equal((await store.get(scope))!.checkpoint?.id, native);
});

test("Render keeps its checkpoint interval while the home backup keeps failing", async (t) => {
  const { make, fake, layers, snapshots } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let uploads = 0;
  const failing: HomeSnapshotStore = {
    ...snapshots,
    createUpload: async (key) => {
      if (uploads++) throw new Error("archive store outage");
      return snapshots.createUpload(key);
    },
  };
  const sandbox = make(failing, 5 * 60_000);
  const handle = await sandbox.provision(layers);
  const create = fake.client.createSnapshot;
  let natives = 0;
  fake.client.createSnapshot = async (sandboxId) => {
    natives++;
    return create(sandboxId);
  };
  now += 6 * 60_000;
  await sandbox.teardown(handle);
  now += 30_000;
  await sandbox.teardown(handle);
  now += 30_000;
  await sandbox.teardown(handle, { homeUnchanged: true });
  await sandbox.reapDeepIdle!(3600_000);
  assert.equal(natives, 1);
  now += 5 * 60_000;
  await sandbox.teardown(handle, { homeUnchanged: true });
  assert.equal(natives, 2);
});

test("Render stops saving an unchanged home that is too large for its archive", async (t) => {
  const { make, fake, layers, store, scope, snapshots } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const tooLarge: HomeSnapshotStore = {
    ...snapshots,
    createUpload: async () => {
      throw new SnapshotTooLargeError("render", 3, 2);
    },
  };
  const sandbox = make(tooLarge, 5 * 60_000);
  const handle = await sandbox.provision(layers);
  assert.equal((await store.get(scope))!.homeDirty, false);
  const create = fake.client.createSnapshot;
  let natives = 0;
  fake.client.createSnapshot = async (sandboxId) => {
    natives++;
    return create(sandboxId);
  };
  for (let pass = 0; pass < 3; pass++) {
    now += 6 * 60_000;
    await sandbox.reapDeepIdle!(3600_000);
  }
  assert.equal(natives, 0);
  await sandbox.writeFile(handle, "grown", "more files");
  await sandbox.teardown(handle);
  assert.equal(natives, 1);
});

test("Render waits for a stray native checkpoint to finish before it deletes the checkpoint", async (t) => {
  const { make, fake, layers, store, scope, errors } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  fake.loseCheckpointReply("creating");
  await sandbox.teardown(handle);
  const stray = [...fake.snapshots.keys()].find((id) => id !== before.checkpoint!.id)!;
  assert.ok(stray);
  assert.equal((await store.get(scope))!.retirementError, undefined);
  assert.equal(
    errors.some((error) => error.code === "retirement_failed"),
    false,
  );
  fake.snapshots.get(stray)!.status = "available";
  await sandbox.persistHomeSnapshot!(scope);
  assert.equal(fake.snapshots.has(stray), false);
  assert.ok(fake.deleted.includes(stray));
});

test("Render removes a destroyed scope at once and deletes a checkpoint that was still being created later", async (t) => {
  const { make, fake, layers, store, scope, snapshots } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  fake.loseCheckpointReply("creating");
  await sandbox.teardown(handle);
  const stray = [...fake.snapshots.keys()].find((id) => id !== before.checkpoint!.id)!;
  await sandbox.destroyScope!(scope);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
  assert.deepEqual([...fake.snapshots.keys()], [stray]);
  assert.equal(await snapshots.open(scope), null);
  assert.equal((await store.get(scope))!.discarded, true);
  await assert.rejects(make().provision(layers), /cleanup is incomplete/);
  fake.snapshots.get(stray)!.status = "available";
  now += 6 * 60_000;
  await make().reapDeepIdle!(3600_000);
  assert.equal(await store.get(scope), null);
  assert.equal(fake.snapshots.size, 0);
});

test("Render keeps an abandoned import until it finds and deletes a native checkpoint that appears late", async (t) => {
  const { make, fake, layers, store, scope, blobTransfer } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const find = fake.client.findSnapshots;
  let visible = false;
  fake.client.findSnapshots = async (sandboxId, sinceMs) => (visible ? find(sandboxId, sinceMs) : []);
  fake.loseCheckpointReply();
  const blob = await blobTransfer.put(await makeTar([{ path: "workspace/work", data: Buffer.from("imported") }]));
  await assert.rejects(make().adoptHomeSnapshot!(scope, blob.blobId), /did not confirm/);
  assert.equal((await store.get(scope))!.discarded, true);
  assert.equal(fake.snapshots.size, 1);
  await assert.rejects(make().provision(layers), /cleanup is incomplete/);
  visible = true;
  now += 6 * 60_000;
  await make().reapDeepIdle!(3600_000);
  assert.equal(await store.get(scope), null);
  assert.equal(fake.snapshots.size, 0);
});

test("Render searches once more for an unconfirmed checkpoint before it gives up on it after a day", async (t) => {
  const { make, fake, layers, store, scope, errors } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const kept = (await store.get(scope))!.checkpoint!.id;
  const find = fake.client.findSnapshots;
  let visible = false;
  fake.client.findSnapshots = async (sandboxId, sinceMs) => (visible ? find(sandboxId, sinceMs) : []);
  fake.loseCheckpointReply();
  await sandbox.teardown(handle);
  assert.equal(fake.snapshots.size, 2);
  visible = true;
  now += 25 * 3600_000;
  await make().reapDeepIdle!(3600_000);
  assert.deepEqual([...fake.snapshots.keys()], [kept]);
  assert.equal((await store.get(scope))!.unconfirmedCheckpoints, undefined);
  assert.equal(
    errors.some((error) => error.code === "unconfirmed_checkpoint_abandoned"),
    false,
  );
});

test("Render finds and deletes a native checkpoint whose creation reply was lost", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  await sandbox.writeFile(handle, "work", "saved in the home backup");
  fake.loseCheckpointReply();
  await sandbox.teardown(handle);
  const failed = (await store.get(scope))!;
  assert.equal(failed.checkpoint?.id, before.checkpoint!.id);
  assert.equal(failed.checkpointBehindHome, true);
  assert.deepEqual(failed.unconfirmedCheckpoints, [
    { sandboxId: before.sandboxId, requestedAtMs: now, lastRequestedAtMs: now },
  ]);
  assert.equal(failed.retiredResources, undefined);
  assert.deepEqual([...fake.snapshots.keys()], [before.checkpoint!.id]);
  assert.equal(fake.deleted.length, 1);
  now += 6 * 60_000;
  assert.deepEqual(await make().reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal((await store.get(scope))!.unconfirmedCheckpoints, undefined);
  assert.deepEqual([...fake.snapshots.keys()], [before.checkpoint!.id]);
});

test("Render saves portable files before it disposes a staged native snapshot", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  const pending = await fake.client.createSnapshot(stored.sandboxId);
  await store.merge(scope, { retiredResources: [{ checkpoint: { ...pending, status: "creating" } }] });
  await sandbox.writeFile(handle, "work", "after pending snapshot");
  fake.failCheckpoint(new Error("native snapshot unavailable"));
  await sandbox.teardown(handle);
  assert.ok((await store.get(scope))!.homeCheckpointAtMs);
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
  await startBackgroundProcess(fake, stored.sandboxId);
  await sandbox.writeFile(handle, "background", "retained output");
  const expiresAtMs = Date.now() + 16 * 60_000;
  const stale = Date.now() - 360_000;
  await store.merge(scope, { homeCheckpointAtMs: stale, savedAtMs: stale, expiresAtMs });
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = expiresAtMs;
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  const checkpointAtMs = (await store.get(scope))!.homeCheckpointAtMs!;
  assert.ok(checkpointAtMs > stale);
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, checkpointAtMs);
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
    try {
      const key = operation === "file import" ? `render-sandbox-use:${handle.id}` : `render-sandbox:${handle.id}`;
      assert.equal(await advisoryLock.tryWithLock!(key, async () => true), null);
      assert.deepEqual(await other.reapDeepIdle!(0), { reaped: 0 });
      assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
    } finally {
      release.resolve();
      await pending;
    }
    assert.deepEqual(await other.reapDeepIdle!(0), { reaped: 1 });
    assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
    const restored = await other.provision(layers);
    assert.equal(await other.readFile(restored, "latest"), "completed operation");
  });
}

test("Render skips remote probes and checkpoints for a recently used sandbox", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(layers);
  await store.merge(scope, { homeCheckpointAtMs: Date.now() - 360_000, savedAtMs: Date.now() - 360_000 });
  const before = (await store.get(scope))!;
  const get = t.mock.method(fake.client, "get");
  const commands = fake.commands.length;
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal(get.mock.callCount(), 0);
  assert.equal(fake.commands.length, commands);
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, before.homeCheckpointAtMs);
  await make().provision(layers);
  assert.ok(fake.commands.slice(commands).every((command) => !command.includes(".agent-proc")));
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, before.homeCheckpointAtMs);
});

test("Render leaves an idle sandbox with a running process alone until its TTL is near", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  await startBackgroundProcess(fake, before.sandboxId);
  const stale = Date.now() - 360_000;
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000, homeCheckpointAtMs: stale, savedAtMs: stale });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, stale);
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
  const stale = Date.now() - 360_000;
  await store.merge(scope, { homeCheckpointAtMs: stale, savedAtMs: stale, expiresAtMs });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.ok((await store.get(scope))!.homeCheckpointAtMs! > stale);
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
  const initial = (await store.get(scope))!.homeCheckpointAtMs;
  await sandbox.writeFile(handle, "recent", "written within the interval");
  await sandbox.teardown(handle, { keepWarm: true });
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, initial);
  const stale = Date.now() - 6 * 60_000;
  await store.merge(scope, { homeCheckpointAtMs: stale, savedAtMs: stale });
  await sandbox.teardown(handle, { keepWarm: true });
  assert.ok((await store.get(scope))!.homeCheckpointAtMs! > stale);
  await store.merge(scope, { homeCheckpointAtMs: stale, savedAtMs: stale });
  await sandbox.teardown(handle, { homeUnchanged: true });
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, stale);
  await sandbox.teardown(handle);
  assert.ok((await store.get(scope))!.homeCheckpointAtMs! > stale);
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
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, initial.homeCheckpointAtMs);
  assert.equal((await store.get(scope))!.homeDirty, true);
  const stale = Date.now() - 6 * 60_000;
  await store.merge(scope, { homeCheckpointAtMs: stale, savedAtMs: stale });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  const saved = (await store.get(scope))!;
  assert.ok(saved.homeCheckpointAtMs! > stale);
  assert.equal(saved.homeDirty, false);
  assert.equal(fake.sandboxes.get(initial.sandboxId)?.status, "running");
  await store.merge(scope, { homeCheckpointAtMs: stale, savedAtMs: stale });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, stale);
});

test("Render saves completed work after a recent checkpoint near sandbox expiry", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make(undefined, 5 * 60_000);
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  await startBackgroundProcess(fake, stored.sandboxId);
  await sandbox.writeFile(handle, "final-output", "in progress");
  const expiresAtMs = now + 4 * 60_000;
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = expiresAtMs;
  await store.merge(scope, { expiresAtMs, homeCheckpointAtMs: now - 6 * 60_000, savedAtMs: now - 6 * 60_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, now);
  now += 60_000;
  await finishBackgroundProcess(fake, stored.sandboxId);
  await sandbox.writeFile(handle, "final-output", "complete");
  await sandbox.teardown(handle, { keepWarm: true });
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, now);
  assert.equal((await store.get(scope))!.homeDirty, false);
  now = expiresAtMs + 1;
  await fake.client.terminate(stored.sandboxId);
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  const next = make();
  const restored = await next.provision(layers);
  assert.equal(await next.readFile(restored, "final-output"), "complete");
});

test("Render backs up each interval of a detached process and its completed output", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make(undefined, 5 * 60_000);
  const handle = await sandbox.provision(layers);
  const initial = (await store.get(scope))!;
  await startBackgroundProcess(fake, initial.sandboxId);
  await sandbox.writeFile(handle, "foreground-output", "complete");
  await sandbox.teardown(handle, { keepWarm: true });
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, initial.homeCheckpointAtMs);
  assert.equal((await store.get(scope))!.homeDirty, true);
  now += 6 * 60_000;
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, now);
  assert.equal((await store.get(scope))!.homeDirty, true);
  assert.equal(fake.sandboxes.get(initial.sandboxId)?.status, "running");
  await fake.client.writeFileBytes(initial.sandboxId, "/root/workspace/detached-output", Buffer.from("in progress"));
  now += 6 * 60_000;
  await sandbox.reapDeepIdle!(0);
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, now);
  assert.equal((await store.get(scope))!.homeDirty, true);
  await fake.client.writeFileBytes(initial.sandboxId, "/root/workspace/detached-output", Buffer.from("complete"));
  await finishBackgroundProcess(fake, initial.sandboxId);
  now += 6 * 60_000;
  await sandbox.reapDeepIdle!(0);
  assert.equal((await store.get(scope))!.homeCheckpointAtMs, now);
  assert.equal((await store.get(scope))!.homeDirty, false);
  await fake.client.terminate(initial.sandboxId);
  const next = make();
  const restored = await next.provision(layers);
  assert.equal(await next.readFile(restored, "foreground-output"), "complete");
  assert.equal(await next.readFile(restored, "detached-output"), "complete");
});
