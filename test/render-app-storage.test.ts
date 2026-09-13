import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { App } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { mintSignedPayload, verifySignedPayload } from "../src/auth/signed-token.ts";
import { verifyDeployGitAccess } from "../src/deploy/access-token.ts";
import { createRenderAppStorage, mintRenderAppStorageToken } from "../src/deploy/render-app-storage.ts";
import {
  createRenderDeployArtifacts,
  type StoredRenderDeployCredential,
} from "../src/deploy/render-deploy-artifacts.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ID = "550e8400-e29b-41d4-a716-446655440001";
const SECRET = "render-app-storage-signing-secret".repeat(3);
const NOW = 1_800_000_000_000;
const deployment: Deployment = {
  id: ID,
  ownerScopeId: scopeId("personal", "U1"),
  createdBy: "U1",
  status: "stopped",
  currentVersion: 1,
  endpoint: null,
  versions: [{ version: 1, createdAt: 1, entrypoint: "node app.js", snapshotDir: "unused", commit: "a".repeat(40) }],
};

async function fixture() {
  const deployments = createMemoryMap<Deployment>();
  const credentials = createMemoryMap<StoredRenderDeployCredential>();
  await deployments.put(ID, deployment);
  const artifactOptions = {
    baseUrl: "https://core.example",
    signingSecret: SECRET,
    store: credentials,
    deployStore: { versionOf: async () => deployment.versions[0]! },
  };
  const artifacts = createRenderDeployArtifacts({ ...artifactOptions, appStorage: true });
  const manifest = await artifacts.prepare(deployment, deployment.versions[0]!);
  const calls: Array<{ command: GetObjectCommand | PutObjectCommand | DeleteObjectCommand; expiresIn: number }> = [];
  const storage = createRenderAppStorage({
    bucket: "core-storage",
    prefix: "org/",
    signingSecret: SECRET,
    deployStore: deployments,
    authorizes: artifacts.authorizes,
    now: () => NOW,
    async presign(command, expiresIn) {
      calls.push({ command, expiresIn });
      return "https://objects.example/signed-object";
    },
  });
  return { deployments, credentials, artifactOptions, artifacts, manifest, storage, calls };
}

async function serve(t: TestContext, storage?: NonNullable<Parameters<typeof createServer>[1]>["renderAppStorage"]) {
  const server = createServer({} as App, { signingSecret: SECRET, ...(storage ? { renderAppStorage: storage } : {}) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("Render app storage uses its own token purpose and durable artifact principal", async () => {
  const f = await fixture();
  assert.equal(f.manifest.runtimeEnv!.QM_APP_STORAGE_URL, `https://core.example/v1/deployments/${ID}/storage`);
  const token = f.manifest.runtimeEnv!.QM_APP_STORAGE_TOKEN!;
  const payload = await verifySignedPayload(token, SECRET);
  assert.deepEqual(payload, {
    deploymentId: ID,
    principalId: (await f.credentials.get(ID))!.principalId,
    kind: "render-app-storage",
    version: 1,
    exp: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(await verifyDeployGitAccess(SECRET, token), null);
  assert.equal(
    (await f.artifacts.prepare(deployment, deployment.versions[0]!)).runtimeEnv!.QM_APP_STORAGE_TOKEN,
    token,
  );
  const disabled = createRenderDeployArtifacts(f.artifactOptions);
  assert.equal((await disabled.prepare(deployment, deployment.versions[0]!)).runtimeEnv, undefined);
});

for (const [method, command] of [
  ["GET", GetObjectCommand],
  ["PUT", PutObjectCommand],
  ["DELETE", DeleteObjectCommand],
] as const) {
  test(`Render app storage signs one app-scoped ${method} object for 60 seconds`, async () => {
    const f = await fixture();
    const signed = await f.storage.sign(ID, f.manifest.runtimeEnv!.QM_APP_STORAGE_TOKEN!, {
      method,
      key: "uploads/report.pdf",
    });
    assert.deepEqual(signed, { url: "https://objects.example/signed-object", method, expiresAt: NOW + 60_000 });
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0]!.command instanceof command);
    assert.deepEqual(f.calls[0]!.command.input, {
      Bucket: "core-storage",
      Key: `org/app-data/${ID}/uploads/report.pdf`,
    });
    assert.equal(f.calls[0]!.expiresIn, 60);
  });
}

test("Render app storage rejects invalid methods and unsafe object keys", async () => {
  const f = await fixture();
  const token = f.manifest.runtimeEnv!.QM_APP_STORAGE_TOKEN!;
  for (const method of ["POST", "HEAD", "LIST", "get", null])
    await assert.rejects(f.storage.sign(ID, token, { method, key: "valid" }), /method must be/);
  for (const key of [
    "",
    "/other-app/key",
    "x/",
    "x//y",
    ".",
    "..",
    "x/../y",
    "x/./y",
    "x\\y",
    "x\u0000y",
    "a".repeat(513),
    "界".repeat(171),
    null,
    1,
  ])
    await assert.rejects(f.storage.sign(ID, token, { method: "GET", key }), /key must be/);
  assert.equal(f.calls.length, 0);
  await f.storage.sign(ID, token, { method: "GET", key: "a".repeat(512) });
  await f.storage.sign(ID, token, { method: "GET", key: "文件/report.pdf" });
  assert.equal(f.calls.length, 2);
});

test("Render app storage rejects forgery, other token purposes, expired tokens, and cross-app access", async () => {
  const f = await fixture();
  const token = f.manifest.runtimeEnv!.QM_APP_STORAGE_TOKEN!;
  const claims = (await verifySignedPayload(token, SECRET)) as Record<string, unknown>;
  for (const invalid of [
    "invalid",
    `${token}forged`,
    f.manifest.token,
    await mintSignedPayload({ ...claims, kind: "control-plane" }, SECRET),
    await mintSignedPayload({ ...claims, version: 2 }, SECRET),
    await mintSignedPayload({ ...claims, exp: NOW }, SECRET),
    await mintSignedPayload({ ...claims, exp: "forever" }, SECRET),
    await mintSignedPayload({ ...claims, deploymentId: "../other-app" }, SECRET),
    await mintSignedPayload({ ...claims, principalId: "" }, SECRET),
  ])
    await assert.rejects(f.storage.sign(ID, invalid, { method: "GET", key: "valid" }), { status: 401 });
  await assert.rejects(f.storage.sign(OTHER_ID, token, { method: "GET", key: "valid" }), { status: 403 });
  const wrongPrincipal = await mintRenderAppStorageToken(SECRET, {
    deploymentId: ID,
    principalId: "render-deploy:other",
  });
  await assert.rejects(f.storage.sign(ID, wrongPrincipal, { method: "GET", key: "valid" }), { status: 403 });
  assert.equal(f.calls.length, 0);
});

test("Render app storage permits startup and live apps but rejects deletion and revoked credentials", async () => {
  const f = await fixture();
  const token = f.manifest.runtimeEnv!.QM_APP_STORAGE_TOKEN!;
  const sign = () => f.storage.sign(ID, token, { method: "PUT", key: "valid" });
  await sign();
  await f.deployments.put(ID, { ...deployment, status: "running" });
  await sign();
  await f.deployments.delete(ID);
  await assert.rejects(sign(), { status: 403 });
  await f.deployments.put(ID, deployment);
  await f.artifacts.revoke(ID);
  await assert.rejects(sign(), { status: 403 });
  const restored = await f.artifacts.prepare(deployment, deployment.versions[0]!);
  assert.notEqual(restored.runtimeEnv!.QM_APP_STORAGE_TOKEN, token);
  await assert.rejects(sign(), { status: 403 });
  await f.storage.sign(ID, restored.runtimeEnv!.QM_APP_STORAGE_TOKEN!, { method: "GET", key: "valid" });
  assert.equal(f.calls.length, 3);
});

test("Render app storage route requires its bearer token and exposes only method, URL, and expiry", async (t) => {
  const f = await fixture();
  const base = await serve(t, f.storage);
  const token = f.manifest.runtimeEnv!.QM_APP_STORAGE_TOKEN!;
  const request = (body: unknown, authorization = `Bearer ${token}`, id = ID) =>
    fetch(`${base}/v1/deployments/${id}/storage`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await request({ method: "GET", key: "item" }, "")).status, 401);
  assert.equal((await request({ method: "GET", key: "item" }, `Bearer ${f.manifest.token}`)).status, 401);
  assert.equal((await request({ method: "GET", key: "item" }, `Bearer ${token}`, OTHER_ID)).status, 403);
  assert.equal((await request({ method: "GET", key: "item", bucket: "other" })).status, 400);
  assert.equal((await request({ method: "GET", key: "item", prefix: "other" })).status, 400);
  assert.equal((await request({ method: "GET", key: "../other" })).status, 400);
  assert.equal((await request(null)).status, 400);
  assert.equal(f.calls.length, 0);
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await request({ method, key: "item" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      url: "https://objects.example/signed-object",
      method,
      expiresAt: NOW + 60_000,
    });
  }
  await f.artifacts.revoke(ID);
  assert.equal((await request({ method: "GET", key: "item" })).status, 403);
});

test("Render app storage route stays unavailable when storage is not configured", async (t) => {
  const base = await serve(t);
  const response = await fetch(`${base}/v1/deployments/${ID}/storage`, { method: "POST", body: "{}" });
  assert.equal(response.status, 404);
});

test("Render app storage uses the S3 signer with its fixed object scope", async () => {
  const f = await fixture();
  const client = new S3Client({
    region: "us-east-1",
    endpoint: "https://objects.example",
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
  });
  const storage = createRenderAppStorage({
    bucket: "core-storage",
    signingSecret: SECRET,
    deployStore: f.deployments,
    authorizes: f.artifacts.authorizes,
    client,
  });
  const signed = await storage.sign(ID, f.manifest.runtimeEnv!.QM_APP_STORAGE_TOKEN!, {
    method: "PUT",
    key: "reports/summary.txt",
  });
  const url = new URL(signed.url);
  assert.equal(url.origin, "https://objects.example");
  assert.equal(url.pathname, `/core-storage/app-data/${ID}/reports/summary.txt`);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
  assert.ok(url.searchParams.get("X-Amz-Signature"));
  assert.equal(url.searchParams.has("x-amz-checksum-crc32"), false);
  assert.equal(signed.url.includes("test-secret"), false);
  client.destroy();
});

test("Render app storage is available during restore after archive revokes its old principal", async (t) => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "render-storage-restore-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storedVersion = { ...deployment.versions[0]!, commit: undefined };
  await f.deployments.put(ID, { ...deployment, status: "running", versions: [storedVersion], appliedVersion: 1 });
  const store = createDeployStore({ deployments: f.deployments, git: { repoRoot: join(dir, "git") } });
  const oldToken = f.manifest.runtimeEnv!.QM_APP_STORAGE_TOKEN!;
  let restoredToken = "";
  const service = createDeployService({
    deployStore: store,
    deployDir: join(dir, "apps"),
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    provider: {
      profile: { managedScaleToZero: false },
      async destroy(d) {
        await f.artifacts.revoke(d.id);
      },
      async apply(d) {
        assert.equal(d.status, "archived");
        const manifest = await f.artifacts.prepare(d, deployment.versions[0]!);
        restoredToken = manifest.runtimeEnv!.QM_APP_STORAGE_TOKEN!;
        assert.notEqual(restoredToken, oldToken);
        await f.storage.sign(d.id, restoredToken, { method: "GET", key: "startup.json" });
        return { host: "app-internal", port: 8080 };
      },
    },
  });
  await service.archiveDeployment(ID);
  assert.equal((await store.get(ID))!.status, "archived");
  await assert.rejects(f.storage.sign(ID, oldToken, { method: "GET", key: "startup.json" }), { status: 403 });
  const restored = await service.restoreDeployment(ID, "U1");
  assert.equal(restored.status, "running");
  await assert.rejects(f.storage.sign(ID, oldToken, { method: "GET", key: "startup.json" }), { status: 403 });
  await f.storage.sign(ID, restoredToken, { method: "PUT", key: "startup.json" });
  assert.equal(f.calls.length, 2);
});
