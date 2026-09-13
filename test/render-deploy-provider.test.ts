import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { configurePgPooling, createPgPool } from "../src/persistence/pg-pool.ts";
import { createMemoryAdvisoryLock, createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
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
import { fetch as undiciFetch, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { createFakeRenderGateways } from "./support/fake-render-gateways.ts";
import { createRenderDeployGateways, type StoredRenderGateway } from "../src/deploy/render-deploy-gateways.ts";
import {
  RENDER_GATEWAY_APP_HEADER,
  RENDER_GATEWAY_AUTH_HEADER,
  renderGatewayAppToken,
} from "../src/deploy/render-caddy.ts";

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
    attachedDisk?: boolean;
    appStatus?: number;
    appFetch?: typeof fetch;
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
  const gatewayStore = createMemoryMap<StoredRenderGateway>();
  const network = {
    calls: [] as Call[],
    ips: ["203.0.113.1"],
    projectId: "prj-qm",
    before: undefined as ((call: Call) => Promise<Response | undefined>) | undefined,
    database: {
      id: "dpg-qm-a",
      owner: { id: WORKSPACE },
      region: "oregon",
      environmentId: "evm-production",
      ipAllowList: [{ cidrBlock: "203.0.113.1/32", description: "Retained egress" }],
    },
  };
  const gateway = createFakeRenderGateways({
    workspaceId: WORKSPACE,
    projectId: "prj-qm",
    moveResource(id, environmentId) {
      assert.equal(id, SERVICE);
      if (service) service.environmentId = environmentId;
    },
  });
  let service: Service | null = opts.existing ? newService() : null;
  const ready = opts.existing
    ? createRenderDeployGateways({
        request: gateway.request,
        fetchImpl: gateway.fetchImpl,
        workspaceId: WORKSPACE,
        projectId: "prj-qm",
        prefix: "qm-app",
        region: "oregon",
        store: gatewayStore,
        timeoutMs: 100,
        pollMs: 1,
      }).upsert(deployment.ownerScopeId, ID, { host: "qm-app-internal", port: 8080 })
    : Promise.resolve();
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
      environmentId: opts.environmentId ?? "env-gw-1",
      type: opts.type ?? "private_service",
      suspended: opts.suspended ? "suspended" : "not_suspended",
      serviceDetails: {
        url: "qm-app-internal:10000",
        region: opts.region ?? "oregon",
        numInstances: 1,
        ...(opts.attachedDisk ? { disk: { mountPath: "/data", sizeGB: 1 } } : {}),
      },
    };
  }
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    await ready;
    if (url.hostname.endsWith(".onrender.com")) {
      if (new Headers(init.headers).has(RENDER_GATEWAY_APP_HEADER)) {
        if (opts.appFetch) return opts.appFetch(input, init);
        if (opts.appReachable === false) throw new TypeError("App port is unavailable");
        if (opts.appStatus !== undefined) return new Response("app ready", { status: opts.appStatus });
      }
      return gateway.fetchImpl(input, init);
    }
    assert.notEqual(url.hostname, "qm-app-internal", "core must not connect to isolated private app ports");
    assert.equal(url.origin, "https://api.render.com");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "error");
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
    if (path.startsWith("/postgres/") || path.endsWith("/outbound-ips") || path === "/environments/evm-production") {
      const call = { method, path, query: url.searchParams, body };
      network.calls.push(call);
      const intercepted = await network.before?.(call);
      if (intercepted) return intercepted;
      if (path === "/environments/evm-production")
        return Response.json({ id: "evm-production", projectId: network.projectId });
      if (path.endsWith("/outbound-ips")) return Response.json({ ips: network.ips, type: "shared" });
      if (method === "PATCH")
        network.database.ipAllowList = (body as { ipAllowList: typeof network.database.ipAllowList }).ipAllowList;
      return Response.json(network.database);
    }
    const gatewayResponse = gateway.intercept(method, `${path}${url.search}`, body);
    if (gatewayResponse) return gatewayResponse;
    const call = { method, path, query: url.searchParams, body };
    calls.push(call);
    const intercepted = await opts.intercept?.(call);
    if (intercepted) return intercepted;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/services" && method === "GET") return json(service ? [{ service, cursor: "end" }] : []);
    if (path === "/services" && method === "POST") {
      service = newService();
      const created = body as { name: string; environmentId: string; envVars: Array<{ key: string; value: string }> };
      service.name = created.name;
      service.environmentId = created.environmentId;
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
  const provider = (extra: Partial<RenderDeployProviderOptions> = {}) => {
    const result = createRenderDeployProvider({
      apiKey: TOKEN,
      workspaceId: WORKSPACE,
      projectId: "prj-qm",
      postgresId: "dpg-qm-a",
      baseImage: IMAGE,
      store,
      gatewayStore,
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
      ...result,
      apply: async (...args: Parameters<typeof result.apply>) => {
        await ready;
        return result.apply(...args);
      },
      destroy: async (...args: Parameters<typeof result.destroy>) => {
        await ready;
        return result.destroy(...args);
      },
      resolveEndpoint: async (...args: Parameters<NonNullable<typeof result.resolveEndpoint>>) => {
        await ready;
        return result.resolveEndpoint!(...args);
      },
      logs: async (...args: Parameters<NonNullable<typeof result.logs>>) => {
        await ready;
        return result.logs!(...args);
      },
      transferOwnership: async (...args: Parameters<NonNullable<typeof result.transferOwnership>>) => {
        await ready;
        return result.transferOwnership!(...args);
      },
    };
  };
  return {
    provider,
    calls,
    prepared,
    revoked,
    artifact,
    store,
    gateway,
    gatewayStore,
    network,
    appService: () => service!,
    ready,
    endpoint: () => {
      const gatewayService = [...gateway.services.values()][0]!;
      const config = JSON.parse(gateway.configs.get(gatewayService.id)!);
      const control = config.apps.http.servers.gateway.routes.find((route: { match?: Array<{ path?: string[] }> }) =>
        route.match?.[0]?.path?.includes("/__qm_gateway_config"),
      );
      const token = renderGatewayAppToken((Object.values(control.match[0].vars)[0] as string[])[0]!, ID);
      return {
        host: new URL(gatewayService.serviceDetails.url).hostname,
        port: 443,
        tls: true,
        proxyHeaders: { connection: "close", [RENDER_GATEWAY_AUTH_HEADER]: token, [RENDER_GATEWAY_APP_HEADER]: ID },
      };
    },
    releaseQueued: () => {
      queuedListReads = 0;
    },
  };
}

test("Render publish creates a private image service and waits for its deploy", async () => {
  const fake = fakeRender();
  const endpoint = await fake.provider().apply(deployment, version);
  assert.deepEqual(endpoint, fake.endpoint());
  assert.equal(fake.prepared[0]![1], version);
  assert.equal(fake.provider().profile.dataDir, undefined);
  const created = fake.calls.find((call) => call.method === "POST" && call.path === "/services")!;
  assert.deepEqual(created.body, {
    type: "private_service",
    environmentId: "env-gw-1",
    name: `qm-app-${ID}`,
    ownerId: WORKSPACE,
    autoDeploy: "no",
    image: { ownerId: WORKSPACE, imagePath: IMAGE },
    envVars: [
      { key: "APP_SECRET", value: "app-only-secret" },
      { key: "PORT", value: "8080" },
      { key: "QM_DEPLOYMENT_ID", value: ID },
    ],
    secretFiles: [{ name: "qm-render-artifact.json", content: JSON.stringify(fake.artifact) }],
    serviceDetails: {
      runtime: "image",
      plan: "0.5c-512mb",
      region: "oregon",
      numInstances: 1,
      maxShutdownDelaySeconds: 300,
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

test("Render publish builds the app runner from Git with its app artifact", async () => {
  const fake = fakeRender({ environmentId: "env-gw-1" });
  await fake.provider({ baseImage: undefined, source: SOURCE, environmentId: "env-gw-1" }).apply(deployment, version);
  const created = fake.calls.find((call) => call.method === "POST" && call.path === "/services")!;
  assert.deepEqual(created.body, {
    type: "private_service",
    name: `qm-app-${ID}`,
    ownerId: WORKSPACE,
    environmentId: "env-gw-1",
    autoDeploy: "no",
    ...SOURCE,
    rootDir: "",
    envVars: [
      { key: "APP_SECRET", value: "app-only-secret" },
      { key: "PORT", value: "8080" },
      { key: "QM_DEPLOYMENT_ID", value: ID },
    ],
    secretFiles: [{ name: "qm-render-artifact.json", content: JSON.stringify(fake.artifact) }],
    serviceDetails: {
      runtime: "docker",
      envSpecificDetails: { dockerContext: ".", dockerfilePath: "deploy/render-runner/Dockerfile", dockerCommand: "" },
      plan: "0.5c-512mb",
      region: "oregon",
      numInstances: 1,
      maxShutdownDelaySeconds: 300,
    },
  });
  assert.equal((await fake.store.get(ID))?.status, "live");
  assert.equal((await fake.store.get(ID))?.serviceId, SERVICE);
});

test("Render switches an image service to a Git runner without replacing the service", async () => {
  const fake = fakeRender({ existing: true });
  await fake.provider({ baseImage: undefined, source: SOURCE }).apply(deployment, { ...version, version: 2 });
  assert.deepEqual(fake.calls.find((call) => call.method === "PATCH")?.body, {
    autoDeploy: "no",
    ...SOURCE,
    rootDir: "",
    serviceDetails: {
      runtime: "docker",
      envSpecificDetails: { dockerContext: ".", dockerfilePath: "deploy/render-runner/Dockerfile", dockerCommand: "" },
      maxShutdownDelaySeconds: 300,
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
    serviceDetails: { runtime: "image", maxShutdownDelaySeconds: 300 },
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
    assert.deepEqual(await provider.apply(deployment, { ...version, version: 2 }), fake.endpoint());
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
  assert.deepEqual(endpoint, fake.endpoint());
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
  assert.deepEqual(endpoint, fake.endpoint());
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
  assert.deepEqual(await provider.resolveEndpoint!(running, version), fake.endpoint());
  const restarted = fake.provider({ deployTimeoutMs: 5 });
  await assert.rejects(restarted.apply(running, { ...version, version: 2 }), /still pending/);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
  assert.equal(fake.prepared.length, 1);
  fake.releaseQueued();
  assert.deepEqual(await restarted.apply(running, version), fake.endpoint());
  assert.equal(await restarted.resolveEndpoint!(running, version), null);
  assert.deepEqual(await restarted.resolveEndpoint!({ ...running, appliedVersion: 1 }, version), fake.endpoint());
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
    assert.deepEqual(await restarted.resolveEndpoint!(running, version), fake.endpoint());
    status = "live";
    assert.deepEqual(await restarted.apply(running, version), fake.endpoint());
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
    ownerScopeId: deployment.ownerScopeId,
    environmentId: "env-gw-1",
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
    ownerScopeId: deployment.ownerScopeId,
    environmentId: "env-gw-1",
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
    ownerScopeId: deployment.ownerScopeId,
    environmentId: "env-gw-1",
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
    ownerScopeId: deployment.ownerScopeId,
    environmentId: "env-gw-1",
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
    ownerScopeId: deployment.ownerScopeId,
    environmentId: "env-gw-1",
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
  assert.deepEqual(await provider.resolveEndpoint!(deployment, version), fake.endpoint());
  assert.deepEqual(fake.revoked, []);
});

test("Render retains a new service when polling cannot recover before the deadline", async () => {
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
  assert.deepEqual(await provider.resolveEndpoint!(deployment, version), fake.endpoint());
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
  for (const endpoint of endpoints) assert.deepEqual(endpoint, fake.endpoint());
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
    Array.from({ length: 3 }, () => `render-deploy-owner:${deployment.ownerScopeId}`),
  );
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
});

test("Render waits for the app port even when the platform reports a live deploy", async () => {
  const fake = fakeRender({ appReachable: false });
  await assert.rejects(fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version), /HTTP on port 8080/);
  assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
});

test("Render restores the same service and scopes apps to the configured environment", async () => {
  const fake = fakeRender({ environmentId: "env-gw-1" });
  const provider = fake.provider({ environmentId: "env-gw-1" });
  await provider.apply(deployment, version);
  const created = fake.calls.find((call) => call.method === "POST" && call.path === "/services")!.body as {
    environmentId: string;
    serviceDetails: { disk?: unknown };
  };
  assert.equal(created.environmentId, "env-gw-1");
  assert.equal(created.serviceDetails.disk, undefined);
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

test("Render refuses an app with an attached disk or another environment", async () => {
  const attached = fakeRender({ existing: true, attachedDisk: true });
  await assert.rejects(attached.provider().apply(deployment, version), /without a persistent disk/);
  const moved = fakeRender({ existing: true, environmentId: "evm-other" });
  await assert.rejects(
    moved.provider({ environmentId: "env-gw-1" }).apply(deployment, version),
    /expected private app service/,
  );
  assert.equal(attached.prepared.length + moved.prepared.length, 0);
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
    fake.network.ips = ["203.0.113.2"];
    const store = createDeployStore({ git: { repoRoot: join(dir, "git") } });
    const lock = createPostgresAdvisoryLock(pg);
    const service = createDeployService({
      deployStore: store,
      provider: fake.provider({ advisoryLock: lock }),
      advisoryLock: lock,
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
    const previousEndpoint = (await store.get(d.id))!.endpoint!;
    const nextOwner = scopeId("personal", "U2");
    await service.transferDeploymentOwner(d.id, nextOwner, {
      callerId: "U1",
      actingScopeId: scopeId("personal", "U1"),
    });
    const reached = await service.reachDeployment(d.id, "U2");
    assert.equal(reached.status, "ok");
    if (reached.status !== "ok") throw new Error("The new owner cannot reach the transferred app");
    assert.notEqual(reached.endpoint.host, previousEndpoint.host);
    assert.equal((await store.get(d.id))!.ownerScopeId, nextOwner);
    assert.equal((await store.get(d.id))!.status, "running");
    assert.equal((await pg.sessionPool()).options.max, 1);
    assert.equal(fake.network.calls.filter((call) => call.method === "PATCH").length, 1);
    assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
  },
);

test("Render archive clears a rejected create without changing it into an uncertain operation", async () => {
  const fake = fakeRender();
  await fake.store.put(ID, {
    deploymentId: ID,
    ownerScopeId: deployment.ownerScopeId,
    environmentId: "env-gw-1",
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

for (const status of [200, 302, 401, 403, 404, 500, 502, 503]) {
  test(`Render checks the app response before it confirms a deploy: HTTP ${status}`, async () => {
    const fake = fakeRender({ appStatus: status });
    const applied = fake.provider({ deployTimeoutMs: 5 }).apply(deployment, version);
    if (status < 500) {
      assert.deepEqual(await applied, fake.endpoint());
      assert.equal((await fake.store.get(ID))?.liveVersion, 1);
    } else {
      await assert.rejects(applied, /HTTP on port 8080/);
      assert.equal((await fake.store.get(ID))?.liveVersion, undefined);
    }
  });
}

for (const status of ["live", "update_failed"]) {
  test(`Render keeps app requests available while an update becomes ${status}`, { timeout: 5_000 }, async (t) => {
    const polling = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response | undefined>();
    const fake = fakeRender({
      existing: true,
      deployStatus: "update_in_progress",
      async intercept(call) {
        if (call.path.endsWith("/deploys/dep-next")) {
          polling.resolve();
          return release.promise;
        }
        return undefined;
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "render-deploy-availability-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const deployments = createMemoryMap<Deployment>();
    await fake.ready;
    const endpoint = fake.endpoint();
    await deployments.put(ID, {
      ...deployment,
      status: "running",
      appliedVersion: 1,
      endpoint,
      versions: [version],
    });
    await fake.store.put(ID, {
      deploymentId: ID,
      ownerScopeId: deployment.ownerScopeId,
      environmentId: "env-gw-1",
      version: 1,
      status: "live",
      createdService: false,
      previousDeployIds: [],
      serviceId: SERVICE,
      deployId: "dep-old",
      liveVersion: 1,
    });
    const store = createDeployStore({ deployments, git: { repoRoot: join(dir, "git") } });
    const service = createDeployService({
      deployStore: store,
      provider: fake.provider({ deployTimeoutMs: 3_000 }),
      acl: createAclStore(),
      deployDir: join(dir, "apps"),
      auditLog: { record() {}, events: async () => [], tail: async () => [] },
    });
    const update = service.redeploy(ID, { entrypoint: "node updated.js", files: [] });
    const result = update.then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    await Promise.race([
      polling.promise,
      result.then(({ error }) => {
        throw error ?? new Error("Update completed before its deploy was observed");
      }),
    ]);
    assert.equal((await fake.store.get(ID))?.status, "pending");
    assert.equal((await store.get(ID))?.appliedVersion, 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reached = await Promise.race([
        Promise.all(Array.from({ length: 20 }, () => service.reachDeployment(ID, "U1"))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("App requests waited for the pending update")), 500);
        }),
      ]);
      for (const reach of reached) assert.deepEqual(reach, { status: "ok", id: ID, endpoint });
      assert.equal((await fake.store.get(ID))?.status, "pending");
      assert.equal(fake.prepared.length, 1);
    } finally {
      clearTimeout(timer);
      release.resolve(new Response(JSON.stringify({ id: "dep-next", status })));
    }
    const completed = await result;
    if (status === "live") {
      assert.equal(completed.error, null);
      assert.equal(completed.value?.appliedVersion, 2);
    } else {
      assert.match(String(completed.error), /update_failed/);
      assert.equal((await store.get(ID))?.appliedVersion, 1);
    }
    assert.deepEqual(await service.reachDeployment(ID, "U1"), { status: "ok", id: ID, endpoint });
    assert.equal((await fake.store.get(ID))?.liveVersion, status === "live" ? 2 : 1);
    assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
    assert.ok(fake.calls.every((call) => call.method !== "DELETE" && !call.path.endsWith("/suspend")));
  });
}

for (const state of [
  "first",
  "stale",
  "suspending",
  "suspended",
  "archived",
  "missing",
  "remote-suspended",
  "unowned",
] as const) {
  test(`Render preserves the endpoint guard during a pending update: ${state}`, async () => {
    const fake = fakeRender({
      existing: state !== "missing",
      suspended: state === "remote-suspended",
      marker: state === "unowned" ? "another-deployment" : ID,
    });
    await fake.store.put(ID, {
      deploymentId: ID,
      ownerScopeId: deployment.ownerScopeId,
      environmentId: "env-gw-1",
      version: 2,
      status: state === "suspending" || state === "suspended" ? state : "pending",
      createdService: state === "first",
      previousDeployIds: ["dep-old"],
      serviceId: SERVICE,
      ...(state === "first" ? {} : { liveVersion: state === "stale" ? 0 : 1 }),
    });
    const running = {
      ...deployment,
      status: state === "archived" ? ("archived" as const) : ("running" as const),
      appliedVersion: 1,
    };
    const resolved = fake.provider().resolveEndpoint!(running, version);
    if (state === "unowned") await assert.rejects(resolved, /another deployment/);
    else assert.equal(await resolved, null);
    assert.ok(fake.calls.every((call) => call.method === "GET"));
  });
}

test("Render discards a stale endpoint refresh when an update confirms another version", async () => {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response | undefined>();
  let held = false;
  const fake = fakeRender({
    existing: true,
    async intercept(call) {
      if (call.query.get("status") === "live" && !held) {
        held = true;
        reading.resolve();
        return release.promise;
      }
      return undefined;
    },
  });
  const running = { ...deployment, status: "running" as const, appliedVersion: 1 };
  const provider = fake.provider();
  const stale = provider.resolveEndpoint!(running, version);
  await reading.promise;
  await provider.apply(running, { ...version, version: 2 });
  release.resolve(new Response(JSON.stringify([{ deploy: { id: "dep-old", status: "live" } }])));
  assert.equal(await stale, null);
  assert.deepEqual(await provider.resolveEndpoint!({ ...running, appliedVersion: 2 }, version), fake.endpoint());
});

test("Render runtime storage credentials replace user values before service creation", async () => {
  const fake = fakeRender();
  const runtimeEnv = { QM_APP_STORAGE_URL: "https://core.example/storage", QM_APP_STORAGE_TOKEN: "scoped-token" };
  const provider = fake.provider({
    artifacts: {
      async prepare() {
        return { ...fake.artifact, runtimeEnv };
      },
      async revoke() {},
    },
  });
  await provider.apply(deployment, {
    ...version,
    env: { QM_APP_STORAGE_URL: "https://untrusted.example", QM_APP_STORAGE_TOKEN: "untrusted-token" },
  });
  const created = fake.calls.find((call) => call.method === "POST" && call.path === "/services")!.body as {
    envVars: Array<{ key: string; value: string }>;
  };
  const env = Object.fromEntries(created.envVars.map(({ key, value }) => [key, value]));
  assert.equal(env.QM_APP_STORAGE_URL, runtimeEnv.QM_APP_STORAGE_URL);
  assert.equal(env.QM_APP_STORAGE_TOKEN, runtimeEnv.QM_APP_STORAGE_TOKEN);
  assert.equal(JSON.stringify(await fake.store.get(ID)).includes(runtimeEnv.QM_APP_STORAGE_TOKEN), false);
  assert.deepEqual(provider.profile.storage, { database: "postgres", files: "signed-urls" });
});

test("Render readiness probes use a new connection after each deploy", async () => {
  const sockets = new Set<number>();
  const upstream = createServer((req, res) => {
    sockets.add(req.socket.remotePort!);
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as AddressInfo).port;
  const fake = fakeRender({
    appFetch: ((_input, init) =>
      undiciFetch(`http://127.0.0.1:${port}/`, init as Parameters<typeof undiciFetch>[1])) as typeof fetch,
  });
  const provider = fake.provider();
  try {
    for (const number of [1, 2, 3]) {
      await provider.apply(deployment, { ...version, version: number });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(sockets.size, 3);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("Render default HTTP client uses the installed Undici dispatcher", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("The native fetch must not run");
  });
  const previous = getGlobalDispatcher();
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  dispatcher
    .get("https://api.render.com")
    .intercept({
      method: "GET",
      path: `/v1/services?name=qm-app-${ID}&ownerId=${WORKSPACE}&limit=100`,
    })
    .reply(200, []);
  setGlobalDispatcher(dispatcher);
  try {
    const fake = fakeRender();
    assert.equal(await fake.provider({ fetchImpl: undefined }).resolveEndpoint!(deployment, version), null);
    dispatcher.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previous);
    await dispatcher.close();
  }
});
test("Render transfers an app while suspended and resumes it behind its new owner's gateway", async () => {
  const fake = fakeRender();
  const provider = fake.provider();
  const before = await provider.apply(deployment, version);
  const original = await fake.gatewayStore.get(deployment.ownerScopeId);
  const nextOwner = scopeId("personal", "U2");
  await provider.transferOwnership(deployment, nextOwner);
  const record = (await fake.store.get(ID))!;
  assert.equal(record.ownerScopeId, nextOwner);
  assert.equal(record.status, "suspended");
  assert.equal(fake.appService().suspended, "suspended");
  assert.equal(fake.appService().environmentId, record.environmentId);
  assert.notEqual(record.environmentId, original!.environmentId);
  assert.deepEqual((await fake.gatewayStore.get(deployment.ownerScopeId))!.routes, {});
  assert.equal(fake.gateway.services.get(original!.gatewayServiceId!)!.suspended, "suspended");
  assert.deepEqual(fake.revoked, [ID]);
  await assert.rejects(provider.resolveEndpoint(deployment, version), /ownership transfer/);
  const moved = { ...deployment, ownerScopeId: nextOwner };
  const after = await provider.apply(moved, version);
  assert.notEqual(after.host, before.host);
  assert.notEqual(after.proxyHeaders![RENDER_GATEWAY_AUTH_HEADER], before.proxyHeaders![RENDER_GATEWAY_AUTH_HEADER]);
  assert.equal(after.proxyHeaders![RENDER_GATEWAY_APP_HEADER], ID);
  assert.equal(fake.appService().id, SERVICE);
  assert.equal(fake.appService().serviceDetails.disk, undefined);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
});

for (const lostResponse of [false, true]) {
  test(`Render recovers an ownership move with ${lostResponse ? "a lost response" : "a failed request"}`, async () => {
    const fake = fakeRender();
    const provider = fake.provider();
    await provider.apply(deployment, version);
    const target = scopeId("personal", "U2");
    const moving = (call: { method: string; path: string }) =>
      call.method === "POST" && call.path.endsWith("/resources");
    if (lostResponse)
      fake.gateway.controls.after = (call, response) => {
        if (moving(call)) throw new TypeError("move response was lost");
        return response;
      };
    else fake.gateway.controls.before = (call) => (moving(call) ? new Response(null, { status: 503 }) : undefined);
    if (lostResponse) await provider.transferOwnership(deployment, target);
    else {
      await assert.rejects(provider.transferOwnership(deployment, target), /HTTP 503/);
      const pending = (await fake.store.get(ID))!;
      assert.equal(pending.transfer!.ownerScopeId, target);
      assert.equal(fake.appService().suspended, "suspended");
      assert.deepEqual((await fake.gatewayStore.get(deployment.ownerScopeId))!.routes, {});
      await assert.rejects(provider.resolveEndpoint(deployment, version), /ownership transfer/);
      fake.gateway.controls.before = undefined;
      await fake.provider().transferOwnership(deployment, target);
    }
    const finished = (await fake.store.get(ID))!;
    assert.equal(finished.ownerScopeId, target);
    assert.equal(finished.transfer, undefined);
    assert.equal(fake.appService().environmentId, finished.environmentId);
    assert.equal(fake.appService().suspended, "suspended");
    assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/suspend")).length, 1);
  });
}

test("Render permits only reported app egress ranges and preserves existing database rules", async () => {
  const fake = fakeRender();
  fake.network.ips = ["74.220.48.0/24", "74.220.56.0/24", "203.0.113.9", "2001:db8::1", "2001:0db8:0:0::1"];
  const existing = structuredClone(fake.network.database.ipAllowList);
  fake.network.before = async (call) => {
    if (call.method === "PATCH") {
      assert.equal((await fake.store.get(ID))?.serviceId, SERVICE);
      assert.equal((await fake.store.get(ID))?.status, "pending");
      assert.equal(fake.gateway.services.size, 0);
    }
    return undefined;
  };
  await fake.provider().apply(deployment, version);
  assert.deepEqual(fake.network.database.ipAllowList, [
    ...existing,
    ...["74.220.48.0/24", "74.220.56.0/24", "203.0.113.9/32", "2001:db8::1/128"].map((cidrBlock) => ({
      cidrBlock,
      description: "QM Render app outbound IP range",
    })),
  ]);
  await fake.provider().apply(deployment, { ...version, version: 2 });
  assert.equal(fake.network.calls.filter((call) => call.method === "PATCH").length, 1);
});

test("Render recognizes database rules after the API normalizes their network addresses", async () => {
  const fake = fakeRender();
  fake.network.ips = ["74.220.48.12/24", "2001:0db8:0:0::1/64"];
  fake.network.database.ipAllowList = [
    { cidrBlock: "74.220.48.0/24", description: "Shared egress" },
    { cidrBlock: "2001:db8::/64", description: "IPv6 egress" },
  ];
  await fake.provider().apply(deployment, version);
  assert.ok(fake.network.calls.every((call) => call.method === "GET"));
});

for (const ips of [
  [],
  ["0.0.0.0/0"],
  ["::/0"],
  ["1.2.3.4/33"],
  ["2001:db8::1/129"],
  ["1.2.3.4/24/32"],
  ["bad"],
  ["fe80::1%eth0"],
]) {
  test(`Render rejects invalid or unrestricted database egress: ${JSON.stringify(ips)}`, async () => {
    const fake = fakeRender();
    fake.network.ips = ips;
    await assert.rejects(fake.provider().apply(deployment, version), /outbound IP/);
    assert.ok(fake.network.calls.every((call) => call.method === "GET"));
    assert.equal((await fake.store.get(ID))?.serviceId, SERVICE);
  });
}

for (const mismatch of ["id", "owner", "region", "environment", "project"] as const) {
  test(`Render refuses database network changes for an unexpected ${mismatch}`, async () => {
    const fake = fakeRender();
    fake.network.ips = ["203.0.113.2"];
    if (mismatch === "id") fake.network.database.id = "dpg-other-a";
    if (mismatch === "owner") fake.network.database.owner.id = "tea-other";
    if (mismatch === "region") fake.network.database.region = "frankfurt";
    if (mismatch === "environment") fake.network.database.environmentId = "";
    if (mismatch === "project") fake.network.projectId = "prj-other";
    await assert.rejects(fake.provider().apply(deployment, version), /database (does not match|belongs to another)/);
    assert.ok(fake.network.calls.every((call) => call.method === "GET"));
  });
}

for (const failure of ["rejected", "lost response", "not applied"] as const) {
  test(`Render retains a created app after its database rule update is ${failure}`, async () => {
    const fake = fakeRender();
    fake.network.ips = ["203.0.113.2"];
    fake.network.before = async (call) => {
      if (call.method !== "PATCH") return undefined;
      if (failure === "rejected") return Response.json({}, { status: 403 });
      if (failure === "not applied") return Response.json(fake.network.database);
      fake.network.database.ipAllowList = (
        call.body as { ipAllowList: typeof fake.network.database.ipAllowList }
      ).ipAllowList;
      throw new TypeError("Database update response was lost");
    };
    await assert.rejects(fake.provider().apply(deployment, version), /still pending/);
    assert.equal((await fake.store.get(ID))?.serviceId, SERVICE);
    assert.equal((await fake.store.get(ID))?.status, "pending");
    assert.deepEqual(fake.revoked, []);
    assert.ok(fake.calls.every((call) => !/\/(cancel|suspend)$/.test(call.path) && call.method !== "DELETE"));
    fake.network.before = undefined;
    await fake.provider().apply(deployment, version);
    assert.equal((await fake.store.get(ID))?.status, "live");
    assert.equal(fake.calls.filter((call) => call.path === "/services" && call.method === "POST").length, 1);
    assert.equal(
      fake.network.calls.filter((call) => call.method === "PATCH").length,
      failure === "lost response" ? 1 : 2,
    );
  });
}

test("Render authorizes changed outbound ranges before resuming a transferred app", async () => {
  const fake = fakeRender();
  const provider = fake.provider();
  await provider.apply(deployment, version);
  const nextOwner = scopeId("personal", "U2");
  await provider.transferOwnership(deployment, nextOwner);
  fake.network.ips = ["203.0.113.2"];
  fake.network.before = async (call) => {
    if (call.method === "PATCH") {
      assert.equal(fake.appService().suspended, "suspended");
      assert.equal((await fake.store.get(ID))?.ownerScopeId, nextOwner);
      assert.ok(fake.calls.every((call) => !call.path.endsWith("/resume")));
    }
    return undefined;
  };
  await provider.apply({ ...deployment, ownerScopeId: nextOwner }, version);
  assert.equal(fake.network.database.ipAllowList.at(-1)?.cidrBlock, "203.0.113.2/32");
});

test("Render serializes database rule updates for different app owners", async () => {
  const first = fakeRender();
  const second = fakeRender();
  second.network.database = first.network.database;
  first.network.ips = ["203.0.113.2"];
  second.network.ips = ["203.0.113.3"];
  const ready = Promise.withResolvers<void>();
  let reading = 0;
  for (const fake of [first, second]) {
    let held = false;
    fake.network.before = async (call) => {
      if (call.method === "GET" && call.path.startsWith("/postgres/") && !held) {
        held = true;
        if (++reading === 2) ready.resolve();
        await ready.promise;
      }
      return undefined;
    };
  }
  const advisoryLock = createMemoryAdvisoryLock();
  await Promise.all([
    first.provider({ advisoryLock }).apply(deployment, version),
    second.provider({ advisoryLock }).apply({ ...deployment, ownerScopeId: scopeId("personal", "U2") }, version),
  ]);
  assert.deepEqual(
    new Set(first.network.database.ipAllowList.map((rule) => rule.cidrBlock)),
    new Set(["203.0.113.1/32", "203.0.113.2/32", "203.0.113.3/32"]),
  );
});

test("Render does not discard database rules when the allowlist is full", async () => {
  const fake = fakeRender();
  fake.network.database.ipAllowList = Array.from({ length: 600 }, (_, i) => ({
    cidrBlock: `10.0.${Math.floor(i / 256)}.${i % 256}/32`,
    description: `Retained rule ${i}`,
  }));
  await assert.rejects(fake.provider().apply(deployment, version), /allowlist is full/);
  assert.ok(fake.network.calls.every((call) => call.method === "GET"));
  assert.equal(fake.network.database.ipAllowList.length, 600);
});
