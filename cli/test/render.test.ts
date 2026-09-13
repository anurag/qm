import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { hostingProvider, type DeployContext } from "../src/backends/registry.ts";
import { renderConfigErrors, renderDeploymentLayerTransport, renderInternalUrl } from "../src/backends/render.ts";
import { loadConfigAt } from "../src/config.ts";
import { renderScaffold } from "../src/provider-scaffold.ts";
import { computedSecrets } from "../src/secrets.ts";
import { renderMinioCommand, renderMinioImage } from "../src/render-minio.ts";

function deployment(t: TestContext, external = false, portal = false) {
  const dir = mkdtempSync(join(tmpdir(), "qm-render-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = JSON.parse(renderScaffold.renderConfig("acme", "anthropic", "resend"));
  raw.render.workspaceId = "tea-acme";
  if (external) raw.render.storage = { type: "external" };
  raw.services = portal ? ["core", "web-ui", "portal", "auth", "admin"] : ["core", "web-ui"];
  raw.env = {
    ...(portal ? { auth: { ...raw.env.auth, AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" } } : {}),
    core: { ...raw.env.core, HARNESS: "mock", RENDER_DEPLOY_IMAGE: `example.com/runner@sha256:${"a".repeat(64)}` },
  };
  if (external) Object.assign(raw.env.core, { S3_BUCKET: "acme-data", S3_REGION: "us-east-1" });
  delete raw.modelProvider;
  delete raw.secretEnv;
  const configPath = join(dir, "qm.config.jsonc");
  writeFileSync(configPath, JSON.stringify(raw));
  const config = loadConfigAt(configPath).config;
  writeFileSync(
    join(dir, ".env"),
    computedSecrets(config)
      .filter((secret) => secret.managedBy === "operator" && secret.required)
      .map((secret) => `${secret.name}=${"e".repeat(64)}`)
      .join("\n"),
  );
  const ctx: DeployContext = { config, configPath, configDir: dir, sandboxDir: join(dir, "sandbox"), target: "render" };
  return {
    ctx,
    backend: hostingProvider("render").createBackend(ctx),
    saved: () => JSON.parse(readFileSync(join(dir, "render.resources.json"), "utf8")),
  };
}
type Deployment = ReturnType<typeof deployment>;
interface Service {
  id: string;
  name: string;
  type: string;
  ownerId: string;
  environmentId: string;
  slug: string;
  imagePath?: string;
  repo?: string;
  branch?: string;
  rootDir?: string;
  autoDeploy: string;
  suspended: string;
  serviceDetails: {
    url: string;
    region: string;
    plan: string;
    runtime: string;
    numInstances: number;
    envSpecificDetails: { dockerCommand: string; dockerfilePath?: string; dockerContext?: string };
    healthCheckPath?: string;
    maxShutdownDelaySeconds?: number;
    disk?: { id: string; name: string; mountPath: string; sizeGB: number };
  };
}
interface Database {
  id: string;
  name: string;
  owner: { id: string };
  environmentId: string;
  region: string;
  plan: string;
  diskSizeGB: number;
  status: string;
  suspended: string;
}
interface Project {
  id: string;
  name: string;
  owner: { id: string };
  environmentIds: string[];
}
interface Call {
  path: string;
  method: string;
  body: unknown;
  url: URL;
}
function cloud(t: TestContext, d: Deployment) {
  const state = {
    calls: [] as Call[],
    services: new Map<string, Service>(),
    envs: new Map<string, Record<string, string>>(),
    deploys: new Map<string, { id: string; status: string }>(),
    projects: new Map<string, Project>(),
    database: undefined as Database | undefined,
    intercept: undefined as ((call: Call) => Response | undefined | Promise<Response | undefined>) | undefined,
    nextDeployStatus: "live",
    nextJobStatus: "succeeded",
    next: 0,
  };
  const empty = () => new Response(null, { status: 204 });
  const missing = () => new Response(null, { status: 404 });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.origin === "https://api.render.com" ? url.pathname.slice(3) : url.pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { path, method, body, url };
    state.calls.push(call);
    const intercepted = await state.intercept?.(call);
    if (intercepted) return intercepted;
    if (url.origin !== "https://api.render.com") {
      if (path === "/healthz") return new Response("ok");
      if (path === "/v1/deployment-layer") {
        assert.equal(url.origin, state.services.get("srv-acme-core")!.serviceDetails.url);
        return Response.json({ status: "applied", durable: true, version: 1 });
      }
      throw new Error(`Unexpected application request ${path}`);
    }
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${"e".repeat(64)}`);
    if (path === "/owners/tea-acme") return Response.json({ id: "tea-acme" });
    if (path === "/projects") {
      if (method === "GET")
        return Response.json(
          [...state.projects.values()]
            .filter((item) => !url.searchParams.has("name") || item.name === url.searchParams.get("name"))
            .map((project) => ({ project, cursor: project.id })),
        );
      assert.deepEqual(body, { name: "acme-qm", ownerId: "tea-acme", environments: [{ name: "production" }] });
      assert.equal(d.saved().pendingCreate, "/projects: acme-qm");
      const project = { id: "prj-acme", name: body.name, owner: { id: body.ownerId }, environmentIds: ["evm-acme"] };
      state.projects.set(project.id, project);
      return Response.json(project);
    }
    if (path === "/projects/prj-acme")
      return state.projects.has("prj-acme") ? Response.json(state.projects.get("prj-acme")) : missing();
    if (path === "/environments/evm-acme")
      return Response.json({ id: "evm-acme", name: "production", projectId: "prj-acme" });
    if (path === "/postgres") {
      if (method === "GET") return Response.json(state.database ? [{ postgres: state.database, cursor: "pg" }] : []);
      assert.equal(body.environmentId, "evm-acme");
      assert.equal(body.ownerId, "tea-acme");
      assert.equal(body.version, "18");
      assert.deepEqual(body.ipAllowList, []);
      state.database = {
        id: "dpg-acme",
        name: body.name,
        owner: { id: body.ownerId },
        environmentId: body.environmentId,
        region: body.region,
        plan: body.plan,
        diskSizeGB: body.diskSizeGB,
        status: "available",
        suspended: "not_suspended",
      };
      return Response.json(state.database);
    }
    if (path === "/postgres/dpg-acme/connection-info")
      return Response.json({ internalConnectionString: "postgresql://qm:private-password@pg/qm" });
    if (path === "/postgres/dpg-acme") {
      if (!state.database) return missing();
      if (method === "DELETE") {
        state.database = undefined;
        return empty();
      }
      if (method === "PATCH") Object.assign(state.database, body);
      return Response.json(state.database);
    }
    if (path === "/services") {
      if (method === "GET")
        return Response.json(
          [...state.services.values()]
            .filter((item) => !url.searchParams.has("name") || item.name === url.searchParams.get("name"))
            .map((service) => ({ service, cursor: service.id })),
        );
      assert.equal(body.environmentId, "evm-acme");
      if (body.repo) {
        assert.equal(body.image, undefined);
        assert.equal(body.serviceDetails.runtime, "docker");
        assert.equal(body.rootDir, "");
        assert.equal(body.serviceDetails.envSpecificDetails.dockerContext, ".");
        assert.match(body.serviceDetails.envSpecificDetails.dockerfilePath, /^deploy\/.+\/Dockerfile$/);
      } else {
        assert.equal(body.image.ownerId, "tea-acme");
        assert.equal(body.serviceDetails.runtime, "image");
      }
      if (body.serviceDetails.disk && body.serviceDetails.maxShutdownDelaySeconds !== undefined)
        return Response.json({ message: "Disk services cannot set maxShutdownDelaySeconds" }, { status: 400 });
      assert.equal(body.autoDeploy, "no");
      assert.ok(d.saved().pendingCreate);
      const id = `srv-${body.name}`;
      const service: Service = {
        ...body,
        id,
        slug: `${body.name}-assigned`,
        imagePath: body.image?.imagePath,
        suspended: "not_suspended",
        serviceDetails: {
          ...body.serviceDetails,
          url:
            body.type === "private_service"
              ? `${body.name}-assigned:10000`
              : `https://${body.name}-assigned.onrender.com`,
          ...(body.serviceDetails.disk ? { disk: { ...body.serviceDetails.disk, id: "dsk-minio" } } : {}),
        },
      };
      state.services.set(id, service);
      state.envs.set(
        id,
        Object.fromEntries(body.envVars.map((env: { key: string; value: string }) => [env.key, env.value])),
      );
      const deploy = { id: `dep-${++state.next}`, status: "live" };
      state.deploys.set(id, deploy);
      return Response.json({ service, deployId: deploy.id });
    }
    const id = path.split("/")[2]!;
    if (path.startsWith("/services/")) {
      const service = state.services.get(id);
      if (!service) return missing();
      if (path === `/services/${id}`) {
        if (method === "DELETE") {
          state.services.delete(id);
          return empty();
        }
        if (method === "PATCH") {
          assert.equal(body.environmentId, undefined);
          assert.equal(body.serviceDetails.numInstances, undefined);
          if (service.serviceDetails.disk && body.serviceDetails.maxShutdownDelaySeconds !== undefined)
            return Response.json({ message: "Disk services cannot set maxShutdownDelaySeconds" }, { status: 400 });
          service.autoDeploy = body.autoDeploy;
          if (body.repo) {
            assert.equal(body.image, undefined);
            assert.equal(body.serviceDetails.runtime, "docker");
            service.repo = body.repo;
            service.branch = body.branch;
            service.rootDir = body.rootDir;
            delete service.imagePath;
          } else {
            assert.equal(body.serviceDetails.runtime, "image");
            service.imagePath = body.image.imagePath;
            delete service.repo;
            delete service.branch;
          }
          Object.assign(service.serviceDetails, body.serviceDetails);
        }
        return Response.json(service);
      }
      if (path === `/services/${id}/env-vars`) {
        if (method === "GET")
          return Response.json(
            Object.entries(state.envs.get(id)!).map(([key, value]) => ({ envVar: { key, value }, cursor: key })),
          );
        state.envs.set(
          id,
          Object.fromEntries(body.map((item: { key: string; value: string }) => [item.key, item.value])),
        );
        return empty();
      }
      if (path.startsWith(`/services/${id}/env-vars/`)) {
        state.envs.get(id)![decodeURIComponent(path.split("/").at(-1)!)] = body.value;
        return empty();
      }
      if (path === `/services/${id}/deploys`) {
        if (method === "GET") return Response.json([{ deploy: state.deploys.get(id) }]);
        const deploy = { id: `dep-${++state.next}`, status: state.nextDeployStatus };
        state.deploys.set(id, deploy);
        return Response.json(deploy);
      }
      if (path.startsWith(`/services/${id}/deploys/`)) return Response.json(state.deploys.get(id));
      if (path === `/services/${id}/jobs` && method === "POST")
        return Response.json({ id: "job-acmecanary", serviceId: id, status: "pending" }, { status: 201 });
      if (path === `/services/${id}/jobs/job-acmecanary`)
        return Response.json({ id: "job-acmecanary", serviceId: id, status: state.nextJobStatus });
      if (path === `/services/${id}/jobs/job-acmecanary/cancel` && method === "POST")
        return Response.json({ id: "job-acmecanary", serviceId: id, status: "canceled" });
      if (path.endsWith("/suspend") || path.endsWith("/resume")) {
        service.suspended = path.endsWith("/suspend") ? "suspended" : "not_suspended";
        if (service.suspended === "not_suspended")
          state.deploys.set(id, { id: `dep-${++state.next}`, status: state.nextDeployStatus });
        return empty();
      }
    }
    if (path === "/disks/dsk-minio" && method === "PATCH") {
      state.services.get("srv-acme-minio")!.serviceDetails.disk!.sizeGB = body.sizeGB;
      return empty();
    }
    if (path === "/logs")
      return Response.json({
        logs: [{ id: "log-a", timestamp: "2026-09-12T00:00:00Z", message: "ready" }],
        hasMore: false,
      });
    throw new Error(`Unexpected Render request ${method} ${path}`);
  });
  return state;
}
const writes = (calls: Call[]) =>
  calls.filter((call) => call.url.origin === "https://api.render.com" && call.method !== "GET");

test("Render creates one project and wires MinIO credentials, URLs, Postgres, and repeat deployments", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
  assert.equal(c.services.get("srv-acme-core")!.serviceDetails.healthCheckPath, "/healthz");
  assert.equal(d.saved().environmentId, "evm-acme");
  const minio = c.envs.get("srv-acme-minio")!;
  const core = c.envs.get("srv-acme-core")!;
  assert.equal(core.AWS_SECRET_ACCESS_KEY, minio.QM_STORAGE_SECRET_KEY);
  assert.notEqual(minio.MINIO_ROOT_PASSWORD, core.AWS_SECRET_ACCESS_KEY);
  assert.equal(core.AWS_ACCESS_KEY_ID, "qm-storage");
  assert.equal(core.AWS_ENDPOINT_URL_S3, "https://acme-minio-assigned.onrender.com");
  assert.equal(core.RENDER_ENVIRONMENT_ID, "evm-acme");
  assert.equal(core.DATABASE_URL, "postgresql://qm:private-password@pg/qm");
  assert.equal(core.PUBLIC_API_URL, "https://acme-core-assigned.onrender.com");
  assert.equal(minio.MINIO_API_CORS_ALLOW_ORIGIN, "https://acme-web-ui-assigned.onrender.com");
  assert.equal(minio.MINIO_BROWSER, "off");
  assert.equal(c.services.get("srv-acme-minio")!.imagePath, renderMinioImage);
  assert.equal(c.services.get("srv-acme-minio")!.serviceDetails.envSpecificDetails.dockerCommand, renderMinioCommand);
  for (const [id, env] of c.envs)
    if (id !== "srv-acme-minio") {
      assert.equal(env.MINIO_ROOT_PASSWORD, undefined);
      assert.equal(env.QM_STORAGE_SECRET_KEY, undefined);
    }
  const disk = readFileSync(join(d.ctx.configDir, "render.resources.json"), "utf8");
  for (const secret of [minio.MINIO_ROOT_PASSWORD!, minio.QM_STORAGE_SECRET_KEY!, "private-password", "e".repeat(64)])
    assert.equal(disk.includes(secret), false);
  const first = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(
    writes(c.calls.slice(first)).map((call) => [call.path, call.method]),
    [["/services/srv-acme-minio/jobs", "POST"]],
  );
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, minio.MINIO_ROOT_PASSWORD);
});

test("Render plan needs no API calls, Git repository, or state file", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: true });
  assert.equal(c.calls.length, 0);
  assert.equal(existsSync(join(d.ctx.configDir, "render.resources.json")), false);
});

test("Render waits for MinIO initialization before deploying core and retries a failed job", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.nextJobStatus = "failed";
  await assert.rejects(d.backend.up({ dryRun: false }), /MinIO initialization job.*failed/);
  assert.ok(d.saved().dirtyServices.includes("minio"));
  assert.equal(
    c.calls.some((call) => call.method === "POST" && call.path === "/services/srv-acme-core/deploys"),
    false,
  );
  const before = c.calls.length;
  c.nextJobStatus = "succeeded";
  await d.backend.up({ dryRun: false });
  const writesAfter = writes(c.calls.slice(before));
  assert.equal(
    writesAfter.some((call) => call.path === "/services"),
    false,
  );
  const initialized = writesAfter.findIndex((call) => call.path === "/services/srv-acme-minio/jobs");
  const coreDeploy = writesAfter.findIndex((call) => call.path === "/services/srv-acme-core/deploys");
  assert.ok(initialized >= 0 && coreDeploy > initialized);
  assert.deepEqual(d.saved().dirtyServices, []);
  const command = (writesAfter[initialized]!.body as { startCommand: string }).startCommand;
  const env = c.envs.get("srv-acme-minio")!;
  for (const secret of [env.MINIO_ROOT_PASSWORD!, env.QM_STORAGE_SECRET_KEY!])
    assert.equal(command.includes(secret), false);
});

test("Render builds QM services from Git and uses the upstream MinIO image", async (t) => {
  const d = deployment(t, false, true);
  d.ctx.config.render!.source = { repo: "https://github.com/acme/qm", branch: "render-test" };
  delete d.ctx.config.env.core!.RENDER_DEPLOY_IMAGE;
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const saved = d.saved();
  assert.equal(c.services.size, 4);
  for (const service of c.services.values()) {
    if (service.id === "srv-acme-minio") continue;
    assert.equal(service.repo, "https://github.com/acme/qm");
    assert.equal(service.branch, "render-test");
    assert.equal(service.imagePath, undefined);
    assert.equal(service.serviceDetails.runtime, "docker");
    assert.equal(service.autoDeploy, "no");
  }
  assert.equal(c.services.get("srv-acme-minio")!.imagePath, renderMinioImage);
  assert.equal(c.services.get("srv-acme-minio")!.serviceDetails.runtime, "image");
  assert.equal(c.services.get("srv-acme-minio")!.repo, undefined);
  assert.equal(
    c.services.get("srv-acme-portal")!.serviceDetails.envSpecificDetails.dockerfilePath,
    "deploy/portal/Dockerfile",
  );
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_IMAGE, "");
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_REPO, "https://github.com/acme/qm");
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_BRANCH, "render-test");
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved(), saved);
  const changes = writes(c.calls.slice(mark));
  assert.equal(changes.length, 4);
  assert.ok(
    changes.every(
      (call) =>
        call.method === "POST" && (call.path.endsWith("/deploys") || call.path === "/services/srv-acme-minio/jobs"),
    ),
  );
});

test("Render converts image services to Git and back while retaining data and resource IDs", async (t) => {
  const d = deployment(t, false, true);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const saved = d.saved();
  const storage = { ...c.envs.get("srv-acme-minio")! };
  const disk = { ...c.services.get("srv-acme-minio")!.serviceDetails.disk! };
  d.ctx.config.render!.source = { repo: "https://github.com/acme/qm", branch: "render-test" };
  delete d.ctx.config.env.core!.RENDER_DEPLOY_IMAGE;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved(), saved);
  assert.deepEqual(c.services.get("srv-acme-minio")!.serviceDetails.disk, disk);
  assert.deepEqual(c.envs.get("srv-acme-minio"), storage);
  const core = c.services.get("srv-acme-core")!;
  core.repo = "https://github.com/ACME/QM.git";
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(writes(c.calls.slice(mark)).filter((call) => call.method === "PATCH").length, 0);
  d.ctx.config.render!.source.branch = "next-release";
  await d.backend.up({ dryRun: false });
  assert.equal(core.branch, "next-release");
  assert.equal(c.envs.get(core.id)!.RENDER_DEPLOY_BRANCH, "next-release");
  delete d.ctx.config.render!.source;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved(), saved);
  assert.deepEqual(c.services.get("srv-acme-minio")!.serviceDetails.disk, disk);
  assert.deepEqual(c.envs.get("srv-acme-minio"), storage);
  for (const service of c.services.values()) {
    assert.equal(service.serviceDetails.runtime, "image");
    assert.equal(service.repo, undefined);
    assert.equal(service.branch, undefined);
    assert.ok(service.imagePath);
  }
  assert.equal(c.envs.get(core.id)!.RENDER_DEPLOY_REPO, "");
  assert.equal(c.envs.get(core.id)!.RENDER_DEPLOY_BRANCH, "");
  assert.ok(c.envs.get(core.id)!.RENDER_DEPLOY_IMAGE);
});

test("Render retries a failed Git build using the same services", async (t) => {
  const d = deployment(t, true);
  d.ctx.config.render!.source = { repo: "https://github.com/acme/qm", branch: "render-test" };
  const c = cloud(t, d);
  c.nextDeployStatus = "build_failed";
  await assert.rejects(d.backend.up({ dryRun: false }), /build_failed/);
  assert.ok(d.saved().dirtyServices.includes("core"));
  c.nextDeployStatus = "live";
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().dirtyServices, []);
  assert.equal(c.services.size, 2);
  assert.equal(c.calls.filter((call) => call.path === "/services" && call.method === "POST").length, 2);
});

test("Render updates a changed image and recovers a failed deployment without new resources", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.imageOverrides.core = `example.com/core@sha256:${"b".repeat(64)}`;
  c.nextDeployStatus = "update_failed";
  await assert.rejects(d.backend.up({ dryRun: false }), /update_failed/);
  assert.ok(d.saved().dirtyServices.includes("core"));
  assert.equal(c.services.get("srv-acme-core")!.imagePath, d.ctx.config.imageOverrides.core);
  const mark = c.calls.length;
  c.nextDeployStatus = "live";
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().dirtyServices, []);
  assert.ok(
    c.calls.slice(mark).some((call) => call.path === "/services/srv-acme-core/deploys" && call.method === "POST"),
  );
  assert.equal(c.calls.filter((call) => call.path === "/services" && call.method === "POST").length, 3);
});

test("Render retries after env write failure even if a preceding image update succeeded", async (t) => {
  const d = deployment(t, true);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.imageOverrides.core = `example.com/core@sha256:${"b".repeat(64)}`;
  d.ctx.config.env.core!.FEATURE = "new";
  c.intercept = (call) =>
    call.path === "/services/srv-acme-core/env-vars" && call.method === "PUT"
      ? new Response(null, { status: 500 })
      : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  assert.ok(d.saved().dirtyServices.includes("core"));
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-core")!.FEATURE, "new");
  assert.deepEqual(d.saved().dirtyServices, []);
});

test("Render retains completed resource IDs after a later create fails", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) =>
    call.path === "/services" && call.method === "POST" && (call.body as { name: string }).name === "acme-core"
      ? new Response(null, { status: 400 })
      : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 400/);
  assert.equal(Object.keys(d.saved().services).length, 1);
  assert.equal(d.saved().pendingCreate, undefined);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
});

for (const status of ["live", "update_failed"]) {
  test(`Render follows an empty accepted deploy response until the new deploy is ${status}`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    await d.backend.up({ dryRun: false });
    const previous = c.deploys.get("srv-acme-core")!;
    const mark = c.calls.length;
    let queued = false;
    let listReads = 0;
    c.intercept = ({ path, method }) => {
      if (path === "/services/srv-acme-core/deploys" && method === "POST") {
        queued = true;
        return new Response(null, { status: 202 });
      }
      if (path === "/services/srv-acme-core/deploys" && queued) {
        const deploy = ++listReads === 1 ? previous : { id: "dep-queued", status: "queued" };
        return Response.json([{ deploy }]);
      }
      if (path === "/services/srv-acme-core/deploys/dep-queued") return Response.json({ id: "dep-queued", status });
      return undefined;
    };
    d.ctx.config.imageOverrides.core = `example.com/core@sha256:${"b".repeat(64)}`;
    if (status === "live") {
      await d.backend.up({ dryRun: false });
      assert.deepEqual(d.saved().dirtyServices, []);
    } else {
      await assert.rejects(d.backend.up({ dryRun: false }), /dep-queued ended with update_failed/);
      assert.ok(d.saved().dirtyServices.includes("core"));
    }
    assert.equal(listReads, 2);
    assert.equal(
      c.calls.slice(mark).filter((call) => call.path === "/services/srv-acme-core/deploys" && call.method === "POST")
        .length,
      1,
    );
    assert.equal(
      c.calls.slice(mark).some((call) => call.path === `/services/srv-acme-core/deploys/${previous.id}`),
      false,
    );
  });
}

for (const [initial, terminal] of [
  ["queued", "live"],
  ["update_in_progress", "update_failed"],
]) {
  test(`Render waits for a previous ${initial} deploy before it submits an update`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    await d.backend.up({ dryRun: false });
    const previous = c.deploys.get("srv-acme-core")!;
    let reads = 0;
    let triggered = false;
    c.intercept = ({ path, method, url }) => {
      if (path === "/services/srv-acme-core/deploys" && method === "GET" && !triggered) {
        if (url.searchParams.get("limit") === "100") reads++;
        return Response.json([
          { deploy: previous },
          { deploy: { id: "dep-active", status: reads < 2 ? initial : terminal } },
        ]);
      }
      if (path === "/services/srv-acme-core/deploys" && method === "POST") {
        assert.equal(reads, 2);
        triggered = true;
      }
      return undefined;
    };
    d.ctx.config.imageOverrides.core = `example.com/core@sha256:${"b".repeat(64)}`;
    await d.backend.up({ dryRun: false });
    assert.equal(triggered, true);
    assert.deepEqual(d.saved().dirtyServices, []);
  });
}

test("Render refuses retries after an uncertain create response", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) => {
    if (call.path === "/services" && call.method === "POST") throw new TypeError("connection closed");
    return undefined;
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /connection closed/);
  assert.equal(d.saved().pendingCreate, "/services: acme-minio");
  c.intercept = undefined;
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /unknown result/);
  assert.equal(c.calls.length, mark);
});

test("Render retries a resource creation rejected by rate limiting", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) =>
    call.path === "/services" && call.method === "POST" ? new Response(null, { status: 429 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 429/);
  assert.equal(d.saved().pendingCreate, undefined);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
});

test("Render rejects unrecorded same-name resources and changed ownership before mutations", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.projects.set("prj-existing", {
    id: "prj-existing",
    name: "acme-qm",
    owner: { id: "tea-acme" },
    environmentIds: [],
  });
  await assert.rejects(d.backend.up({ dryRun: false }), /Refusing to adopt/);
  assert.deepEqual(writes(c.calls), []);
  c.projects.clear();
  await d.backend.up({ dryRun: false });
  c.services.get("srv-acme-web-ui")!.environmentId = "evm-other";
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /does not match/);
  assert.deepEqual(writes(c.calls.slice(mark)), []);
  await assert.rejects(async () => d.backend.down({ purge: true }), /does not match/);
  assert.equal(c.services.size, 3);
});

test("Render external storage needs operator credentials and creates no MinIO", async (t) => {
  const d = deployment(t, true);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  assert.equal(c.services.size, 2);
  const core = c.envs.get("srv-acme-core")!;
  assert.equal(core.AWS_ACCESS_KEY_ID, "e".repeat(64));
  assert.equal(core.RENDER_QM_MINIO, "false");
  assert.equal(core.AWS_ENDPOINT_URL_S3, "");
  assert.equal(core.S3_FORCE_PATH_STYLE, "false");
});

test("Render stops services and resumes them while retaining database and disk", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  await d.backend.down({});
  assert.equal(c.services.get("srv-acme-minio")!.suspended, "suspended");
  assert.ok(c.database);
  assert.equal(c.services.size, 3);
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.ok([...c.services.values()].every((service) => service.suspended === "not_suspended"));
  assert.equal(
    c.calls.slice(mark).some((call) => call.path.endsWith("/deploys") && call.method === "POST"),
    false,
  );
});

test("Render protects published apps before shutdown or purge", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const app = {
    ...c.services.get("srv-acme-web-ui")!,
    id: "srv-published-app",
    name: "qm-app-a1",
    type: "private_service",
  };
  c.services.set(app.id, app);
  c.envs.set(app.id, { QM_DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000001" });
  for (const purge of [false, true]) {
    const mark = c.calls.length;
    await assert.rejects(async () => d.backend.down({ purge }), /Published apps still use this deployment/);
    assert.deepEqual(writes(c.calls.slice(mark)), []);
    assert.equal(d.saved().pendingPurge, undefined);
  }
  app.suspended = "suspended";
  await assert.rejects(async () => d.backend.down({ purge: true }), /Published apps still use this deployment/);
  await d.backend.down({});
  assert.ok(c.database);
});

test("Render purge resumes partial deletion and retains the project", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.intercept = (call) =>
    call.path === "/services/srv-acme-core" && call.method === "DELETE"
      ? new Response(null, { status: 500 })
      : undefined;
  await assert.rejects(async () => d.backend.down({ purge: true }), /HTTP 500/);
  assert.equal(d.saved().pendingPurge, true);
  assert.ok(c.database);
  await assert.rejects(d.backend.up({ dryRun: false }), /cleanup is incomplete/);
  c.intercept = undefined;
  await d.backend.down({ purge: true });
  assert.equal(c.services.size, 0);
  assert.equal(c.database, undefined);
  assert.equal(c.projects.size, 1);
  assert.deepEqual(d.saved().services, {});
  await d.backend.up({ dryRun: false });
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
});

test("Render secret push targets consumers, keeps MinIO root secrets, and clears explicit optional tokens", async (t) => {
  const d = deployment(t, true);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.envs.get("srv-acme-core")!.AWS_SESSION_TOKEN = "old-session";
  writeFileSync(
    join(d.ctx.configDir, ".env"),
    `${readFileSync(join(d.ctx.configDir, ".env"), "utf8")}\nAWS_SESSION_TOKEN=\n`,
  );
  await d.backend.secretsPush();
  assert.equal(c.envs.get("srv-acme-core")!.AWS_SESSION_TOKEN, "");
  assert.equal(c.envs.get("srv-acme-web-ui")!.AWS_SECRET_ACCESS_KEY, undefined);
  assert.ok(d.saved().dirtyServices.includes("core"));
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().dirtyServices, []);
});

test("Render rejects disk shrink and non-Render custom URLs", async (t) => {
  const d = deployment(t);
  cloud(t, d);
  await d.backend.up({ dryRun: false });
  if (d.ctx.config.render!.storage.type === "minio") d.ctx.config.render!.storage.diskSizeGB = 1;
  await assert.rejects(d.backend.up({ dryRun: false }), /cannot shrink/);
  d.ctx.config.publicUrl = "https://qm.example.com";
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /onrender.com/.test(error.message)));
});

test("Render reports status, logs, and signed layer health from saved IDs", async (t) => {
  const d = deployment(t, false, true);
  mkdirSync(d.ctx.sandboxDir);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  await d.backend.status();
  await d.backend.logs("core", { follow: false, tail: 10 });
  await d.backend.checkLive!();
  const layerCalls = c.calls.filter((call) => call.path === "/v1/deployment-layer");
  assert.deepEqual(
    layerCalls.map((call) => call.method),
    ["PUT", "GET"],
  );
  assert.ok(layerCalls.every((call) => call.url.origin === "https://acme-core-assigned.onrender.com"));
  assert.equal(d.ctx.config.publicUrl, "https://acme-portal-assigned.onrender.com");
  assert.ok(c.calls.some((call) => call.path === "/logs" && call.url.searchParams.get("resource") === "srv-acme-core"));
  assert.deepEqual(c.calls.find((call) => call.path === "/services/srv-acme-core/jobs")?.body, {
    startCommand:
      "timeout -s TERM -k 30 1200 node src/deployment/postdeploy-smoke.ts session http://acme-core-assigned:8080",
  });
});

test("Render layer transport rejects missing or invalid core URLs before sending a request", async (t) => {
  const d = deployment(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("ok");
  });
  for (const apiUrl of [
    undefined,
    "http://core.onrender.com",
    "https://user:password@core.onrender.com",
    "https://core.example.com",
    "https://core.onrender.com/path",
    "https://core.onrender.com?query=value",
    "https://core.onrender.com#fragment",
  ]) {
    d.ctx.config.apiUrl = apiUrl;
    await assert.rejects(
      () =>
        renderDeploymentLayerTransport({
          config: d.ctx.config,
          configDir: d.ctx.configDir,
          method: "GET",
          body: "",
        }),
      /Render requires apiUrl|Render deployment-layer URL must be/,
    );
  }
  assert.equal(requests, 0);
});

test("Render live checks reject foreign resources and stale URLs before starting a canary", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const core = c.services.get("srv-acme-core")!;
  core.ownerId = "tea-other";
  await assert.rejects(async () => d.backend.checkLive!(), /does not match/);
  core.ownerId = "tea-acme";
  d.ctx.config.apiUrl = "https://other-core.onrender.com";
  await assert.rejects(async () => d.backend.checkLive!(), /URLs do not match/);
  d.ctx.config.apiUrl = core.serviceDetails.url;
  core.slug = "core; unexpected-command";
  await assert.rejects(async () => d.backend.checkLive!(), /invalid private hostname/);
  assert.equal(
    c.calls.some((call) => call.path === "/services/srv-acme-core/jobs"),
    false,
  );
});

test("Render live checks fail on failed and canceled canaries and identify their logs", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  for (const status of ["failed", "canceled"]) {
    c.nextJobStatus = status;
    await assert.rejects(
      async () => d.backend.checkLive!({ report: false }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`job-acmecanary ended with ${status}`));
        assert.match(error.message, /GET \/v1\/logs\?ownerId=tea-acme&resource=job-acmecanary/);
        return true;
      },
    );
  }
  assert.equal(
    c.calls.some((call) => call.path.endsWith("/cancel")),
    false,
  );
});

test("Render live checks cancel a job that exceeds the deadline", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  c.nextJobStatus = "running";
  c.intercept = (call) => {
    if (call.path === "/services/srv-acme-core/jobs/job-acmecanary") now += 21 * 60_000;
    return undefined;
  };
  await assert.rejects(
    async () => d.backend.checkLive!({ report: false }),
    /job-acmecanary did not finish within 20 minutes/,
  );
  assert.equal(c.calls.filter((call) => call.path.endsWith("/cancel") && call.method === "POST").length, 1);
});

test("Render live checks cancel after a polling failure and report cleanup failures", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.intercept = (call) =>
    call.path === "/services/srv-acme-core/jobs/job-acmecanary" || call.path.endsWith("/cancel")
      ? new Response(null, { status: 503 })
      : undefined;
  await assert.rejects(
    async () => d.backend.checkLive!({ report: false }),
    /job-acmecanary.*HTTP 503.*cancellation failed/,
  );
  assert.equal(c.calls.filter((call) => call.path.endsWith("/cancel") && call.method === "POST").length, 1);
});

test("private Render addresses use the workload port", () => {
  assert.equal(
    renderInternalUrl({
      name: "web-ui",
      slug: "qm-web-abcd",
    }),
    "http://qm-web-abcd:8080",
  );
  for (const slug of ["", "web.onrender.com", "web:8080", "web/path", "web; command"])
    assert.throws(() => renderInternalUrl({ name: "web-ui", slug }), /invalid private hostname/);
});

test("Render connects a private web UI to the public portal and copies shared auth secrets", async (t) => {
  const d = deployment(t, false, true);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const portal = c.envs.get("srv-acme-portal")!;
  const core = c.envs.get("srv-acme-core")!;
  assert.equal(portal.CORE_API_URL, "http://acme-core-assigned:8080");
  assert.equal(c.envs.get("srv-acme-web-ui")!.CORE_API_URL, "http://acme-core-assigned:8080");
  assert.equal(core.PUBLIC_API_URL, "https://acme-core-assigned.onrender.com");
  assert.equal(c.services.get("srv-acme-web-ui")!.type, "private_service");
  assert.equal(portal.WEB_UI_UPSTREAM, "http://acme-web-ui-assigned:8080");
  assert.equal(portal.ADMIN_UPSTREAM, "http://acme-web-ui-assigned:8080/admin");
  assert.equal(d.ctx.config.publicUrl, "https://acme-portal-assigned.onrender.com");
  assert.equal(portal.AUTH_CLIENT_SECRET, portal.OIDC_CLIENT_SECRET);
  assert.equal(portal.CORE_SIGNING_SECRET, core.CORE_SIGNING_SECRET);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_BROWSER, "off");
});

test("external storage permits an isolated plugin named minio without storage credentials", async (t) => {
  const d = deployment(t, true);
  d.ctx.config.plugins.push({
    name: "minio",
    image: `example.com/plugin@sha256:${"a".repeat(64)}`,
    coreAccess: false,
    env: { CUSTOM: "yes" },
  });
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const plugin = c.envs.get("srv-acme-minio")!;
  assert.equal(plugin.CUSTOM, "yes");
  assert.equal(plugin.DATABASE_URL, undefined);
  assert.equal(plugin.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(plugin.MINIO_ROOT_PASSWORD, undefined);
  assert.equal(plugin.CORE_SIGNING_SECRET, undefined);
  assert.equal(c.services.get("srv-acme-minio")!.type, "private_service");
});

test("Render restores remote drift and grows storage without replacing resources", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const root = c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD;
  c.services.get("srv-acme-core")!.imagePath = "example.com/wrong:latest";
  c.envs.get("srv-acme-core")!.DEPLOY_PROVIDER = "fly";
  if (d.ctx.config.render!.storage.type === "minio") d.ctx.config.render!.storage.diskSizeGB = 20;
  d.ctx.config.render!.postgresDiskSizeGB = 20;
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-core")!.DEPLOY_PROVIDER, "render");
  assert.equal(c.services.get("srv-acme-minio")!.serviceDetails.disk!.sizeGB, 20);
  assert.equal(c.database!.diskSizeGB, 20);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, root);
  assert.equal(
    c.calls.slice(mark).some((call) => call.path === "/services" && call.method === "POST"),
    false,
  );
});

test("Render external storage switch clears the MinIO endpoint and retains stored MinIO data", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.render!.storage = { type: "external" };
  Object.assign(d.ctx.config.env.core!, { S3_BUCKET: "external-data", S3_REGION: "us-east-1" });
  writeFileSync(
    join(d.ctx.configDir, ".env"),
    `${readFileSync(join(d.ctx.configDir, ".env"), "utf8")}\nAWS_ACCESS_KEY_ID=external-key\nAWS_SECRET_ACCESS_KEY=external-secret\n`,
  );
  await d.backend.up({ dryRun: false });
  const core = c.envs.get("srv-acme-core")!;
  assert.equal(core.AWS_ENDPOINT_URL_S3, "");
  assert.equal(core.AWS_ACCESS_KEY_ID, "external-key");
  assert.equal(core.AWS_SECRET_ACCESS_KEY, "external-secret");
  assert.equal(core.S3_FORCE_PATH_STYLE, "false");
  assert.equal(core.RENDER_QM_MINIO, "false");
  assert.ok(c.services.get("srv-acme-minio")!.serviceDetails.disk);
  assert.equal(c.services.size, 3);
  c.services.delete("srv-acme-minio");
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(d.saved().services.minio, undefined);
  assert.equal(c.services.size, 2);
  assert.equal(
    c.calls.slice(mark).some((call) => call.path === "/services" && call.method === "POST"),
    false,
  );
});

test("Render forgets a removed plugin after the operator deletes its service", async (t) => {
  const d = deployment(t, true);
  d.ctx.config.plugins.push({
    name: "reports",
    image: `example.com/plugin@sha256:${"a".repeat(64)}`,
    coreAccess: false,
  });
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.plugins = [];
  await d.backend.up({ dryRun: false });
  assert.ok(c.services.has("srv-acme-reports"));
  c.services.delete("srv-acme-reports");
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(d.saved().services.reports, undefined);
  assert.equal(
    c.calls.slice(mark).some((call) => call.path === "/services" && call.method === "POST"),
    false,
  );
});

test("Render stops before mutations when required storage is missing", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.services.delete("srv-acme-minio");
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 404/);
  assert.equal(d.saved().services.minio.id, "srv-acme-minio");
  assert.deepEqual(writes(c.calls.slice(mark)), []);
});
