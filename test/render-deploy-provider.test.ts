import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRenderDeployProvider,
  type RenderDeployProviderOptions,
  type StoredRenderDeploy,
} from "../src/deploy/render-deploy-provider.ts";
import { createRenderDeployService } from "../src/deploy/render-deploy-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";
import { loadConfig } from "../src/config.ts";

const sha = "a".repeat(40);

function fixture(appRegion?: string) {
  const store = createMemoryMap<StoredRenderDeploy>();
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let service: any = null;
  let environment: any = null;
  let ipAllowList: any[] = [];
  const deploys: any[] = [];
  let outcome = "live";
  let loseCreate = false;
  let loseUpdate = false;
  let activeEnv: any[] = [];
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
      if (url.hostname === "qm-private") return response(undefined, 204);
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
        return response(body);
      }
      if (path === "/services/srv-app/secret-files" && method === "PUT") return response(body);
      if (path.startsWith("/services/srv-app/deploys?") && method === "GET")
        return response(deploys.map((deploy) => ({ deploy })));
      if (path.startsWith("/services/srv-app/deploys/"))
        return response(deploys.find((deploy) => path.endsWith(deploy.id)));
      if (path === "/services/srv-app/deploys" && method === "POST") {
        const deploy = { id: `dep-${deploys.length}`, status: outcome, commit: { id: body.commitId } };
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
    get resourceSuspended() {
      return resourceSuspended;
    },
    get savedRegionBeforeCreate() {
      return savedRegionBeforeCreate;
    },
    set outcome(value: string) {
      outcome = value;
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
  await f.provider.apply(d, v1);
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

test("Render service resets a confirmed failed version while retaining its history", async (t) => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), "qm-render-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deployStore = createDeployStore({ git: { repoRoot: join(root, "git") } });
  const deploy = createRenderDeployService({
    deployStore,
    provider: f.provider,
    renderStore: f.store,
    deployDir: root,
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
  });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    name: "sample",
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "first" }],
  });
  f.outcome = "build_failed";
  await assert.rejects(
    deploy.redeploy(d.id, { entrypoint: "node app.js", files: [{ path: "app.js", data: "second" }] }),
    /build_failed/,
  );
  const after = await deploy.getDeployment(d.id);
  assert.equal(after!.currentVersion, 1);
  assert.equal(after!.appliedVersion, 1);
  assert.equal(after!.versions.length, 2);
  assert.equal((await deploy.reachDeployment(d.id, "U1")).status, "ok");
});
