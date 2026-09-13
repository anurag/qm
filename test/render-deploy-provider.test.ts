import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRenderDeployProvider,
  type RenderDeployProviderOptions,
  type StoredRenderDeploy,
} from "../src/deploy/render-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const WORKSPACE = "tea-qm";
const SERVICE = "srv-qm";
const TOKEN = "rnd-test-key";
const IMAGE = "ghcr.io/example/qm-render-runner@sha256:abcd";
const SOURCE = { repo: "https://github.com/example/qm", branch: "feature/render" };

const deployment: Deployment = {
  id: ID,
  ownerScopeId: scopeId("personal", "U1"),
  createdBy: "U1",
  currentVersion: 1,
  status: "stopped",
  endpoint: null,
  versions: [],
};

const version: DeploymentVersion = {
  version: 1,
  createdAt: 100,
  entrypoint: "node server.js",
  snapshotDir: "/unused-app-snapshot",
  env: { APP_SECRET: "app-only-secret", PORT: "3000", QM_DEPLOYMENT_ID: "untrusted" },
};

interface Service {
  id: string;
  name: string;
  ownerId: string;
  type: string;
  suspended: string;
  environmentId?: string;
  serviceDetails: { url: string; region: string; numInstances: number; disk?: { mountPath: string; sizeGB: number } };
}

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

function fakeRender(
  opts: {
    existing?: boolean;
    appReachable?: boolean;
    environmentId?: string;
    missingDisk?: boolean;
    marker?: string;
    type?: string;
    region?: string;
    deployStatus?: string;
    suspendStatus?: number;
    suspended?: boolean;
    queued?: boolean;
    queuedListReads?: number;
    createWithoutDeployId?: boolean;
    loseCreateResponse?: boolean;
    loseTriggerResponse?: boolean;
    loseSuspendResponse?: boolean;
    intercept?: (call: Call) => Promise<Response | undefined>;
  } = {},
) {
  const calls: Call[] = [];
  const store = createMemoryMap<StoredRenderDeploy>();
  let service: Service | null = opts.existing ? newService() : null;
  let marker = opts.marker ?? ID;
  const artifact = {
    url: "https://core.example/v1/render/deploy-artifacts/a",
    token: "bundle-only-token",
    commit: "a".repeat(40),
    entrypoint: "node server.js",
  };
  const prepared: Array<[Deployment, DeploymentVersion]> = [];
  const revoked: string[] = [];
  let logPage = 0;
  let pendingDeployId: string | undefined;
  let deploySequence = 0;
  const nextDeployId = () => (++deploySequence === 1 ? "dep-next" : `dep-next${deploySequence}`);
  let queuedListReads = opts.queuedListReads ?? 0;
  function newService(): Service {
    return {
      id: SERVICE,
      name: `qm-app-${ID}`,
      ownerId: WORKSPACE,
      ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
      type: opts.type ?? "private_service",
      suspended: opts.suspended ? "suspended" : "not_suspended",
      serviceDetails: {
        url: "qm-app-internal:10000",
        region: opts.region ?? "oregon",
        numInstances: 1,
        disk: opts.missingDisk ? undefined : { mountPath: "/data", sizeGB: 1 },
      },
    };
  }
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "qm-app-internal") {
      assert.equal(url.port, "8080");
      if (opts.appReachable === false) throw new TypeError("App port is unavailable");
      return new Response("app ready");
    }
    assert.equal(url.origin, "https://api.render.com");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "error");
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, path, query: url.searchParams, body };
    calls.push(call);
    const intercepted = await opts.intercept?.(call);
    if (intercepted) return intercepted;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/services" && method === "GET") return json(service ? [{ service, cursor: "end" }] : []);
    if (path === "/services" && method === "POST") {
      service = newService();
      const created = body as { name: string; envVars: Array<{ key: string; value: string }> };
      service.name = created.name;
      marker = created.envVars.find((entry) => entry.key === "QM_DEPLOYMENT_ID")!.value;
      pendingDeployId = "dep-first";
      if (opts.loseCreateResponse) throw new TypeError("create response was lost");
      return json({ service, ...(opts.createWithoutDeployId ? {} : { deployId: pendingDeployId }) }, 201);
    }
    if (path === `/services/${SERVICE}` && method === "GET")
      return service ? json(service) : new Response(null, { status: 404 });
    if (path === `/services/${SERVICE}` && method === "DELETE") {
      const status = opts.suspendStatus ?? 204;
      if (status < 300) service = null;
      if (opts.loseSuspendResponse) throw new TypeError("delete response was lost");
      return status === 204 ? new Response(null, { status }) : json({}, status);
    }
    if (path === `/services/${SERVICE}/env-vars/QM_DEPLOYMENT_ID`)
      return json({ key: "QM_DEPLOYMENT_ID", value: marker });
    if (path === `/services/${SERVICE}/env-vars` && method === "PUT") {
      marker = (body as Array<{ key: string; value: string }>).find((v) => v.key === "QM_DEPLOYMENT_ID")!.value;
      return json([]);
    }
    if (path === `/services/${SERVICE}/secret-files` && method === "PUT") return json([]);
    if (path === `/services/${SERVICE}` && method === "PATCH") return json(service);
    if (path === `/services/${SERVICE}/suspend` && method === "POST") {
      const status = opts.suspendStatus ?? 202;
      if (status < 300 && service) service.suspended = "suspended";
      if (opts.loseSuspendResponse) throw new TypeError("suspend response was lost");
      return new Response(null, { status });
    }
    if (path === `/services/${SERVICE}/resume` && method === "POST") {
      if (service) service.suspended = "not_suspended";
      pendingDeployId = nextDeployId();
      return new Response(null, { status: 202 });
    }
    if (path === `/services/${SERVICE}/deploys` && method === "POST") {
      pendingDeployId = nextDeployId();
      if (opts.loseTriggerResponse) throw new TypeError("deploy response was lost");
      return opts.queued ? new Response(null, { status: 202 }) : json({ id: pendingDeployId }, 201);
    }
    if (path === `/services/${SERVICE}/deploys` && method === "GET") {
      const previous = opts.existing ? [{ deploy: { id: "dep-old", status: "live" } }] : [];
      if (url.searchParams.get("status") === "live")
        return json(
          pendingDeployId && (opts.deployStatus ?? "live") === "live"
            ? [{ deploy: { id: pendingDeployId, status: "live" } }]
            : previous,
        );
      if (!pendingDeployId || queuedListReads-- > 0) return json(previous);
      return json([{ deploy: { id: pendingDeployId, status: opts.deployStatus ?? "live" } }, ...previous]);
    }
    if (/\/deploys\/dep-(?:first|next[0-9]*)$/.test(path))
      return json({ id: path.split("/").at(-1), status: opts.deployStatus ?? "live" });
    if (path.endsWith("/cancel")) return json({ id: pendingDeployId, status: "canceled" });
    if (path === "/logs") {
      logPage++;
      return json(
        logPage === 1
          ? {
              logs: Array.from({ length: 100 }, (_, i) => ({ message: `line-${150 - i}` })),
              hasMore: true,
              nextStartTime: "2026-09-12T00:00:00Z",
              nextEndTime: "2026-09-12T00:30:00Z",
            }
          : {
              logs: Array.from({ length: 50 }, (_, i) => ({ message: `line-${50 - i}` })),
              hasMore: false,
            },
      );
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }) as typeof fetch;
  const provider = (extra: Partial<RenderDeployProviderOptions> = {}) =>
    createRenderDeployProvider({
      apiKey: TOKEN,
      workspaceId: WORKSPACE,
      baseImage: IMAGE,
      store,
      fetchImpl,
      pollIntervalMs: 1,
      deployTimeoutMs: 50,
      artifacts: {
        async prepare(d, v) {
          prepared.push([d, v]);
          return artifact;
        },
        async revoke(id) {
          revoked.push(id);
        },
      },
      ...extra,
    });
  return {
    provider,
    calls,
    prepared,
    revoked,
    artifact,
    store,
    releaseQueued: () => {
      queuedListReads = 0;
    },
  };
}

test("Render publish creates a private image service and waits for its deploy", async () => {
  const fake = fakeRender();
  const endpoint = await fake.provider().apply(deployment, version);
  assert.deepEqual(endpoint, { host: "qm-app-internal", port: 8080 });
  assert.equal(fake.prepared[0]![1], version);
  const created = fake.calls.find((call) => call.method === "POST" && call.path === "/services")!;
  assert.deepEqual(created.body, {
    type: "private_service",
    name: `qm-app-${ID}`,
    ownerId: WORKSPACE,
    autoDeploy: "no",
    image: { ownerId: WORKSPACE, imagePath: IMAGE },
    envVars: [
      { key: "APP_SECRET", value: "app-only-secret" },
      { key: "PORT", value: "8080" },
      { key: "QM_DEPLOYMENT_ID", value: ID },
      { key: "DATA_DIR", value: "/data" },
    ],
    secretFiles: [{ name: "qm-render-artifact.json", content: JSON.stringify(fake.artifact) }],
    serviceDetails: {
      runtime: "image",
      plan: "0.5c-512mb",
      region: "oregon",
      numInstances: 1,
      disk: { name: "data", mountPath: "/data", sizeGB: 1 },
    },
  });
  assert.equal(JSON.stringify(created.body).includes(TOKEN), false);
  assert.equal(
    fake.calls.some((call) => call.path.endsWith("/deploys/dep-first")),
    true,
  );
});

test("Render republish updates the same service before it starts a new deploy", async () => {
  const fake = fakeRender({ existing: true });
  await fake.provider().apply(deployment, { ...version, version: 2 });
  assert.deepEqual(
    fake.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`),
    [
      `PUT /services/${SERVICE}/env-vars`,
      `PUT /services/${SERVICE}/secret-files`,
      `PATCH /services/${SERVICE}`,
      `POST /services/${SERVICE}/deploys`,
    ],
  );
  assert.equal(fake.revoked.length, 0);
});

test("Render publish builds the app runner from Git and retains the app artifact and disk", async () => {
  const fake = fakeRender({ environmentId: "evm-production" });
  await fake
    .provider({ baseImage: undefined, source: SOURCE, environmentId: "evm-production" })
    .apply(deployment, version);
  const created = fake.calls.find((call) => call.method === "POST" && call.path === "/services")!;
  assert.deepEqual(created.body, {
    type: "private_service",
    name: `qm-app-${ID}`,
    ownerId: WORKSPACE,
    environmentId: "evm-production",
    autoDeploy: "no",
    ...SOURCE,
    rootDir: "",
    envVars: [
      { key: "APP_SECRET", value: "app-only-secret" },
      { key: "PORT", value: "8080" },
      { key: "QM_DEPLOYMENT_ID", value: ID },
      { key: "DATA_DIR", value: "/data" },
    ],
    secretFiles: [{ name: "qm-render-artifact.json", content: JSON.stringify(fake.artifact) }],
    serviceDetails: {
      runtime: "docker",
      envSpecificDetails: { dockerContext: ".", dockerfilePath: "deploy/render-runner/Dockerfile", dockerCommand: "" },
      plan: "0.5c-512mb",
      region: "oregon",
      numInstances: 1,
      disk: { name: "data", mountPath: "/data", sizeGB: 1 },
    },
  });
  assert.equal((await fake.store.get(ID))?.status, "live");
  assert.equal((await fake.store.get(ID))?.serviceId, SERVICE);
});

test("Render switches a retained image service to a Git runner without replacing its disk", async () => {
  const fake = fakeRender({ existing: true });
  await fake.provider({ baseImage: undefined, source: SOURCE }).apply(deployment, { ...version, version: 2 });
  assert.deepEqual(fake.calls.find((call) => call.method === "PATCH")?.body, {
    autoDeploy: "no",
    ...SOURCE,
    rootDir: "",
    serviceDetails: {
      runtime: "docker",
      envSpecificDetails: { dockerContext: ".", dockerfilePath: "deploy/render-runner/Dockerfile", dockerCommand: "" },
    },
  });
  assert.equal(
    fake.calls.some((call) => call.method === "POST" && call.path === "/services"),
    false,
  );
  assert.equal(
    fake.calls.some((call) => call.method === "DELETE"),
    false,
  );
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
  assert.equal((await fake.store.get(ID))?.serviceId, SERVICE);
  assert.equal((await fake.store.get(ID))?.liveVersion, 2);
});

test("Render Git runner updates and restores use the selected branch and the same service", async () => {
  const fake = fakeRender();
  await fake.provider({ baseImage: undefined, source: SOURCE }).apply(deployment, version);
  await fake
    .provider({ baseImage: undefined, source: { ...SOURCE, branch: "release" } })
    .apply(deployment, { ...version, version: 2 });
  await fake.provider({ baseImage: undefined, source: SOURCE }).destroy(deployment);
  await fake.provider({ baseImage: undefined, source: SOURCE }).apply(deployment, version);
  const patches = fake.calls.filter((call) => call.method === "PATCH");
  assert.equal((patches[0]?.body as { branch: string }).branch, "release");
  assert.equal((patches[1]?.body as { branch: string }).branch, SOURCE.branch);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/resume")).length, 1);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
  assert.equal(
    fake.calls.some((call) => call.method === "DELETE"),
    false,
  );
  assert.equal((await fake.store.get(ID))?.serviceId, SERVICE);
  assert.equal((await fake.store.get(ID))?.liveVersion, 1);
});

test("Render switches a retained Git runner to an image without replacing the service", async () => {
  const fake = fakeRender();
  await fake.provider({ baseImage: undefined, source: SOURCE }).apply(deployment, version);
  await fake.provider().apply(deployment, { ...version, version: 2 });
  assert.deepEqual(fake.calls.find((call) => call.method === "PATCH")?.body, {
    autoDeploy: "no",
    image: { ownerId: WORKSPACE, imagePath: IMAGE },
    serviceDetails: { runtime: "image" },
  });
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
  assert.equal(
    fake.calls.some((call) => call.method === "DELETE"),
    false,
  );
  assert.equal((await fake.store.get(ID))?.serviceId, SERVICE);
});

for (const terminalStatus of ["live", "update_failed", "canceled"]) {
  test(`Render waits for an existing queued deploy to become ${terminalStatus} before it updates the app`, async () => {
    let reads = 0;
    let finished = false;
    let triggered = false;
    const fake = fakeRender({
      existing: true,
      queued: true,
      async intercept(call) {
        if (call.path === `/services/${SERVICE}/deploys` && call.method === "GET" && !triggered) {
          finished = ++reads >= 3;
          return new Response(
            JSON.stringify([
              { deploy: { id: "dep-queued", status: finished ? terminalStatus : "queued" } },
              { deploy: { id: "dep-old", status: "live" } },
            ]),
          );
        }
        if (call.method !== "GET") assert.equal(finished, true);
        if (call.path === `/services/${SERVICE}/deploys` && call.method === "POST") triggered = true;
        return undefined;
      },
    });
    const provider = fake.provider({
      artifacts: {
        async prepare() {
          assert.equal(finished, true);
          return fake.artifact;
        },
        async revoke() {
          assert.fail("Previous artifacts must remain available");
        },
      },
    });
    assert.deepEqual(await provider.apply(deployment, { ...version, version: 2 }), {
      host: "qm-app-internal",
      port: 8080,
    });
    assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
    assert.deepEqual((await fake.store.get(ID))?.previousDeployIds, ["dep-queued", "dep-old"]);
    assert.equal((await fake.store.get(ID))?.liveVersion, 2);
  });
}

test("Render waits for an older queued deploy beyond the first history page", async () => {
  let reads = 0;
  let finished = false;
  let triggered = false;
  const recent = Array.from({ length: 100 }, (_, i) => ({
    deploy: { id: `dep-recent${i}`, status: "canceled" },
    cursor: `cursor${i}`,
  }));
  const fake = fakeRender({
    existing: true,
    queued: true,
    async intercept(call) {
      if (call.path === `/services/${SERVICE}/deploys` && call.method === "GET" && !triggered) {
        if (!call.query.has("cursor")) return new Response(JSON.stringify(recent));
        assert.equal(call.query.get("cursor"), "cursor99");
        finished = ++reads >= 2;
        return new Response(
          JSON.stringify([
            { deploy: { id: "dep-queued", status: finished ? "live" : "queued" } },
            { deploy: { id: "dep-old", status: "live" } },
          ]),
        );
      }
      if (call.method !== "GET") assert.equal(finished, true);
      if (call.path === `/services/${SERVICE}/deploys` && call.method === "POST") triggered = true;
      return undefined;
    },
  });
  await fake.provider().apply(deployment, version);
  const record = await fake.store.get(ID);
  assert.equal(record?.previousDeployIds.length, 102);
  assert.ok(record?.previousDeployIds.includes("dep-queued"));
  assert.equal(record?.deployId, "dep-next");
  assert.equal(record?.status, "live");
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
});

for (const cursor of [undefined, "", 17, "repeated"]) {
  test(`Render rejects an incomplete or repeated deploy history cursor: ${String(cursor)}`, async () => {
    const fake = fakeRender({
      existing: true,
      async intercept(call) {
        if (call.path === `/services/${SERVICE}/deploys` && call.method === "GET")
          return new Response(
            JSON.stringify(
              Array.from({ length: 100 }, (_, i) => ({
                deploy: { id: `dep-old${i}`, status: "live" },
                cursor,
              })),
            ),
          );
        return undefined;
      },
    });
    await assert.rejects(fake.provider().apply(deployment, version), /invalid pagination cursor/);
    assert.ok(fake.calls.every((call) => call.method === "GET"));
    assert.equal(fake.prepared.length, 0);
    assert.equal(await fake.store.get(ID), null);
    assert.equal(
      fake.calls.filter((call) => call.path === `/services/${SERVICE}/deploys`).length,
      cursor === "repeated" ? 2 : 1,
    );
  });
}

test("Render waits for a configuration deploy before it submits the requested app deploy", async () => {
  let configChanged = false;
  let finished = false;
  let reads = 0;
  let triggered = false;
  const fake = fakeRender({
    existing: true,
    queued: true,
    async intercept(call) {
      if (call.path === `/services/${SERVICE}` && call.method === "PATCH") configChanged = true;
      if (call.path === `/services/${SERVICE}/deploys` && call.method === "GET" && configChanged && !triggered) {
        finished = ++reads >= 2;
        return new Response(
          JSON.stringify([
            { deploy: { id: "dep-config", status: finished ? "live" : "queued" } },
            { deploy: { id: "dep-old", status: "live" } },
          ]),
        );
      }
      if (call.path === `/services/${SERVICE}/deploys` && call.method === "POST") {
        assert.equal(finished, true);
        triggered = true;
      }
      return undefined;
    },
  });
  await fake.provider().apply(deployment, version);
  assert.deepEqual((await fake.store.get(ID))?.previousDeployIds, ["dep-config", "dep-old"]);
  assert.equal((await fake.store.get(ID))?.status, "live");
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
});

test("Render leaves a prior queued deploy unchanged when it exceeds the wait deadline", async () => {
  let finished = false;
  const fake = fakeRender({
    existing: true,
    async intercept(call) {
      if (call.path === `/services/${SERVICE}/deploys` && call.method === "GET" && !finished)
        return new Response(JSON.stringify([{ deploy: { id: "dep-queued", status: "queued" } }]));
      return undefined;
    },
  });
  await assert.rejects(fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version), /dep-queued is still queued/);
  assert.ok(fake.calls.every((call) => call.method === "GET"));
  assert.equal(fake.prepared.length, 0);
  assert.equal(await fake.store.get(ID), null);
  finished = true;
  await fake.provider().apply(deployment, version);
  assert.equal((await fake.store.get(ID))?.status, "live");
});

test("Render follows a queued deploy without triggering another deploy or accepting the old live version", async () => {
  const fake = fakeRender({ existing: true, queued: true, queuedListReads: 2 });
  const endpoint = await fake.provider().apply(deployment, version);
  assert.deepEqual(endpoint, { host: "qm-app-internal", port: 8080 });
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
  assert.equal(fake.calls.filter((call) => call.method === "GET" && call.path.endsWith("/deploys")).length, 5);
  assert.equal(
    fake.calls.some((call) => call.path.endsWith("/deploys/dep-next")),
    true,
  );
  assert.equal(
    fake.calls.some((call) => call.path.endsWith("/deploys/dep-old")),
    false,
  );
});

test("Render follows the resume deploy without submitting another deploy", async () => {
  const fake = fakeRender({ existing: true, suspended: true });
  await fake.provider().apply(deployment, version);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/resume")).length, 1);
  assert.equal(
    fake.calls.some((call) => call.method === "POST" && call.path.endsWith("/deploys")),
    false,
  );
  assert.equal((await fake.store.get(ID))?.status, "live");
});

test("Render finds the initial deploy when service creation omits its deploy ID", async () => {
  const fake = fakeRender({ createWithoutDeployId: true });
  await fake.provider().apply(deployment, version);
  assert.equal(
    fake.calls.some((call) => call.method === "POST" && call.path.endsWith("/deploys")),
    false,
  );
  assert.equal(
    fake.calls.some((call) => call.path.endsWith("/deploys/dep-first")),
    true,
  );
});

test("Render reconciles an accepted trigger when its response is lost", async () => {
  const fake = fakeRender({ existing: true, loseTriggerResponse: true });
  const endpoint = await fake.provider().apply(deployment, version);
  assert.deepEqual(endpoint, { host: "qm-app-internal", port: 8080 });
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
  assert.equal((await fake.store.get(ID))?.status, "live");
});

test("Render reconciles an accepted service creation when its response is lost", async () => {
  const fake = fakeRender({ loseCreateResponse: true });
  await fake.provider().apply(deployment, version);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
  assert.equal(
    fake.calls.some((call) => call.method === "DELETE"),
    false,
  );
  assert.deepEqual(fake.revoked, []);
  assert.equal((await fake.store.get(ID))?.status, "live");
});

test("Render retains an undiscovered queued deploy across provider restarts and blocks duplicate triggers", async () => {
  const fake = fakeRender({ existing: true, queued: true, queuedListReads: Infinity });
  const running = { ...deployment, status: "running" as const, appliedVersion: 0 };
  const provider = fake.provider({ deployTimeoutMs: 5 });
  await provider.resolveEndpoint!(running, version);
  await assert.rejects(provider.apply(running, version), /still pending/);
  assert.equal((await fake.store.get(ID))?.status, "pending");
  assert.equal(await provider.resolveEndpoint!(running, version), null);
  const restarted = fake.provider({ deployTimeoutMs: 5 });
  await assert.rejects(restarted.apply(running, { ...version, version: 2 }), /still pending/);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
  assert.equal(fake.prepared.length, 1);
  fake.releaseQueued();
  assert.deepEqual(await restarted.apply(running, version), { host: "qm-app-internal", port: 8080 });
  assert.equal(await restarted.resolveEndpoint!(running, version), null);
  assert.deepEqual(await restarted.resolveEndpoint!({ ...running, appliedVersion: 1 }, version), {
    host: "qm-app-internal",
    port: 8080,
  });
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
});

for (const cancelStatus of [200, 503]) {
  test(`Render retains a deploy when cancellation with HTTP ${cancelStatus} does not confirm a terminal state`, async () => {
    let status = "update_in_progress";
    const fake = fakeRender({
      existing: true,
      async intercept(call) {
        if (call.path.endsWith("/deploys/dep-next")) return new Response(JSON.stringify({ id: "dep-next", status }));
        if (call.path.endsWith("/dep-next/cancel"))
          return new Response(JSON.stringify({ id: "dep-next", status }), { status: cancelStatus });
        return undefined;
      },
    });
    const running = { ...deployment, status: "running" as const, appliedVersion: 0 };
    await assert.rejects(fake.provider({ deployTimeoutMs: 5 }).apply(running, version), /still pending/);
    assert.equal((await fake.store.get(ID))?.status, "pending");
    const restarted = fake.provider();
    assert.equal(await restarted.resolveEndpoint!(running, version), null);
    status = "live";
    assert.deepEqual(await restarted.apply(running, version), { host: "qm-app-internal", port: 8080 });
    assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
    assert.equal(await restarted.resolveEndpoint!(running, version), null);
    assert.equal(fake.revoked.length, 0);
  });
}

test("Render retains uncertain creation and suspension until the owned service can be found", async () => {
  let visible = false;
  const fake = fakeRender({
    loseCreateResponse: true,
    async intercept(call) {
      return !visible && call.path === "/services" && call.method === "GET" ? new Response("[]") : undefined;
    },
  });
  await assert.rejects(fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version), /still pending/);
  assert.equal((await fake.store.get(ID))?.status, "pending");
  await assert.rejects(fake.provider().destroy(deployment), /still pending/);
  assert.equal((await fake.store.get(ID))?.status, "suspending");
  assert.deepEqual(fake.revoked, []);
  visible = true;
  await fake.provider().destroy(deployment);
  assert.equal((await fake.store.get(ID))?.status, "suspended");
  assert.deepEqual(fake.revoked, [ID]);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
});

test("Render reconciles a lost suspension response before revoking access", async () => {
  const fake = fakeRender({ existing: true, loseSuspendResponse: true });
  await assert.rejects(fake.provider().destroy(deployment), /still pending/);
  assert.equal((await fake.store.get(ID))?.status, "suspending");
  assert.deepEqual(fake.revoked, []);
  await fake.provider().destroy(deployment);
  assert.equal((await fake.store.get(ID))?.status, "suspended");
  assert.deepEqual(fake.revoked, [ID]);
  assert.equal(fake.calls.filter((call) => call.path.endsWith("/suspend")).length, 1);
  assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
});

test("Render resumes cleanup after a crash saved the first deploy failure", async () => {
  const fake = fakeRender({ existing: true, deployStatus: "update_failed" });
  await fake.store.put(ID, {
    deploymentId: ID,
    version: 1,
    status: "failed",
    createdService: true,
    previousDeployIds: [],
    serviceId: SERVICE,
    deployId: "dep-first",
  });
  await assert.rejects(fake.provider().apply(deployment, { ...version, version: 2 }), /update_failed/);
  assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 0);
  assert.equal(
    fake.calls.some((call) => call.method === "POST" && call.path.endsWith("/deploys")),
    false,
  );
  assert.deepEqual(fake.revoked, [ID]);
  assert.equal((await fake.store.get(ID))?.status, "failed");
});

test("Render retains cleanup ownership when suspension of a failed first service fails", async () => {
  const options = { existing: true, suspendStatus: 503 };
  const fake = fakeRender(options);
  await fake.store.put(ID, {
    deploymentId: ID,
    version: 1,
    status: "failed",
    createdService: true,
    previousDeployIds: [],
    serviceId: SERVICE,
    deployId: "dep-first",
  });
  await assert.rejects(fake.provider().apply(deployment, { ...version, version: 2 }), /still pending/);
  assert.equal((await fake.store.get(ID))?.status, "suspending");
  assert.equal((await fake.store.get(ID))?.createdService, true);
  assert.equal(
    fake.calls.some((call) => call.method === "POST" && !call.path.endsWith("/suspend")),
    false,
  );
  options.suspendStatus = 204;
  await fake.provider().apply(deployment, { ...version, version: 2 });
  assert.equal((await fake.store.get(ID))?.status, "live");
  assert.equal((await fake.store.get(ID))?.createdService, false);
});

test("Render finishes cleanup of a rejected create that stopped before artifact revocation", async () => {
  const fake = fakeRender();
  await fake.store.put(ID, {
    deploymentId: ID,
    version: 1,
    status: "failed",
    createdService: true,
    previousDeployIds: [],
  });
  await fake.provider().apply(deployment, version);
  assert.deepEqual(fake.revoked, [ID]);
  assert.equal((await fake.store.get(ID))?.status, "live");
  assert.equal((await fake.store.get(ID))?.createdService, false);
});

test("Render requires operator recovery when a saved request has no observable remote operation", async () => {
  const fake = fakeRender();
  await fake.store.put(ID, {
    deploymentId: ID,
    version: 1,
    status: "pending",
    createdService: true,
    previousDeployIds: [],
  });
  await assert.rejects(
    fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version),
    /operator recovery is required/,
  );
  await assert.rejects(fake.provider().destroy(deployment), /operator recovery is required/);
  assert.equal(
    fake.calls.some((call) => call.method !== "GET"),
    false,
  );
  assert.notEqual(await fake.store.get(ID), null);
});

test("Render can clear an ambiguous deploy by suspending its known service", async () => {
  const fake = fakeRender({ existing: true });
  await fake.store.put(ID, {
    deploymentId: ID,
    version: 1,
    status: "pending",
    createdService: false,
    previousDeployIds: ["dep-old"],
    serviceId: SERVICE,
  });
  await assert.rejects(
    fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version),
    /operator recovery is required/,
  );
  await fake.provider().destroy(deployment);
  assert.equal((await fake.store.get(ID))?.status, "suspended");
  assert.equal(fake.calls.filter((call) => call.path.endsWith("/suspend")).length, 1);
  assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
  await fake.provider().apply(deployment, version);
  assert.equal((await fake.store.get(ID))?.status, "live");
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 0);
});

test("Render records the pending operation before submission and keeps secrets out of its state", async () => {
  const fake = fakeRender({
    async intercept(call) {
      if (call.method === "POST" && call.path === "/services") {
        const record = await fake.store.get(ID);
        assert.equal(record?.status, "pending");
        assert.equal(record?.version, 1);
      }
      return undefined;
    },
  });
  await fake.provider().apply(deployment, version);
  const state = JSON.stringify(await fake.store.get(ID));
  for (const secret of [TOKEN, fake.artifact.token, fake.artifact.url, version.env!.APP_SECRET!]) {
    assert.equal(state.includes(secret), false);
  }
  const restarted = fake.provider();
  assert.equal(await restarted.resolveEndpoint!(deployment, version), null);
  await restarted.apply(deployment, version);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
  assert.equal(fake.prepared.length, 1);
});

test("Render does not submit work when pending state cannot be stored", async () => {
  const fake = fakeRender();
  await assert.rejects(
    fake
      .provider({
        store: {
          ...fake.store,
          async put() {
            throw new Error("store unavailable");
          },
        },
      })
      .apply(deployment, version),
    /store unavailable/,
  );
  assert.equal(
    fake.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("Render keeps an accepted deploy while transient poll errors recover", async () => {
  let polls = 0;
  const fake = fakeRender({
    async intercept(call) {
      if (!call.path.endsWith("/deploys/dep-first")) return undefined;
      polls++;
      if (polls === 1) return new Response(null, { status: 429, headers: { "retry-after": "0" } });
      if (polls === 2) throw new TypeError("fetch failed");
      if (polls === 3) return new Response(null, { status: 503 });
      return undefined;
    },
  });
  await fake.provider().apply(deployment, version);
  assert.equal(polls, 4);
  assert.equal(
    fake.calls.some((call) => call.path.endsWith("/cancel") || call.method === "DELETE"),
    false,
  );
  assert.deepEqual(fake.revoked, []);
});

test("Render cancels a replacement after a permanent poll error and keeps the previous service", async () => {
  const fake = fakeRender({
    existing: true,
    async intercept(call) {
      return call.path.endsWith("/deploys/dep-next") ? new Response(null, { status: 403 }) : undefined;
    },
  });
  const provider = fake.provider();
  await assert.rejects(provider.apply(deployment, version), /HTTP 403/);
  assert.equal(fake.calls.filter((call) => call.path.endsWith("/deploys/dep-next")).length, 1);
  assert.equal(
    fake.calls.some((call) => call.path.endsWith("/dep-next/cancel")),
    true,
  );
  assert.equal(
    fake.calls.some((call) => call.method === "DELETE"),
    false,
  );
  assert.deepEqual(await provider.resolveEndpoint!(deployment, version), { host: "qm-app-internal", port: 8080 });
  assert.deepEqual(fake.revoked, []);
});

test("Render retains a new service and its disk when polling cannot recover before the deadline", async () => {
  const fake = fakeRender({
    async intercept(call) {
      return call.path.endsWith("/deploys/dep-first") ? new Response(null, { status: 503 }) : undefined;
    },
  });
  await assert.rejects(fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version), /HTTP 503/);
  assert.equal(
    fake.calls.some((call) => call.path.endsWith("/dep-first/cancel")),
    true,
  );
  assert.equal(
    fake.calls.some((call) => call.method === "DELETE"),
    false,
  );
  assert.deepEqual(fake.revoked, [ID]);
});

test("Render accepts a deploy that becomes live while cancellation is requested", async () => {
  const fake = fakeRender({
    deployStatus: "update_in_progress",
    async intercept(call) {
      return call.path.endsWith("/dep-first/cancel")
        ? new Response(JSON.stringify({ id: "dep-first", status: "live" }))
        : undefined;
    },
  });
  await fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version);
  assert.equal(
    fake.calls.some((call) => call.method === "DELETE"),
    false,
  );
  assert.deepEqual(fake.revoked, []);
});

for (const options of [{ marker: "someone-else" }, { type: "web_service" }, { region: "frankfurt" }]) {
  test(`Render refuses unrelated services: ${JSON.stringify(options)}`, async () => {
    const fake = fakeRender({ existing: true, ...options });
    await assert.rejects(fake.provider().apply(deployment, version), /another deployment|expected private/);
    await assert.rejects(fake.provider().destroy(deployment), /another deployment|expected private/);
    assert.equal(fake.prepared.length, 0);
    assert.equal(fake.revoked.length, 0);
    assert.equal(
      fake.calls.every((call) => call.method === "GET"),
      true,
    );
  });
}

test("Render failed replacement preserves the service and previous live deploy", async () => {
  const fake = fakeRender({ existing: true, deployStatus: "update_failed" });
  const provider = fake.provider();
  await assert.rejects(provider.apply(deployment, version), /update_failed/);
  assert.deepEqual(await provider.resolveEndpoint!(deployment, version), { host: "qm-app-internal", port: 8080 });
  assert.equal(
    fake.calls.some((call) => call.method === "DELETE"),
    false,
  );
  assert.equal(fake.revoked.length, 0);
});

test("Render cancels a deploy that exceeds the startup deadline", async () => {
  const fake = fakeRender({ deployStatus: "update_in_progress" });
  await assert.rejects(fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version), /did not become live/);
  assert.equal(
    fake.calls.some((call) => call.path.endsWith("/dep-first/cancel")),
    true,
  );
});

test("Render destroy revokes artifacts only after service suspension succeeds", async () => {
  const failed = fakeRender({ existing: true, suspendStatus: 503 });
  await assert.rejects(failed.provider().destroy(deployment), /pending/);
  assert.deepEqual(failed.revoked, []);
  const fake = fakeRender({ existing: true });
  await fake.provider().destroy(deployment);
  await fake.provider().destroy(deployment);
  assert.deepEqual(fake.revoked, [ID, ID]);
  assert.equal(fake.calls.filter((call) => call.path.endsWith("/suspend")).length, 1);
  assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
});

test("Render logs page backward and return output in time order", async () => {
  const fake = fakeRender({ existing: true });
  const logs = await fake.provider().logs!(deployment, { tailLines: 150 });
  assert.deepEqual(
    logs?.split("\n"),
    Array.from({ length: 150 }, (_, i) => `line-${i + 1}`),
  );
  const calls = fake.calls.filter((call) => call.path === "/logs");
  assert.deepEqual(
    calls.map((call) => call.query.get("limit")),
    ["100", "50"],
  );
  assert.equal(calls[1]!.query.get("endTime"), "2026-09-12T00:30:00Z");
  assert.equal(calls[0]!.query.get("startTime"), "1970-01-01T00:00:00.000Z");
  assert.ok(Date.parse(calls[0]!.query.get("endTime")!) > Date.now() - 1000);
  assert.equal(calls[0]!.query.get("resource"), SERVICE);
});

test("Render coalesces endpoint refreshes and caches their result across app requests", async () => {
  const fake = fakeRender({ existing: true });
  const provider = fake.provider();
  const endpoints = await Promise.all(
    Array.from({ length: 100 }, () => provider.resolveEndpoint!(deployment, version)),
  );
  for (const endpoint of endpoints) assert.deepEqual(endpoint, { host: "qm-app-internal", port: 8080 });
  for (let i = 0; i < 100; i++) await provider.resolveEndpoint!(deployment, version);
  assert.equal(fake.calls.length, 3);
});

test("Render clears cached endpoints after apply and destroy", async () => {
  const fake = fakeRender({ existing: true });
  const provider = fake.provider();
  await provider.resolveEndpoint!(deployment, version);
  await provider.apply(deployment, version);
  const callsAfterApply = fake.calls.length;
  await provider.resolveEndpoint!({ ...deployment, appliedVersion: 1 }, version);
  assert.equal(fake.calls.length - callsAfterApply, 3);
  await provider.destroy(deployment);
  assert.equal(await provider.resolveEndpoint!(deployment, version), null);
});

test("Render does not restore an old cache entry when a refresh finishes after destroy", async () => {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response | undefined>();
  const fake = fakeRender({
    existing: true,
    async intercept(call) {
      if (call.path.endsWith("/deploys") && call.query.get("status") === "live") {
        reading.resolve();
        return release.promise;
      }
      return undefined;
    },
  });
  const provider = fake.provider();
  const pending = provider.resolveEndpoint!(deployment, version);
  await reading.promise;
  await provider.destroy(deployment);
  release.resolve(new Response(JSON.stringify([{ deploy: { id: "dep-old", status: "live" } }])));
  await pending;
  assert.equal(await provider.resolveEndpoint!(deployment, version), null);
});

test("Render clears cached endpoints when apply fails", async () => {
  const fake = fakeRender({
    existing: true,
    async intercept(call) {
      return call.method === "PATCH" ? new Response(null, { status: 400 }) : undefined;
    },
  });
  const provider = fake.provider();
  await provider.resolveEndpoint!(deployment, version);
  await assert.rejects(provider.apply(deployment, version), /HTTP 400/);
  const callsAfterApply = fake.calls.length;
  await provider.resolveEndpoint!(deployment, version);
  assert.equal(fake.calls.length - callsAfterApply, 3);
});

test("Render requires credentials and runner configuration before it prepares artifacts", async () => {
  const fake = fakeRender();
  for (const extra of [{ apiKey: "" }, { workspaceId: "" }, { baseImage: "" }]) {
    await assert.rejects(fake.provider(extra).apply(deployment, version), /required/);
  }
  assert.equal(fake.prepared.length, 0);
  assert.equal(fake.calls.length, 0);
});

test("Render rejects mixed or incomplete app runner sources before it prepares artifacts", async () => {
  const fake = fakeRender();
  await assert.rejects(fake.provider({ source: SOURCE }).apply(deployment, version), /not both/);
  for (const source of [
    { ...SOURCE, repo: "" },
    { ...SOURCE, branch: "" },
  ])
    await assert.rejects(
      fake.provider({ baseImage: undefined, source }).apply(deployment, version),
      /must be set together/,
    );
  assert.equal(fake.prepared.length, 0);
  assert.equal(fake.calls.length, 0);
});

test("Render serializes app mutations under the shared deployment lock", async () => {
  const fake = fakeRender();
  const locks: string[] = [];
  let active = false;
  const provider = fake.provider({
    advisoryLock: {
      async withLock(key, run) {
        assert.equal(active, false);
        active = true;
        locks.push(key);
        try {
          return await run();
        } finally {
          active = false;
        }
      },
    },
  });
  await Promise.all([provider.apply(deployment, version), provider.apply(deployment, { ...version, version: 2 })]);
  await provider.destroy(deployment);
  assert.deepEqual(
    locks,
    Array.from({ length: 3 }, () => `render-deploy:${ID}`),
  );
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
});

test("Render waits for the app port even when the platform reports a live deploy", async () => {
  const fake = fakeRender({ appReachable: false });
  await assert.rejects(fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version), /HTTP on port 8080/);
  assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
});

test("Render restores the same disk and scopes apps to the configured environment", async () => {
  const fake = fakeRender({ environmentId: "evm-production" });
  const provider = fake.provider({ environmentId: "evm-production", diskSizeGB: 3 });
  await provider.apply(deployment, version);
  const created = fake.calls.find((call) => call.method === "POST" && call.path === "/services")!.body as {
    environmentId: string;
    serviceDetails: { disk: { sizeGB: number } };
  };
  assert.equal(created.environmentId, "evm-production");
  assert.equal(created.serviceDetails.disk.sizeGB, 3);
  await provider.destroy(deployment);
  assert.equal((await fake.store.get(ID))?.status, "suspended");
  assert.equal(await provider.resolveEndpoint!({ ...deployment, status: "archived" }, version), null);
  const prepared = fake.prepared.length;
  await provider.apply({ ...deployment, status: "archived" }, version);
  assert.equal(fake.prepared.length, prepared + 1);
  assert.equal(fake.calls.filter((call) => call.path === "/services" && call.method === "POST").length, 1);
  assert.ok(fake.calls.some((call) => call.path.endsWith("/resume")));
  assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
});

test("Render refuses a retained app that lost its disk or moved environments", async () => {
  const missing = fakeRender({ existing: true, missingDisk: true });
  await assert.rejects(missing.provider().apply(deployment, version), /persistent \/data disk/);
  const moved = fakeRender({ existing: true, environmentId: "evm-other" });
  await assert.rejects(
    moved.provider({ environmentId: "evm-production" }).apply(deployment, version),
    /expected private app service/,
  );
  assert.equal(missing.prepared.length + moved.prepared.length, 0);
});

test("Render rollback uses the selected old version on the retained service", async () => {
  const fake = fakeRender();
  const provider = fake.provider();
  await provider.apply(deployment, { ...version, version: 2 });
  await provider.apply({ ...deployment, appliedVersion: 2 }, version);
  assert.equal(fake.prepared.at(-1)![1].version, 1);
  assert.equal((await fake.store.get(ID))?.liveVersion, 1);
  assert.equal(fake.calls.filter((call) => call.path === "/services" && call.method === "POST").length, 1);
});

test(
  "Render lifecycle uses one Postgres session through the deployment service",
  { skip: !process.env.DATABASE_URL, timeout: 15_000 },
  async (t) => {
    const url = process.env.DATABASE_URL!;
    configurePgPooling({ databaseUrl: url, sessionMax: 1, queryMax: 1 });
    const pg = createPgPool(url);
    const dir = mkdtempSync(join(tmpdir(), "render-deploy-pg-"));
    t.after(async () => {
      await pg.close();
      configurePgPooling({});
      rmSync(dir, { recursive: true, force: true });
    });
    const fake = fakeRender();
    const store = createDeployStore({ git: { repoRoot: join(dir, "git") } });
    const service = createDeployService({
      deployStore: store,
      provider: fake.provider(),
      advisoryLock: createPostgresAdvisoryLock(pg),
      acl: createAclStore(),
      deployDir: join(dir, "apps"),
      auditLog: { record() {}, events: async () => [], tail: async () => [] },
    });
    const d = await service.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "node app.js",
      files: [],
    });
    await service.redeploy(d.id, { entrypoint: "node app.js", files: [] });
    await service.archiveDeployment(d.id);
    await service.restoreDeployment(d.id, "U1");
    assert.equal((await store.get(d.id))!.status, "running");
    assert.equal((await pg.sessionPool()).options.max, 1);
    assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
  },
);

test("Render archive clears a rejected create without changing it into an uncertain operation", async () => {
  const fake = fakeRender();
  await fake.store.put(ID, {
    deploymentId: ID,
    version: 1,
    status: "failed",
    createdService: true,
    previousDeployIds: [],
  });
  await fake.provider().destroy(deployment);
  assert.equal(await fake.store.get(ID), null);
  assert.deepEqual(fake.revoked, [ID]);
  assert.ok(fake.calls.every((call) => call.method === "GET"));
  await fake.provider().apply(deployment, version);
  assert.equal((await fake.store.get(ID))?.status, "live");
});
