import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  createRenderDeployProvider,
  type RenderDeployProviderOptions,
  type StoredRenderDeploy,
} from "../src/deploy/render-deploy-provider.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";
import { loadConfig } from "../src/config.ts";

const sha = "a".repeat(40);
const writePaths = {
  environment: "/environments",
  create: "/services",
  resume: "/services/srv-app/resume",
  deploy: "/services/srv-app/deploys",
};

function fixture(appRegion?: string) {
  const store = createMemoryMap<StoredRenderDeploy>();
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let service: any = null;
  let environment: any = null;
  let ipAllowList: any[] = [];
  const deploys: any[] = [];
  let outcome = "live";
  let builtCommit: string | undefined;
  let foreignDeployOnEnvWrite: string | undefined;
  let loseCreate = false;
  let loseUpdate = false;
  let failure: { method: string; path: string; status?: number } | undefined;
  let activeEnv: any[] = [];
  let manifestNonce: string | undefined;
  let readinessNonce: string | null | undefined;
  const data = new Map<string, string>();
  let resourceSuspended = false;
  let savedRegionBeforeCreate: string | undefined;
  const artifacts = {
    prepare: async (d: Deployment, v: Deployment["versions"][number]) => ({
      url: `https://core.example/v1/deployments/${d.id}/git`,
      token: "source-token",
      commit: v.commit ?? sha,
      entrypoint: v.entrypoint,
    }),
    revoke: async () => {},
    authorizes: async () => false,
  };
  const response = (value: unknown, status = 200) =>
    new Response(value === undefined ? null : JSON.stringify(value), { status });
  const options: RenderDeployProviderOptions = {
    apiKey: "key",
    workspaceId: "tea-test",
    projectId: "prj-test",
    environmentId: "env-test",
    postgresId: "dpg-test",
    appRegion,
    source: { repo: "https://github.com/test/qm", branch: "anurag/render-source", commit: sha },
    store,
    artifacts,
    resources: {
      ensure: async () => {
        resourceSuspended = false;
        return { DATABASE_URL: "postgres://app:secret@postgres/app", S3_PREFIX: "app-data/scoped/" };
      },
      suspend: async () => {
        resourceSuspended = true;
      },
    },
    pollIntervalMs: 1,
    deployTimeoutMs: 100,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = `${url.pathname}${url.search}`.replace(/^\/v1/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (failure?.method === method && path.startsWith(failure.path)) {
        const status = failure.status;
        failure = undefined;
        if (status) return response(undefined, status);
        throw new TypeError("connection lost before write");
      }
      if (url.hostname === "qm-private") {
        const nonce = readinessNonce === undefined ? manifestNonce : readinessNonce;
        return new Response(null, { status: 204, headers: nonce ? { "x-qm-render-app-ready": nonce } : {} });
      }
      if (path === "/environments/env-test") return response({ id: "env-test", projectId: "prj-test" });
      if (path === "/projects/prj-test") return response({ owner: { id: "tea-test" } });
      if (path.startsWith("/environments?")) return response(environment ? [{ environment }] : []);
      if (path === "/environments" && method === "POST") {
        savedRegionBeforeCreate = (await store.get(deployment.id))?.appRegion;
        environment = { ...body, id: "env-app" };
        return response(environment);
      }
      if (path === "/environments/env-app") return response(environment);
      if (path === "/services/srv-app/outbound-ips") return response({ ips: ["203.0.113.4"] });
      if (path === "/postgres/dpg-test" && method === "GET")
        return response({
          id: "dpg-test",
          owner: { id: "tea-test" },
          environmentId: "env-test",
          region: "oregon",
          ipAllowList,
        });
      if (path === "/postgres/dpg-test" && method === "PATCH") {
        ipAllowList = body.ipAllowList;
        return response({});
      }
      if (path.startsWith("/services?") && method === "GET") return response(service ? [{ service }] : []);
      if (path === "/services" && method === "POST") {
        activeEnv = body.envVars;
        service = {
          id: "srv-app",
          ...body,
          suspended: "not_suspended",
          serviceDetails: { ...body.serviceDetails, url: "https://qm-private" },
        };
        const deploy = { id: `dep-${deploys.length}`, status: "update_failed", commit: { id: "b".repeat(40) } };
        deploys.unshift(deploy);
        if (loseCreate) {
          loseCreate = false;
          throw new TypeError("connection lost");
        }
        return response({ service, deployId: deploy.id });
      }
      if (path === "/services/srv-app" && method === "GET") return service ? response(service) : response({}, 404);
      if (path === "/services/srv-app" && method === "PATCH") return response(service);
      if (path === "/services/srv-app/env-vars/QM_DEPLOYMENT_ID")
        return response({ value: activeEnv.find((row) => row.key === "QM_DEPLOYMENT_ID")?.value });
      if (path === "/services/srv-app/env-vars" && method === "PUT") {
        activeEnv = body;
        if (foreignDeployOnEnvWrite)
          deploys.unshift({ id: `dep-${deploys.length}`, status: "live", commit: { id: foreignDeployOnEnvWrite } });
        return response(body);
      }
      if (path === "/services/srv-app/secret-files" && method === "PUT") {
        manifestNonce = body.length ? JSON.parse(body[0].content).readinessNonce : undefined;
        return response(body);
      }
      if (path.startsWith("/services/srv-app/deploys?") && method === "GET")
        return response(deploys.map((deploy) => ({ deploy })));
      if (path.startsWith("/services/srv-app/deploys/"))
        return response(deploys.find((deploy) => path.endsWith(deploy.id)));
      if (path === "/services/srv-app/deploys" && method === "POST") {
        const deploymentId = activeEnv.find((row) => row.key === "QM_DEPLOYMENT_ID").value;
        assert.equal((await store.get(deploymentId))?.pending?.readinessNonce, manifestNonce);
        const deploy = { id: `dep-${deploys.length}`, status: outcome, commit: { id: builtCommit ?? body.commitId } };
        for (const previous of deploys)
          if (previous.status === "live" && outcome === "live") previous.status = "deactivated";
        deploys.unshift(deploy);
        if (loseUpdate) {
          loseUpdate = false;
          throw new TypeError("connection lost");
        }
        return response(deploy);
      }
      if (path === "/services/srv-app/suspend") {
        service.suspended = "suspended";
        return response({});
      }
      if (path === "/services/srv-app/resume") {
        service.suspended = "not_suspended";
        deploys.unshift({ id: `dep-${deploys.length}`, status: "update_failed", commit: { id: "b".repeat(40) } });
        return response({});
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  const provider = createRenderDeployProvider(options);
  const deployment: Deployment = {
    id: randomUUID(),
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions: [{ version: 1, createdAt: 1, entrypoint: "node app.js", snapshotDir: "/unused", commit: sha }],
  };
  return {
    store,
    calls,
    provider,
    data,
    deployment,
    failNextRequest(method: string, path: string, status?: number) {
      failure = { method, path, status };
    },
    get resourceSuspended() {
      return resourceSuspended;
    },
    get savedRegionBeforeCreate() {
      return savedRegionBeforeCreate;
    },
    get manifestNonce() {
      return manifestNonce;
    },
    set readinessNonce(value: string | null | undefined) {
      readinessNonce = value;
    },
    set outcome(value: string) {
      outcome = value;
    },
    set builtCommit(value: string | undefined) {
      builtCommit = value;
    },
    set foreignDeployOnEnvWrite(value: string | undefined) {
      foreignDeployOnEnvWrite = value;
    },
    set loseCreate(value: boolean) {
      loseCreate = value;
    },
    set loseUpdate(value: boolean) {
      loseUpdate = value;
    },
    get service() {
      return service;
    },
    get environment() {
      return environment;
    },
    restart(commit: string, nextAppRegion = options.appRegion) {
      return createRenderDeployProvider({
        ...options,
        appRegion: nextAppRegion,
        source: { ...options.source, commit },
      });
    },
    finishPending() {
      deploys[0].status = "live";
    },
  };
}

test("Render app region defaults to the core region and accepts a separate creation region", () => {
  assert.equal(loadConfig({}).renderDeploy.appRegion, "oregon");
  assert.equal(loadConfig({ RENDER_REGION: "ohio" }).renderDeploy.appRegion, "ohio");
  const config = loadConfig({ RENDER_REGION: "oregon", RENDER_APP_REGION: " virginia " });
  assert.equal(config.renderDeploy.region, "oregon");
  assert.equal(config.renderDeploy.appRegion, "virginia");
  assert.equal(config.renderSandbox.region, "oregon");
});

test("Render retains the app region through pending recovery, update, rollback, and archive after a default change", async () => {
  const f = fixture("virginia");
  const d = f.deployment;
  const v1 = d.versions[0]!;
  f.outcome = "build_in_progress";
  await assert.rejects(f.provider.apply(d, v1), /unconfirmed deployment/);
  assert.equal(f.savedRegionBeforeCreate, "virginia");
  assert.equal((await f.store.get(d.id))!.appRegion, "virginia");
  assert.equal(f.service.serviceDetails.region, "virginia");
  f.finishPending();
  f.outcome = "live";
  const restarted = f.restart(sha, "ohio");
  const endpoint = await restarted.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  assert.deepEqual(await restarted.resolveEndpoint!(d, v1), endpoint);
  assert.deepEqual(await restarted.apply(d, { ...v1, version: 2 }), endpoint);
  d.appliedVersion = 2;
  assert.deepEqual(await restarted.apply(d, v1), endpoint);
  await restarted.destroy(d);
  assert.equal(f.resourceSuspended, true);
  assert.deepEqual(await restarted.apply(d, v1), endpoint);
  assert.equal(f.resourceSuspended, false);
  assert.equal((await f.store.get(d.id))!.appRegion, "virginia");
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
  assert.ok(f.calls.some((call) => call.method === "PATCH" && call.path === "/postgres/dpg-test"));
  f.service.serviceDetails.region = "ohio";
  await assert.rejects(restarted.apply(d, { ...v1, version: 2 }), /expected diskless gated service/);
});

test("Legacy Render apps stay in the core region after the new app default changes", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const endpoint = await f.provider.apply(d, v1);
  const record = (await f.store.get(d.id))!;
  delete record.appRegion;
  await f.store.put(d.id, record);
  const restarted = f.restart(sha, "virginia");
  assert.deepEqual(await restarted.apply(d, { ...v1, version: 2 }), endpoint);
  await restarted.destroy(d);
  assert.equal(f.resourceSuspended, true);
  assert.deepEqual(await restarted.apply(d, v1), endpoint);
  assert.equal(f.resourceSuspended, false);
  assert.equal(f.service.serviceDetails.region, "oregon");
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
});

test("Render app create, update, rollback, and archive retain one diskless service and scoped data", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const endpoint = await f.provider.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  d.endpoint = endpoint;
  f.data.set("retained", "value");
  const v2 = { ...v1, version: 2, commit: "b".repeat(40) };
  const updated = await f.provider.apply(d, v2);
  d.appliedVersion = 2;
  assert.deepEqual(updated, endpoint);
  const updatedNonce = f.manifestNonce;
  await f.provider.apply(d, v1);
  assert.notEqual(f.manifestNonce, updatedNonce);
  assert.equal(f.data.get("retained"), "value");
  await f.provider.destroy(d);
  assert.equal(f.resourceSuspended, true);
  assert.equal(await f.provider.resolveEndpoint!(d, v1), null);
  d.status = "archived";
  const restored = await f.provider.apply(d, v1);
  assert.deepEqual(restored, endpoint);
  assert.equal(f.data.get("retained"), "value");
  assert.equal(f.resourceSuspended, false);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/services").length, 1);
  const created = f.calls.find((c) => c.method === "POST" && c.path === "/services")!.body;
  assert.equal(created.environmentId, "env-app");
  assert.equal(f.environment.networkIsolationEnabled, true);
  assert.equal(f.environment.projectId, "prj-test");
  assert.deepEqual(created.envVars, [{ key: "QM_DEPLOYMENT_ID", value: d.id }]);
  assert.deepEqual(created.secretFiles, []);
  assert.equal(created.serviceDetails.envSpecificDetails.dockerCommand, "/bin/sh -c exit 0");
  assert.equal(created.repo, "https://github.com/test/qm");
  assert.equal(created.serviceDetails.disk, undefined);
  assert.equal(created.serviceDetails.runtime, "docker");
  assert.equal(
    f.calls.some((c) => c.method === "DELETE"),
    false,
  );
  assert.ok(
    f.calls
      .filter((c) => c.method === "POST" && c.path === "/services/srv-app/deploys")
      .every((c) => c.body.commitId === sha),
  );
});

for (const commit of ["f".repeat(40), sha])
  test(`Render submits its own deploy when a deploy of ${commit === sha ? "the same" : "another"} commit starts during an update`, async () => {
    const f = fixture();
    const d = f.deployment;
    const v1 = d.versions[0]!;
    await f.provider.apply(d, v1);
    f.foreignDeployOnEnvWrite = commit;
    await f.provider.apply(d, { ...v1, version: 2 });
    const submitted = f.calls.filter((c) => c.method === "POST" && c.path === "/services/srv-app/deploys");
    assert.equal(submitted.length, 2);
    assert.ok(submitted.every((c) => c.body.commitId === sha));
    const record = (await f.store.get(d.id))!;
    assert.equal(record.liveVersion, 2);
    assert.equal(record.pending, undefined);
  });

test("Render clears a pending deploy built from another commit so a retry deploys again", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  await f.provider.apply(d, v1);
  f.builtCommit = "f".repeat(40);
  await assert.rejects(f.provider.apply(d, { ...v1, version: 2 }), /different Git commit/);
  assert.equal((await f.store.get(d.id))!.pending, undefined);
  f.builtCommit = undefined;
  await f.provider.apply(d, { ...v1, version: 2 });
  assert.equal((await f.store.get(d.id))!.liveVersion, 2);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/services/srv-app/deploys").length, 3);
});

test("Render recovers create and update replies without a duplicate service or deployment", async () => {
  const f = fixture();
  f.loseCreate = true;
  await f.provider.apply(f.deployment, f.deployment.versions[0]!);
  f.loseUpdate = true;
  await f.provider.apply(f.deployment, { ...f.deployment.versions[0]!, version: 2 });
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/services").length, 1);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/services/srv-app/deploys").length, 2);
  assert.equal((await f.store.get(f.deployment.id))!.liveVersion, 2);
});

for (const status of [undefined, 503]) {
  for (const operation of ["environment", "create", "resume", "deploy"] as const) {
    test(`Render retries ${operation} after ${status ?? "connection loss"} before the write and can archive`, async () => {
      const f = fixture();
      const d = f.deployment;
      const v1 = d.versions[0]!;
      const path = writePaths[operation];
      if (operation === "deploy" || operation === "resume") {
        d.endpoint = await f.provider.apply(d, v1);
        d.status = "running";
        d.appliedVersion = 1;
        if (operation === "resume") await f.provider.destroy(d);
      }
      const version = operation === "deploy" ? { ...v1, version: 2 } : v1;
      const posts = () => f.calls.filter((call) => call.method === "POST" && call.path === path);
      const before = posts().length;
      f.data.set("retained", "value");
      f.failNextRequest("POST", path, status);
      await assert.rejects(f.provider.apply(d, version), /503|connection lost|bootstrap is unconfirmed/);
      assert.equal(posts().length, before + 1);
      const restarted = f.restart(operation === "deploy" ? "c".repeat(40) : sha);
      await restarted.apply(d, version);
      assert.equal(posts().length, before + 2);
      if (operation === "deploy") assert.equal(posts().at(-1)!.body.commitId, sha);
      await restarted.destroy(d);
      assert.equal(posts().length, before + 2);
      assert.equal(f.resourceSuspended, true);
      const record = (await f.store.get(d.id))!;
      assert.equal(record.suspended, true);
      assert.equal(record.pending, undefined);
      assert.equal(record.bootstrap, undefined);
      assert.equal(f.data.get("retained"), "value");
    });
  }
}

for (const outcome of ["not_submitted", "build_in_progress", "old_instance"]) {
  test(`Render can archive and restore when a deployment is ${outcome}`, async () => {
    const f = fixture();
    const d = f.deployment;
    const v1 = d.versions[0]!;
    d.endpoint = await f.provider.apply(d, v1);
    d.status = "running";
    d.appliedVersion = 1;
    if (outcome === "not_submitted") f.failNextRequest("POST", "/services/srv-app/deploys");
    else if (outcome === "build_in_progress") f.outcome = outcome;
    else f.readinessNonce = f.manifestNonce;
    await assert.rejects(f.provider.apply(d, { ...v1, version: 2 }), /connection lost|unconfirmed/);
    const pending = (await f.store.get(d.id))!.pending;
    assert.ok(pending);
    const before = f.calls.length;
    const restarted = f.restart(sha);
    await restarted.destroy(d);
    assert.equal(f.resourceSuspended, true);
    assert.equal((await f.store.get(d.id))!.pending, undefined);
    assert.equal((await f.store.get(d.id))!.suspended, true);
    assert.equal(
      f.calls.slice(before).some((call) => call.path.includes("/deploys")),
      false,
    );
    f.finishPending();
    f.outcome = "live";
    f.readinessNonce = undefined;
    await restarted.apply(d, v1);
    assert.equal(f.resourceSuspended, false);
    assert.equal((await f.store.get(d.id))!.suspended, false);
  });
}

test("Render retains pending state when archive cannot confirm suspension", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  await f.provider.apply(d, v1);
  f.failNextRequest("POST", "/services/srv-app/deploys");
  await assert.rejects(f.provider.apply(d, { ...v1, version: 2 }), /connection lost/);
  const pending = (await f.store.get(d.id))!.pending;
  f.failNextRequest("POST", "/services/srv-app/suspend", 503);
  await assert.rejects(f.provider.destroy(d), /503/);
  assert.deepEqual((await f.store.get(d.id))!.pending, pending);
  assert.equal((await f.store.get(d.id))!.suspended, false);
  assert.equal(f.resourceSuspended, false);
  await f.restart(sha).destroy(d);
  assert.equal((await f.store.get(d.id))!.pending, undefined);
});

for (const status of [undefined, 200])
  test(`Render does not submit again after a ${status ?? "failed"} reconciliation response`, async () => {
    for (const operation of ["environment", "create", "deploy"] as const) {
      const f = fixture();
      const d = f.deployment;
      const v1 = d.versions[0]!;
      if (operation === "deploy") await f.provider.apply(d, v1);
      const path = writePaths[operation];
      f.failNextRequest("POST", path);
      await assert.rejects(f.provider.apply(d, { ...v1, version: 2 }), /connection lost|bootstrap is unconfirmed/);
      const posts = f.calls.filter((call) => call.method === "POST").length;
      f.failNextRequest("GET", `${path}?`, status);
      await assert.rejects(f.restart(sha).apply(d, { ...v1, version: 2 }), /connection lost|invalid app/);
      assert.equal(f.calls.filter((call) => call.method === "POST").length, posts);
    }
  });

test("A failed Render update keeps the live endpoint and does not suspend retained resources", async () => {
  const f = fixture();
  const d = f.deployment;
  const first = await f.provider.apply(d, d.versions[0]!);
  d.appliedVersion = 1;
  d.status = "running";
  f.outcome = "build_failed";
  await assert.rejects(f.provider.apply(d, { ...d.versions[0]!, version: 2 }), /build_failed/);
  assert.deepEqual(await f.provider.resolveEndpoint!(d, d.versions[0]!), first);
  assert.equal(f.resourceSuspended, false);
  assert.equal((await f.store.get(d.id))!.liveVersion, 1);
  assert.equal(
    f.calls.some((c) => c.path.endsWith("/suspend")),
    false,
  );
});

test("A restarted Render provider reconciles a pending deploy against its saved runner commit", async () => {
  const f = fixture();
  f.outcome = "build_in_progress";
  await assert.rejects(f.provider.apply(f.deployment, f.deployment.versions[0]!), /unconfirmed deployment/);
  assert.equal((await f.store.get(f.deployment.id))!.pending!.runnerCommit, sha);
  f.finishPending();
  const restarted = f.restart("c".repeat(40));
  await restarted.apply(f.deployment, f.deployment.versions[0]!);
  assert.equal((await f.store.get(f.deployment.id))!.liveVersion, 1);
  assert.equal((await f.store.get(f.deployment.id))!.pending, undefined);
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
});

test("Render waits for the new instance nonce through old responses, lost deploy replies, and restarts", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const endpoint = await f.provider.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  const firstNonce = f.manifestNonce;
  assert.match(firstNonce!, /^[a-zA-Z0-9_-]{43}$/);
  f.readinessNonce = firstNonce;
  f.loseUpdate = true;
  const v2 = { ...v1, version: 2 };
  await assert.rejects(f.provider.apply(d, v2), /unconfirmed deployment/);
  const pending = (await f.store.get(d.id))!;
  assert.equal(pending.liveVersion, 1);
  assert.notEqual(pending.pending!.readinessNonce, firstNonce);
  assert.equal(pending.pending!.readinessNonce, f.manifestNonce);
  assert.equal(f.resourceSuspended, false);
  assert.deepEqual(await f.provider.resolveEndpoint!(d, v1), endpoint);
  f.readinessNonce = null;
  const restarted = f.restart(sha);
  await assert.rejects(restarted.apply(d, v2), /unconfirmed deployment/);
  assert.equal((await f.store.get(d.id))!.pending!.readinessNonce, pending.pending!.readinessNonce);
  f.readinessNonce = undefined;
  assert.deepEqual(await restarted.apply(d, v2), endpoint);
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 2);
  assert.equal((await f.store.get(d.id))!.liveVersion, 2);
  d.appliedVersion = 2;
  f.readinessNonce = f.manifestNonce;
  const previousNonce = f.manifestNonce;
  await assert.rejects(restarted.apply(d, v2), /unconfirmed deployment/);
  assert.notEqual((await f.store.get(d.id))!.pending!.readinessNonce, previousNonce);
  f.readinessNonce = undefined;
  await f.restart(sha).apply(d, v2);
  assert.equal((await f.store.get(d.id))!.pending, undefined);
});

test("Render can reconcile a legacy pending deployment without a saved readiness nonce", async () => {
  const f = fixture();
  f.outcome = "build_in_progress";
  await assert.rejects(f.provider.apply(f.deployment, f.deployment.versions[0]!), /unconfirmed deployment/);
  const record = (await f.store.get(f.deployment.id))!;
  delete record.pending!.readinessNonce;
  await f.store.put(f.deployment.id, record);
  f.finishPending();
  f.readinessNonce = null;
  await f.restart(sha).apply(f.deployment, f.deployment.versions[0]!);
  assert.equal((await f.store.get(f.deployment.id))!.pending, undefined);
});

test("Render refuses changed service ownership and missing retained infrastructure", async () => {
  const f = fixture();
  await f.provider.apply(f.deployment, f.deployment.versions[0]!);
  f.service.environmentId = "env-other";
  const before = f.calls.length;
  await assert.rejects(
    f.provider.apply(f.deployment, { ...f.deployment.versions[0]!, version: 2 }),
    /expected diskless gated service/,
  );
  assert.equal(
    f.calls.slice(before).some((c) => c.method !== "GET"),
    false,
  );
});

test("Render resumes a dashboard-suspended service before reusing its live version", async () => {
  const f = fixture();
  const d = f.deployment;
  const version = d.versions[0]!;
  const endpoint = await f.provider.apply(d, version);
  f.service.suspended = "suspended";
  const before = f.calls.length;
  assert.deepEqual(await f.restart(sha).apply(d, version), endpoint);
  assert.equal(f.service.suspended, "not_suspended");
  assert.equal(f.calls.slice(before).filter((call) => call.path.endsWith("/resume")).length, 1);
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
});
