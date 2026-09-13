import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import {
  createRenderDeployArtifacts,
  type StoredRenderDeployCredential,
} from "../src/deploy/render-deploy-artifacts.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { DeployGitArchive } from "../src/deploy/deploy-git-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { verifyDeployGitAccess } from "../src/deploy/access-token.ts";
import { scopeId } from "../src/types.ts";

const runner = new URL("../deploy/render-runner/start.mjs", import.meta.url);
const { prepareRenderApp, runRenderApp } = await import(runner.href);
const signingSecret = "render-runner-secret".repeat(3);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "qm-render-runner-"));
  const deployments = createMemoryMap<Deployment>();
  const archiveStore = createMemoryMap<DeployGitArchive>();
  const credentials = createMemoryMap<StoredRenderDeployCredential>();
  const gitDir = join(root, "writer");
  const deployStore = createDeployStore({ deployments, git: { repoRoot: gitDir, archiveStore } });
  const d = await deployStore.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    snapshotDir: "/unused",
    entrypoint: "node app.cjs",
    files: [
      {
        path: "app.cjs",
        data: 'require("node:fs").writeFileSync("result.json", JSON.stringify({ version: 1, port: process.env.PORT, secret: process.env.APP_SECRET, git: process.env.GIT_CONFIG_VALUE_0 })); process.exit(23);',
      },
      { path: "old.txt", data: "old version" },
    ],
  });
  let base = "";
  const artifacts = createRenderDeployArtifacts({
    get baseUrl() {
      return base;
    },
    signingSecret,
    store: credentials,
    deployStore,
  });
  const readerStore = createDeployStore({ deployments, git: { repoRoot: join(root, "reader"), archiveStore } });
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore: readerStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "unused", port: 8080 }),
      destroy: async (deployment) => artifacts.revoke(deployment.id),
    },
    deployDir: join(root, "deploy"),
    acl,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
  });
  const identity = createIdentityService();
  const app = createApp({
    deploy,
    renderDeployArtifacts: artifacts,
    acl,
    identity,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
  } as unknown as Parameters<typeof createApp>[0]);
  const server = createServer(app, { signingSecret, identity });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, base, d, deployStore, deploy, artifacts, credentials, gitDir, app };
}

test("Render runner boots an immutable Git version after core and app cache deletion", async (t) => {
  const f = await fixture(t);
  const v1 = f.d.versions[0]!;
  const manifest = await f.artifacts.prepare(f.d, v1);
  const manifestPath = join(f.root, "artifact.json");
  const appDir = join(f.root, "app");
  const data = join(f.root, "data");
  await mkdir(data);
  await writeFile(join(data, "app.db"), "durable data");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await f.deployStore.addVersion(f.d.id, {
    snapshotDir: "/unused",
    entrypoint: "node app.cjs",
    files: [{ path: "app.cjs", data: "process.exit(24);" }],
  });
  await rm(f.gitDir, { recursive: true, force: true });
  assert.equal(
    await runRenderApp({
      manifestPath,
      appDir,
      env: { ...process.env, APP_SECRET: "app-secret", GIT_CONFIG_VALUE_0: "parent-token" },
    }),
    23,
  );
  assert.deepEqual(JSON.parse(await readFile(join(appDir, "result.json"), "utf8")), {
    version: 1,
    port: "8080",
    secret: "app-secret",
  });
  await rm(appDir, { recursive: true });
  await rm(join(f.root, "reader"), { recursive: true });
  assert.equal(await runRenderApp({ manifestPath, appDir, env: process.env }), 23);
  assert.equal(await readFile(join(appDir, "old.txt"), "utf8"), "old version");
  assert.equal(await readFile(join(data, "app.db"), "utf8"), "durable data");
  const restarted = createRenderDeployArtifacts({
    baseUrl: f.base,
    signingSecret,
    store: f.credentials,
    deployStore: f.deployStore,
  });
  assert.equal((await restarted.prepare(f.d, v1)).token, manifest.token);
});

test("Render runner credentials deny forgery, cross-app fetches, and Git writes", async (t) => {
  const f = await fixture(t);
  const manifest = await f.artifacts.prepare(f.d, f.d.versions[0]!);
  const request = (url: string, token: string, method = "GET") =>
    fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
  const refs = `${manifest.url}/info/refs?service=git-upload-pack`;
  assert.equal((await request(refs, manifest.token)).status, 200);
  assert.equal((await request(refs, `${manifest.token}forged`)).status, 401);
  assert.equal((await request(refs.replace(f.d.id, "other-app"), manifest.token)).status, 403);
  assert.equal((await request(`${manifest.url}/git-receive-pack`, manifest.token, "POST")).status, 403);
  const access = await verifyDeployGitAccess(signingSecret, manifest.token, Date.now() + 10 * 365 * 24 * 60 * 60_000);
  assert.equal(access?.permission, "read");
  assert.equal(await f.app.authorizesDeploymentGitAccess(f.d.id, access!.principalId!, "write"), false);
  assert.equal(await f.app.authorizesDeploymentGitAccess(f.d.id, "render-deploy:forged", "read"), false);
});

test("Archiving revokes a runner credential and restoration creates a new one", async (t) => {
  const f = await fixture(t);
  const version = f.d.versions[0]!;
  const manifest = await f.artifacts.prepare(f.d, version);
  await f.deploy.archiveDeployment(f.d.id);
  assert.equal((await f.deployStore.get(f.d.id))!.status, "archived");
  const url = `${manifest.url}/info/refs?service=git-upload-pack`;
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${manifest.token}` } })).status, 403);
  const next = await f.artifacts.prepare((await f.deployStore.get(f.d.id))!, version);
  assert.notEqual(next.token, manifest.token);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${next.token}` } })).status, 200);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${manifest.token}` } })).status, 403);
});

test("Render artifact preparation requires the exact stored version and secure core URL", async (t) => {
  const f = await fixture(t);
  const version = f.d.versions[0]!;
  await assert.rejects(f.artifacts.prepare(f.d, { ...version, commit: "f".repeat(40) }), /matching durable Git commit/);
  await assert.rejects(f.artifacts.prepare(f.d, { ...version, entrypoint: "other" }), /matching durable Git commit/);
  assert.equal(await f.credentials.get(f.d.id), null);
  const insecure = createRenderDeployArtifacts({
    baseUrl: "http://core.example",
    signingSecret,
    store: f.credentials,
    deployStore: f.deployStore,
  });
  await assert.rejects(insecure.prepare(f.d, version), /HTTPS PUBLIC_API_URL/);
});

test("Render runner rejects missing commits and revoked access without executing stale code", async (t) => {
  const f = await fixture(t);
  const manifest = await f.artifacts.prepare(f.d, f.d.versions[0]!);
  const file = join(f.root, "manifest.json");
  const dir = join(f.root, "app");
  await writeFile(file, JSON.stringify({ ...manifest, commit: "f".repeat(40) }));
  await assert.rejects(prepareRenderApp(file, dir), /Git command failed/);
  await f.artifacts.revoke(f.d.id);
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(prepareRenderApp(file, dir), /Git command failed/);
});

test("Render runner preserves relative Git symlinks after source staging cleanup", async (t) => {
  const f = await fixture(t);
  const exec = promisify(execFile);
  const checkout = join(f.root, "symlink-source");
  const repo = await f.deployStore.repoUrl(f.d.id);
  await exec("git", ["clone", "--quiet", repo, checkout]);
  await exec("git", ["checkout", "--quiet", "--detach", f.d.versions[0]!.commit!], { cwd: checkout });
  await symlink("old.txt", join(checkout, "linked.txt"));
  await exec("git", ["add", "linked.txt"], { cwd: checkout });
  await exec(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "Add relative link",
    ],
    { cwd: checkout },
  );
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: checkout });
  await exec("git", ["push", "--quiet", "origin", "HEAD:refs/heads/current"], { cwd: checkout });
  const version = await f.deployStore.addVersionFromCommit(f.d.id, stdout.trim());
  assert.ok(version);
  const manifest = await f.artifacts.prepare(f.d, version);
  const file = join(f.root, "symlink-manifest.json");
  const dir = join(f.root, "app");
  await writeFile(file, JSON.stringify(manifest));
  await prepareRenderApp(file, dir);
  assert.equal(await readlink(join(dir, "linked.txt")), "old.txt");
  assert.equal(await readFile(join(dir, "old.txt"), "utf8"), "old version");
  assert.equal(await readFile(join(dir, "linked.txt"), "utf8"), "old version");
});
