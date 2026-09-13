import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderDeployGateways, type StoredRenderGateway } from "../src/deploy/render-deploy-gateways.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  RENDER_GATEWAY_IMAGE,
  RENDER_GATEWAY_COMMAND,
  RENDER_GATEWAY_AUTH_HEADER,
  RENDER_GATEWAY_APP_HEADER,
  renderGatewayConfigHash,
  renderGatewayAppToken,
} from "../src/deploy/render-caddy.ts";
import { createFakeRenderGateways } from "./support/fake-render-gateways.ts";

const OWNER = "personal:U1";
const OTHER = "personal:U2";
const APP = "550e8400-e29b-41d4-a716-446655440000";
const APP2 = "550e8400-e29b-41d4-a716-446655440001";
const UPSTREAM = { host: "app-one", port: 8080 };
const UPSTREAM2 = { host: "app-two", port: 8080 };

function fixture() {
  const fake = createFakeRenderGateways();
  const store = createMemoryMap<StoredRenderGateway>();
  const create = () =>
    createRenderDeployGateways({
      request: fake.request,
      workspaceId: fake.workspaceId,
      projectId: fake.projectId,
      region: "oregon",
      prefix: "qm-app",
      store,
      timeoutMs: 40,
      pollMs: 1,
      fetchImpl: fake.fetchImpl,
    });
  return { ...fake, store, create, gateway: create() };
}

test("gateway creates one isolated protected environment before it creates a service", async () => {
  const f = fixture();
  const first = await f.gateway.ensure(OWNER);
  assert.deepEqual(await f.gateway.ensure(OWNER), first);
  assert.equal(f.environments.size, 1);
  assert.equal(f.services.size, 0);
  const environment = [...f.environments.values()][0]!;
  assert.equal(environment.networkIsolationEnabled, true);
  assert.equal(environment.protectedStatus, "protected");
  assert.equal(environment.projectId, f.projectId);
  assert.ok(!environment.name.includes(OWNER));
  assert.ok(!environment.name.includes("U1"));
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});

test("gateway shares its service across the owner's apps and separates other owners", async () => {
  const f = fixture();
  const first = await f.gateway.upsert(OWNER, APP, UPSTREAM);
  const second = await f.gateway.upsert(OWNER, APP2, UPSTREAM2);
  const other = await f.gateway.upsert(OTHER, APP, UPSTREAM);
  assert.equal(first.host, second.host);
  assert.notEqual(first.host, other.host);
  assert.notEqual(first.proxyHeaders![RENDER_GATEWAY_AUTH_HEADER], second.proxyHeaders![RENDER_GATEWAY_AUTH_HEADER]);
  assert.notEqual(first.proxyHeaders![RENDER_GATEWAY_AUTH_HEADER], other.proxyHeaders![RENDER_GATEWAY_AUTH_HEADER]);
  assert.equal(f.services.size, 2);
  assert.equal(f.environments.size, 2);
  const one = (await f.store.get(OWNER))!;
  const two = (await f.store.get(OTHER))!;
  assert.notEqual(one.environmentId, two.environmentId);
  assert.notEqual(one.token, two.token);
  assert.equal(Buffer.from(one.token, "base64url").length, 32);
  assert.deepEqual(one.routes, { [APP]: UPSTREAM, [APP2]: UPSTREAM2 });
  assert.deepEqual(first, {
    host: first.host,
    port: 443,
    tls: true,
    proxyHeaders: {
      connection: "close",
      [RENDER_GATEWAY_AUTH_HEADER]: renderGatewayAppToken(one.token, APP),
      [RENDER_GATEWAY_APP_HEADER]: APP,
    },
  });
  assert.notEqual(first.proxyHeaders![RENDER_GATEWAY_AUTH_HEADER], one.token);
});

test("gateway service uses only the stock image, owner marker, port, and its config secret", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  const created = f.calls.find((call) => call.path === "/services" && call.method === "POST")!;
  const body = created.body as {
    image: unknown;
    serviceDetails: Record<string, unknown>;
    envVars: Array<{ key: string; value: string }>;
    secretFiles: Array<{ name: string; content: string }>;
  };
  assert.deepEqual(body.image, { ownerId: f.workspaceId, imagePath: RENDER_GATEWAY_IMAGE });
  assert.match(RENDER_GATEWAY_IMAGE, /^docker\.io\/library\/caddy@sha256:[0-9a-f]{64}$/);
  assert.equal(body.serviceDetails.plan, "0.5c-512mb");
  assert.equal(body.serviceDetails.numInstances, 1);
  assert.equal(body.serviceDetails.disk, undefined);
  assert.deepEqual(body.serviceDetails.envSpecificDetails, { dockerCommand: RENDER_GATEWAY_COMMAND });
  assert.deepEqual(body.envVars.map(({ key }) => key).sort(), ["PORT", "QM_GATEWAY_OWNER"]);
  assert.equal(body.secretFiles.length, 1);
  assert.equal(body.secretFiles[0]!.name, "qm-render-gateway.json");
  const record = (await f.store.get(OWNER))!;
  assert.ok(body.secretFiles[0]!.content.includes(record.token));
  assert.ok(!JSON.stringify(body.envVars).includes(record.token));
  assert.ok(!JSON.stringify(body).includes(OWNER));
});

test("gateway repeat upsert preserves its token and does not deploy", async () => {
  const f = fixture();
  const first = await f.gateway.upsert(OWNER, APP, UPSTREAM);
  const writes = () => f.calls.filter(({ method }) => method !== "GET").length;
  const count = writes();
  assert.deepEqual(await f.create().upsert(OWNER, APP, UPSTREAM), first);
  assert.equal(writes(), count);
  assert.deepEqual(await f.gateway.endpoint(OWNER, APP), first);
});

test("gateway repeated publish waits for health without a new deploy", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  const writes = f.calls.filter(({ method }) => method !== "GET").length;
  f.controls.healthy = false;
  await assert.rejects(f.gateway.upsert(OWNER, APP, UPSTREAM), /not live/);
  assert.equal(f.calls.filter(({ method }) => method !== "GET").length, writes);
  assert.equal(await f.gateway.endpoint(OWNER, APP), null);
});

test("gateway rejects a saved configuration hash that does not cover its current routes", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  const record = (await f.store.get(OWNER))!;
  await f.store.put(OWNER, { ...record, routes: { [APP]: UPSTREAM2 } });
  assert.equal(await f.gateway.endpoint(OWNER, APP), null);
});

test("gateway removal deploys a config that retains the owner's other apps", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  const second = await f.gateway.upsert(OWNER, APP2, UPSTREAM2);
  await f.gateway.remove(OWNER, APP);
  const record = (await f.store.get(OWNER))!;
  assert.deepEqual(record.routes, { [APP2]: UPSTREAM2 });
  assert.equal(record.appliedConfigHash, renderGatewayConfigHash(record.token, record.routes));
  assert.equal(await f.gateway.endpoint(OWNER, APP), null);
  assert.deepEqual(await f.gateway.endpoint(OWNER, APP2), second);
  assert.equal(f.calls.filter(({ path, method }) => path.endsWith("/suspend") && method === "POST").length, 0);
});

test("gateway removal suspends the last app and restores the same service and token", async () => {
  const f = fixture();
  const first = await f.gateway.upsert(OWNER, APP, UPSTREAM);
  const original = (await f.store.get(OWNER))!;
  await f.gateway.remove(OWNER, APP);
  assert.equal(f.services.get(original.gatewayServiceId!)!.suspended, "suspended");
  assert.equal(await f.gateway.endpoint(OWNER, APP), null);
  assert.equal(f.environments.size, 1);
  assert.equal(f.services.size, 1);
  assert.ok(f.calls.every(({ method }) => method !== "DELETE"));
  assert.deepEqual(await f.create().upsert(OWNER, APP, UPSTREAM), first);
  assert.equal(f.services.get(original.gatewayServiceId!)!.suspended, "not_suspended");
  assert.equal((await f.store.get(OWNER))!.token, original.token);
  assert.equal(f.calls.filter(({ path }) => path.endsWith("/resume")).length, 1);
});

test("gateway endpoint and removal do not provision an unknown owner", async () => {
  const f = fixture();
  assert.equal(await f.gateway.endpoint(OWNER, APP), null);
  await f.gateway.remove(OWNER, APP);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.all()).length, 0);
});

test("gateway rejects project ownership changes before resource creation", async () => {
  const f = fixture();
  f.project.owner.id = "tea-other";
  await assert.rejects(f.gateway.ensure(OWNER), /another workspace/);
  assert.equal(f.environments.size, 0);
});

for (const field of ["networkIsolationEnabled", "protectedStatus", "projectId", "name"] as const) {
  test(`gateway endpoint rejects a changed environment ${field}`, async () => {
    const f = fixture();
    await f.gateway.upsert(OWNER, APP, UPSTREAM);
    const environment = [...f.environments.values()][0]!;
    Object.assign(environment, { [field]: field === "networkIsolationEnabled" ? false : "changed" });
    await assert.rejects(f.gateway.endpoint(OWNER, APP), /identity or network isolation/);
  });
}

for (const field of ["ownerId", "environmentId", "imagePath", "type", "name"] as const) {
  test(`gateway endpoint rejects a changed service ${field}`, async () => {
    const f = fixture();
    await f.gateway.upsert(OWNER, APP, UPSTREAM);
    const service = [...f.services.values()][0]!;
    service[field] = "changed";
    await assert.rejects(f.gateway.endpoint(OWNER, APP), /identity or configuration/);
  });
}

test("gateway endpoint rejects another owner's marker and a missing retained service", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  const record = (await f.store.get(OWNER))!;
  f.markers.set(record.gatewayServiceId!, "different");
  await assert.rejects(f.gateway.endpoint(OWNER, APP), /another owner/);
  f.services.delete(record.gatewayServiceId!);
  await assert.rejects(f.gateway.upsert(OWNER, APP, UPSTREAM), /retained Render gateway service is missing/);
  assert.equal(f.calls.filter(({ method, path }) => method === "POST" && path === "/services").length, 1);
});

test("gateway persists environment intent before a create and recovers a lost response", async () => {
  const f = fixture();
  f.controls.after = (call, response) => {
    if (call.method === "POST" && call.path === "/environments") throw new TypeError("connection lost");
    return response;
  };
  await assert.rejects(f.gateway.ensure(OWNER), /connection lost/);
  assert.equal((await f.store.get(OWNER))!.environmentCreatePending, true);
  f.controls.after = undefined;
  const recovered = await f.create().ensure(OWNER);
  assert.equal(recovered.environmentId, [...f.environments.keys()][0]);
  assert.equal(f.calls.filter(({ method, path }) => method === "POST" && path === "/environments").length, 1);
});

test("gateway does not repeat an uncertain environment create that has no visible resource", async () => {
  const f = fixture();
  f.controls.before = (call) => {
    if (call.method === "POST" && call.path === "/environments") throw new TypeError("connection lost");
    return undefined;
  };
  await assert.rejects(f.gateway.ensure(OWNER));
  f.controls.before = undefined;
  await assert.rejects(f.create().ensure(OWNER), /creation is uncertain/);
  assert.equal(f.calls.filter(({ method }) => method === "POST").length, 1);
});

test("gateway retries rejected environment and service creates without changing its token", async () => {
  for (const path of ["/environments", "/services"]) {
    const f = fixture();
    f.controls.before = (call) =>
      call.method === "POST" && call.path === path ? Response.json({}, { status: 400 }) : undefined;
    await assert.rejects(f.gateway.upsert(OWNER, APP, UPSTREAM), /HTTP 400/);
    const token = (await f.store.get(OWNER))!.token;
    f.controls.before = undefined;
    await f.create().upsert(OWNER, APP, UPSTREAM);
    assert.equal((await f.store.get(OWNER))!.token, token);
    assert.equal(f.environments.size, 1);
    assert.equal(f.services.size, 1);
  }
});

test("gateway recovers a lost service create response without a second service", async () => {
  const f = fixture();
  f.controls.after = (call, response) => {
    if (call.method === "POST" && call.path === "/services") throw new TypeError("connection lost");
    return response;
  };
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  assert.equal(f.services.size, 1);
  assert.equal(f.calls.filter(({ method, path }) => method === "POST" && path === "/services").length, 1);
  assert.ok(await f.gateway.endpoint(OWNER, APP));
});

test("gateway does not repeat a service create after an uncertain response without a resource", async () => {
  const f = fixture();
  f.controls.before = (call) => {
    if (call.method === "POST" && call.path === "/services") throw new TypeError("connection lost");
    return undefined;
  };
  await assert.rejects(f.gateway.upsert(OWNER, APP, UPSTREAM), /unconfirmed/);
  f.controls.before = undefined;
  await assert.rejects(f.create().upsert(OWNER, APP, UPSTREAM), /unconfirmed/);
  assert.equal(f.calls.filter(({ method, path }) => method === "POST" && path === "/services").length, 1);
  assert.equal(await f.gateway.endpoint(OWNER, APP), null);
});

test("gateway rejects ambiguous service recovery", async () => {
  const f = fixture();
  f.controls.after = (call, response) => {
    if (call.method === "POST" && call.path === "/services") {
      const service = [...f.services.values()][0]!;
      f.services.set("srv-gw-duplicate", { ...service, id: "srv-gw-duplicate" });
      throw new TypeError("connection lost");
    }
    return response;
  };
  await assert.rejects(f.gateway.upsert(OWNER, APP, UPSTREAM), /identity is ambiguous/);
  assert.equal(f.calls.filter(({ method, path }) => method === "POST" && path === "/services").length, 1);
});

test("gateway retries a failed deploy on its retained service", async () => {
  const f = fixture();
  f.controls.deployStatus = "update_failed";
  await assert.rejects(f.gateway.upsert(OWNER, APP, UPSTREAM), /deploy failed/);
  assert.equal(await f.gateway.endpoint(OWNER, APP), null);
  f.controls.deployStatus = "live";
  await f.create().upsert(OWNER, APP, UPSTREAM);
  assert.equal(f.services.size, 1);
  assert.equal(f.calls.filter(({ path, method }) => path.endsWith("/deploys") && method === "POST").length, 1);
});

test("gateway recovers an uncertain route deploy and does not trigger another one", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  f.controls.after = (call, response) => {
    if (call.method === "POST" && call.path.endsWith("/deploys")) throw new TypeError("connection lost");
    return response;
  };
  await f.gateway.upsert(OWNER, APP2, UPSTREAM2);
  assert.ok(await f.gateway.endpoint(OWNER, APP2));
  assert.equal(f.calls.filter(({ method, path }) => method === "POST" && path.endsWith("/deploys")).length, 1);
});

test("gateway requires the new config hash before it reports a route live", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  f.controls.healthHash = (await f.store.get(OWNER))!.appliedConfigHash;
  await assert.rejects(f.gateway.upsert(OWNER, APP2, UPSTREAM2), /unconfirmed/);
  const pending = (await f.store.get(OWNER))!;
  assert.ok(pending.pendingDeploy);
  assert.notEqual(pending.appliedConfigHash, pending.desiredConfigHash);
  assert.equal(await f.gateway.endpoint(OWNER, APP2), null);
  f.controls.healthHash = undefined;
  await f.create().upsert(OWNER, APP2, UPSTREAM2);
  assert.equal(f.calls.filter(({ method, path }) => method === "POST" && path.endsWith("/deploys")).length, 1);
});

test("gateway reconciles a lost suspension response", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  f.controls.after = (call, response) => {
    if (call.method === "POST" && call.path.endsWith("/suspend")) throw new TypeError("connection lost");
    return response;
  };
  await f.gateway.remove(OWNER, APP);
  assert.equal([...f.services.values()][0]!.suspended, "suspended");
  assert.equal((await f.store.get(OWNER))!.suspendPending, false);
});

test("gateway can suspend the last app after initial health fails", async () => {
  const f = fixture();
  f.controls.healthy = false;
  await assert.rejects(f.gateway.upsert(OWNER, APP, UPSTREAM), /unconfirmed/);
  await f.create().remove(OWNER, APP);
  const record = (await f.store.get(OWNER))!;
  assert.deepEqual(record.routes, {});
  assert.equal(record.pendingDeploy, undefined);
  assert.equal(f.services.get(record.gatewayServiceId!)!.suspended, "suspended");
});

test("gateway restores only after a pending suspension is confirmed", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  f.controls.before = (call) => {
    if (call.path.endsWith("/suspend")) throw new TypeError("connection lost");
    return undefined;
  };
  await assert.rejects(f.gateway.remove(OWNER, APP), /suspension is unconfirmed/);
  assert.equal((await f.store.get(OWNER))!.suspendPending, true);
  f.controls.before = undefined;
  await f.create().upsert(OWNER, APP, UPSTREAM);
  const calls = f.calls.filter(({ path, method }) => method === "POST" && /\/(suspend|resume)$/.test(path));
  assert.ok(calls.at(-2)!.path.endsWith("/suspend"));
  assert.ok(calls.at(-1)!.path.endsWith("/resume"));
  assert.ok(await f.gateway.endpoint(OWNER, APP));
});

test("gateway reads later service pages when it recovers creation", async () => {
  const f = fixture();
  f.controls.after = (call, response) => {
    if (call.path === "/services" && call.method === "POST") throw new TypeError("connection lost");
    return response;
  };
  f.controls.before = (call) => {
    if (call.path === "/services" && call.method === "GET" && !call.query.has("cursor")) {
      return Response.json(
        Array.from({ length: 100 }, (_, i) => ({
          service: { name: `unrelated-${i}` },
          cursor: `page-${i}`,
        })),
      );
    }
    return undefined;
  };
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  assert.equal(f.services.size, 1);
  assert.ok(f.calls.some(({ path, query }) => path === "/services" && query.get("cursor") === "page-99"));
});

test("gateway does not create resources after an invalid pagination response", async () => {
  const f = fixture();
  f.controls.before = (call) =>
    call.path === "/environments" && call.method === "GET"
      ? Response.json(Array.from({ length: 100 }, () => ({ environment: { name: "unrelated" }, cursor: "same" })))
      : undefined;
  await assert.rejects(f.gateway.ensure(OWNER), /resource list is incomplete/);
  assert.equal(f.calls.filter(({ method }) => method === "POST").length, 0);
});

test("gateway rejects ambiguous environment recovery", async () => {
  const f = fixture();
  f.controls.after = (call, response) => {
    if (call.path === "/environments" && call.method === "POST") {
      const environment = [...f.environments.values()][0]!;
      f.environments.set("env-duplicate", { ...environment, id: "env-duplicate" });
      throw new TypeError("connection lost");
    }
    return response;
  };
  await assert.rejects(f.gateway.ensure(OWNER));
  await assert.rejects(f.create().ensure(OWNER), /identity is ambiguous/);
  assert.equal(f.calls.filter(({ method }) => method === "POST").length, 1);
});

test("gateway saves create intent before it calls Render", async () => {
  for (const path of ["/environments", "/services"]) {
    const f = fixture();
    const put = f.store.put;
    f.store.put = async (id, record) => {
      if (
        (path === "/environments" && record.environmentCreatePending) ||
        (path === "/services" && record.gatewayCreatePending)
      )
        throw new Error("store unavailable");
      await put(id, record);
    };
    await assert.rejects(f.gateway.upsert(OWNER, APP, UPSTREAM), /store unavailable/);
    assert.equal(f.calls.filter((call) => call.method === "POST" && call.path === path).length, 0);
  }
});

test("gateway rejects a public address outside onrender.com without sending its token", async () => {
  const f = fixture();
  await f.gateway.upsert(OWNER, APP, UPSTREAM);
  [...f.services.values()][0]!.serviceDetails.url = "https://example.com";
  await assert.rejects(f.gateway.endpoint(OWNER, APP), /invalid public address/);
});

test("gateway does not replace a missing retained environment", async () => {
  const f = fixture();
  await f.gateway.ensure(OWNER);
  f.environments.clear();
  await assert.rejects(f.gateway.ensure(OWNER), /retained Render gateway environment is missing/);
  assert.equal(f.calls.filter(({ method }) => method === "POST").length, 1);
});
