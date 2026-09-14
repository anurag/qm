import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { hostingProvider, type DeployContext } from "../src/backends/registry.ts";
import { renderConfigErrors, renderDeploymentLayerTransport, renderInternalUrl } from "../src/backends/render.ts";
import { loadConfigAt } from "../src/config.ts";
import { renderScaffold } from "../src/provider-scaffold.ts";
import { computedSecrets } from "../src/secrets.ts";
import { renderMinioCommand } from "../src/render-minio.ts";

function deployment(t: TestContext, _external = false, portal = false) {
  const dir = mkdtempSync(join(tmpdir(), "qm-render-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${"a".repeat(40)}' "$4"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const raw = JSON.parse(renderScaffold.renderConfig("acme", "anthropic", "resend"));
  raw.render.workspaceId = "tea-acme";
  raw.services = portal ? ["core", "web-ui", "portal", "auth", "admin"] : ["core", "web-ui"];
  raw.env = {
    ...(portal ? { auth: { ...raw.env.auth, AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" } } : {}),
    core: { ...raw.env.core, HARNESS: "mock" },
  };
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
    deploys: new Map<string, { id: string; status: string; commit?: { id: string } }>(),
    projects: new Map<string, Project>(),
    database: undefined as Database | undefined,
    intercept: undefined as ((call: Call) => Response | undefined | Promise<Response | undefined>) | undefined,
    nextDeployStatus: "live",
    automaticDeployStatus: "build_in_progress",
    nextJobStatus: "succeeded",
    next: 0,
    workflow: undefined as
      { id: string; name: string; ownerId: string; region: string; environmentId?: string; slug: string } | undefined,
    workflowEnv: {} as Record<string, string>,
    workflowVersion: undefined as { id: string; status: string } | undefined,
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
    if (path === "/workflows") {
      if (method === "GET")
        return Response.json(state.workflow ? [{ workflow: state.workflow, cursor: state.workflow.id }] : []);
      assert.equal(body.buildConfig.runtime, "node");
      assert.equal(body.autoDeployTrigger, "off");
      state.workflow = { ...body, id: "wfl-acme", slug: "acme-worker" };
      state.workflowEnv = Object.fromEntries(
        body.envVars.map((pair: { key: string; value: string }) => [pair.key, pair.value]),
      );
      state.workflowVersion = undefined;
      return Response.json(state.workflow);
    }
    if (path === "/workflows/wfl-acme") {
      if (!state.workflow) return missing();
      if (method === "DELETE") {
        state.workflow = undefined;
        return empty();
      }
      return Response.json(state.workflow);
    }
    if (path === "/services/wfl-acme/env-vars") {
      state.workflowEnv = Object.fromEntries(
        body.map((pair: { key: string; value: string }) => [pair.key, pair.value]),
      );
      return empty();
    }
    if (path.startsWith("/services/wfl-acme/env-vars/")) {
      state.workflowEnv[path.split("/").at(-1)!] = body.value;
      return empty();
    }
    if (path === "/environments/evm-acme/resources") {
      assert.deepEqual(body.resourceIds, ["wfl-acme"]);
      state.workflow!.environmentId = "evm-acme";
      return empty();
    }
    if (path === "/tasks")
      return Response.json([
        {
          task: {
            id: `tsk-${state.workflowVersion!.id}`,
            name: "qm_run",
            workflowId: "wfl-acme",
            workflowVersionId: state.workflowVersion!.id,
          },
          cursor: "task",
        },
      ]);
    if (path === "/workflowversions") {
      if (method === "POST") {
        state.workflowVersion = { id: `wfv-${++state.next}`, status: "ready" };
        return empty();
      }
      return Response.json(state.workflowVersion ? [{ workflowVersion: state.workflowVersion }] : null);
    }

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
      return Response.json({
        internalConnectionString: "postgresql://qm:private-password@pg/qm",
        externalConnectionString:
          "postgresql://qm:private-password@pg.oregon-postgres.render.com:5432/qm?sslmode=require&application_name=qm#discard",
      });
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
        assert.match(body.serviceDetails.envSpecificDetails.dockerfilePath, /^(deploy|plugins)\/.+\/Dockerfile$/);
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
      const deploy = { id: `dep-${++state.next}`, status: state.automaticDeployStatus, commit: { id: "b".repeat(40) } };
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
      if (path === `/services/${id}/secret-files`) return empty();
      if (path.startsWith(`/services/${id}/env-vars/`)) {
        state.envs.get(id)![decodeURIComponent(path.split("/").at(-1)!)] = body.value;
        return empty();
      }
      if (path === `/services/${id}/rollback`) {
        const deploy = { id: `dep-${++state.next}`, status: "live", commit: { id: "a".repeat(40) } };
        state.deploys.set(id, deploy);
        return Response.json(deploy);
      }
      if (path === `/services/${id}/deploys`) {
        if (method === "GET") return Response.json([{ deploy: state.deploys.get(id) }]);
        const deploy = { id: `dep-${++state.next}`, status: state.nextDeployStatus, commit: { id: body.commitId } };
        state.deploys.set(id, deploy);
        return Response.json(deploy);
      }
      if (path.endsWith("/cancel") && path.includes("/deploys/")) {
        state.deploys.get(id)!.status = "canceled";
        return empty();
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
          state.deploys.set(id, {
            id: `dep-${++state.next}`,
            status: state.automaticDeployStatus,
            commit: { id: "b".repeat(40) },
          });
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

test("Render accepts null empty lists for projects, Postgres, services, and workflows", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  const resources = new Set(["/projects", "/postgres", "/services", "/workflows"]);
  const received = new Set<string>();
  c.intercept = ({ path, method }) => {
    if (method !== "GET" || !resources.has(path)) return undefined;
    received.add(path);
    return Response.json(null);
  };
  await d.backend.up({ dryRun: false });
  assert.deepEqual(received, resources);
  assert.equal(c.projects.size, 1);
  assert.ok(c.database);
  assert.equal(c.services.size, 3);
  assert.ok(c.workflow);
});

test("Render appRegion changes the app creation default without moving deployment resources", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const resources = { ...d.saved().services };
  d.ctx.config.render!.appRegion = "virginia";
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().services, resources);
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_APP_REGION, "virginia");
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_REGION, "oregon");
  assert.equal(c.workflowEnv.RENDER_APP_REGION, "virginia");
  assert.equal(c.workflow?.region, "oregon");
  assert.equal(c.database?.region, "oregon");
  for (const service of c.services.values()) assert.equal(service.serviceDetails.region, "oregon");
  d.ctx.config.env.core = { ...d.ctx.config.env.core, RENDER_APP_REGION: "ohio" };
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /RENDER_APP_REGION=virginia/.test(error.message)));
  delete d.ctx.config.env.core.RENDER_APP_REGION;
  d.ctx.config.secretEnv = { core: { RENDER_APP_REGION: "CUSTOM_APP_REGION" } };
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /RENDER_APP_REGION.*secretEnv/.test(error.message)));
});

for (const path of ["/projects", "/postgres", "/services", "/workflows"]) {
  test(`Render rejects a non-array ${path} list with a clear error`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    c.intercept = (call) =>
      call.path === path && call.method === "GET" ? Response.json({ unexpected: true }) : undefined;
    await assert.rejects(d.backend.up({ dryRun: false }), {
      message: `Render GET ${path} returned an invalid list response`,
    });
  });
}

test("Render creates the first pinned workflow version when automatic deployment is off", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  let emptyReads = 0;
  c.intercept = ({ path, method, body }) => {
    if (path === "/workflowversions" && method === "GET" && !c.workflowVersion) emptyReads++;
    if (path === "/workflowversions" && method === "POST") {
      assert.equal(c.workflowVersion, undefined);
      assert.deepEqual(body, { workflowId: "wfl-acme", commit: "a".repeat(40) });
    }
    return undefined;
  };
  await d.backend.up({ dryRun: false });
  assert.equal(emptyReads, 2);
  assert.equal(c.calls.filter((call) => call.path === "/workflowversions" && call.method === "POST").length, 1);
  assert.ok(d.saved().releaseWorkflowTaskId);
  assert.equal(d.saved().workflowBootstrap, undefined);
});

test("Render accepts a successful workflow attachment when GET omits its environment", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path !== "/workflows/wfl-acme" || method !== "GET") return undefined;
    const workflow = { ...c.workflow };
    delete workflow.environmentId;
    return Response.json(workflow);
  };
  await d.backend.up({ dryRun: false });
  await d.backend.up({ dryRun: false });
  assert.equal(c.workflow?.environmentId, "evm-acme");
  assert.equal(d.saved().workflowSlug, "acme-worker");
  assert.equal(
    c.calls.filter((call) => call.path === "/environments/evm-acme/resources" && call.method === "POST").length,
    2,
  );
  assert.equal(c.calls.filter((call) => call.path === "/workflows" && call.method === "POST").length, 1);
});

test("Render rejects a conflicting workflow environment after attachment", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) =>
    path === "/workflows/wfl-acme" && method === "GET"
      ? Response.json({ ...c.workflow, environmentId: "evm-other" })
      : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /The saved Render workflow does not match this deployment/);
  assert.equal(d.saved().release, undefined);
});
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
  assert.equal(core.RENDER_PROJECT_ID, "prj-acme");
  assert.equal(core.RENDER_POSTGRES_ID, "dpg-acme");
  assert.equal(
    core.RENDER_APP_DATABASE_ENDPOINT,
    "postgresql://pg.oregon-postgres.render.com:5432/?sslmode=verify-full",
  );
  assert.equal(core.RENDER_ENVIRONMENT_ID, "evm-acme");
  assert.equal(core.DATABASE_URL, "postgresql://qm:private-password@pg/qm");
  assert.equal(core.PUBLIC_API_URL, "https://acme-core-assigned.onrender.com");
  assert.equal(minio.MINIO_API_CORS_ALLOW_ORIGIN, "https://acme-web-ui-assigned.onrender.com");
  assert.equal(minio.MINIO_BROWSER, "off");
  assert.equal(
    c.services.get("srv-acme-minio")!.serviceDetails.envSpecificDetails.dockerfilePath,
    "deploy/render-minio/Dockerfile",
  );
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
  assert.ok(writes(c.calls.slice(first)).some((call) => call.path === "/services/srv-acme-core/deploys"));
  assert.ok(!writes(c.calls.slice(first)).some((call) => call.path === "/services/srv-acme-minio/deploys"));
  assert.equal(c.workflow?.environmentId, "evm-acme");
  assert.equal(core.RENDER_WORKFLOW_SLUG, "acme-worker");
  assert.equal(c.workflowEnv.AWS_SECRET_ACCESS_KEY, core.AWS_SECRET_ACCESS_KEY);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, minio.MINIO_ROOT_PASSWORD);
});

test("Render plan needs no API calls, Git repository, or state file", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: true });
  assert.equal(c.calls.length, 0);
  assert.equal(existsSync(join(d.ctx.configDir, "render.resources.json")), false);
});

for (const pid of [undefined, "invalid", "0"]) {
  test(`Render recovers an old lock with PID ${pid ?? "missing"}`, async (t) => {
    const d = deployment(t);
    const path = join(d.ctx.configDir, ".render.lock");
    mkdirSync(path);
    if (pid !== undefined) writeFileSync(join(path, "pid"), pid);
    const expired = new Date(Date.now() - 10_000);
    utimesSync(path, expired, expired);
    await assert.rejects(async () => d.backend.down({}), /No Render resource record exists/);
    assert.equal(existsSync(path), false);
  });
}

test("Render leaves a new lock without a PID intact", async (t) => {
  const d = deployment(t);
  const path = join(d.ctx.configDir, ".render.lock");
  mkdirSync(path);
  await assert.rejects(async () => d.backend.down({}), /Another Render operation holds/);
  assert.equal(existsSync(path), true);
});

test("Render keeps a lock when its owner cannot be probed", async (t) => {
  const d = deployment(t);
  const path = join(d.ctx.configDir, ".render.lock");
  mkdirSync(path);
  writeFileSync(join(path, "pid"), String(process.pid));
  t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
  });
  await assert.rejects(async () => d.backend.down({}), /Another Render operation holds/);
  assert.equal(readFileSync(join(path, "pid"), "utf8"), String(process.pid));
});

test("Render stale recovery preserves a replacement lock owner", async (t) => {
  const d = deployment(t);
  const path = join(d.ctx.configDir, ".render.lock");
  mkdirSync(path);
  const stalePid = process.pid + 1;
  writeFileSync(join(path, "pid"), String(stalePid));
  const replacement = `owner-${randomUUID()}`;
  const kill = process.kill;
  t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => {
    if (pid !== stalePid) return kill(pid, signal);
    rmSync(path, { recursive: true });
    mkdirSync(path);
    writeFileSync(join(path, replacement), String(process.pid));
    throw Object.assign(new Error("No such process"), { code: "ESRCH" });
  });
  await assert.rejects(async () => d.backend.down({}), /Another Render operation holds/);
  assert.deepEqual(readdirSync(path), [replacement]);
  assert.equal(readFileSync(join(path, replacement), "utf8"), String(process.pid));
});

test("Render protects a live owner and recovers its lock after SIGKILL", { timeout: 10_000 }, async (t) => {
  const d = deployment(t);
  const path = join(d.ctx.configDir, ".render.lock");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createRenderBackend } from ${JSON.stringify(new URL("../src/backends/render.ts", import.meta.url).href)};
process.on("message", () => {});
globalThis.fetch = async () => {
  process.send("locked");
  return new Promise(() => {});
};
await createRenderBackend(${JSON.stringify(d.ctx)}).up({ dryRun: false });`,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const [message] = await Promise.race([
    once(child, "message"),
    exited.then(() => {
      throw new Error(`Render lock owner exited before the API call: ${stderr}`);
    }),
  ]);
  assert.equal(message, "locked");
  const owner = readdirSync(path)[0]!;
  assert.match(owner, /^owner-/);
  assert.equal(readFileSync(join(path, owner), "utf8"), String(child.pid));
  const expired = new Date(Date.now() - 10_000);
  utimesSync(path, expired, expired);
  await assert.rejects(async () => d.backend.down({}), /Another Render operation holds/);
  assert.equal(readFileSync(join(path, owner), "utf8"), String(child.pid));
  child.kill("SIGKILL");
  await exited;
  await assert.rejects(async () => d.backend.down({}), /No Render resource record exists/);
  assert.equal(existsSync(path), false);
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

test("Render builds QM services and MinIO from Git", async (t) => {
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
  assert.equal(
    c.services.get("srv-acme-minio")!.serviceDetails.envSpecificDetails.dockerfilePath,
    "deploy/render-minio/Dockerfile",
  );
  assert.equal(c.services.get("srv-acme-minio")!.serviceDetails.runtime, "docker");
  assert.equal(c.services.get("srv-acme-minio")!.repo, "https://github.com/acme/qm");
  assert.equal(
    c.services.get("srv-acme-portal")!.serviceDetails.envSpecificDetails.dockerfilePath,
    "deploy/portal/Dockerfile",
  );
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_IMAGE, undefined);
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_REPO, "https://github.com/acme/qm");
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_BRANCH, "render-test");
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().services, saved.services);
  const changes = writes(c.calls.slice(mark));
  assert.ok(changes.some((call) => call.path === "/workflowversions" && call.method === "POST"));
  assert.ok(!changes.some((call) => call.path === "/services/srv-acme-minio/deploys"));
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
  assert.equal(c.services.size, 3);
  assert.equal(c.calls.filter((call) => call.path === "/services" && call.method === "POST").length, 3);
});

test("Render updates a changed plan and recovers a failed deployment without new resources", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.render!.corePlan = "2c-4g";
  c.nextDeployStatus = "update_failed";
  await assert.rejects(d.backend.up({ dryRun: false }), /update_failed/);
  assert.ok(d.saved().dirtyServices.includes("core"));
  assert.equal(c.services.get("srv-acme-core")!.serviceDetails.plan, "2c-4g");
  const mark = c.calls.length;
  c.nextDeployStatus = "live";
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().dirtyServices, []);
  assert.ok(
    c.calls.slice(mark).some((call) => call.path === "/services/srv-acme-core/deploys" && call.method === "POST"),
  );
  assert.equal(c.calls.filter((call) => call.path === "/services" && call.method === "POST").length, 3);
});

test("Render retries after env write failure after a preceding service update succeeds", async (t) => {
  const d = deployment(t, true);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.render!.corePlan = "2c-4g";
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
        const deploy =
          ++listReads === 1
            ? previous
            : { id: "dep-queued", status: listReads === 2 ? "queued" : status, commit: { id: "a".repeat(40) } };
        return Response.json([{ deploy }]);
      }
      if (path === "/services/srv-acme-core/deploys/dep-queued")
        return Response.json({ id: "dep-queued", status, commit: { id: "a".repeat(40) } });
      return undefined;
    };
    d.ctx.config.render!.corePlan = "2c-4g";
    if (status === "live") {
      await d.backend.up({ dryRun: false });
      assert.deepEqual(d.saved().dirtyServices, []);
    } else {
      await assert.rejects(d.backend.up({ dryRun: false }), /dep-queued ended with update_failed/);
      assert.ok(d.saved().dirtyServices.includes("core"));
    }
    assert.equal(listReads, status === "live" ? 3 : 2);
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
    d.ctx.config.render!.corePlan = "2c-4g";
    await d.backend.up({ dryRun: false });
    assert.equal(triggered, true);
    assert.deepEqual(d.saved().dirtyServices, []);
  });
}

for (const failure of ["connection closed", "HTTP 503"]) {
  for (const path of ["/projects", "/postgres", "/services", "/workflows"]) {
    test(`Render retries ${path} after ${failure} before creation`, async (t) => {
      const d = deployment(t);
      const c = cloud(t, d);
      c.intercept = (call) => {
        if (call.path !== path || call.method !== "POST") return undefined;
        if (failure === "connection closed") throw new TypeError(failure);
        return new Response(null, { status: 503 });
      };
      await assert.rejects(d.backend.up({ dryRun: false }), new RegExp(failure));
      assert.ok(d.saved().pendingCreate.startsWith(`${path}: `));
      c.intercept =
        path === "/workflows"
          ? (call) => (call.path === path && call.method === "GET" ? Response.json(null) : undefined)
          : undefined;
      const backend = hostingProvider("render").createBackend(d.ctx);
      await backend.up({ dryRun: false });
      assert.equal(d.saved().pendingCreate, undefined);
      assert.equal(c.projects.size, 1);
      assert.equal(c.services.size, 3);
      assert.ok(c.database);
      assert.ok(c.workflow);
      await backend.down({ purge: true });
      assert.equal(c.services.size, 0);
      assert.equal(c.database, undefined);
      assert.equal(c.workflow, undefined);
    });
  }

  test(`Render permits cleanup after ${failure} before creation`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    c.intercept = ({ path, method }) => {
      if (path !== "/services" || method !== "POST") return undefined;
      if (failure === "connection closed") throw new TypeError(failure);
      return new Response(null, { status: 503 });
    };
    await assert.rejects(d.backend.up({ dryRun: false }), new RegExp(failure));
    c.intercept = undefined;
    await hostingProvider("render").createBackend(d.ctx).down({ purge: true });
    assert.equal(d.saved().pendingCreate, undefined);
    assert.equal(d.saved().bootstrapServices, undefined);
    assert.equal(c.services.size, 0);
    assert.equal(c.database, undefined);
    writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${"b".repeat(40)}' "$4"\n`);
    await hostingProvider("render").createBackend(d.ctx).up({ dryRun: false });
    assert.equal(d.saved().releaseCommit, "b".repeat(40));
  });
}

test("Render retains the creation request when its recovery lookup fails", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path === "/projects" && method === "POST") throw new TypeError("connection closed");
    return undefined;
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /connection closed/);
  c.intercept = ({ path, method }) =>
    path === "/projects" && method === "GET" ? new Response(null, { status: 503 }) : undefined;
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 503/);
  assert.equal(d.saved().pendingCreate, "/projects: acme-qm");
  assert.deepEqual(writes(c.calls.slice(mark)), []);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(d.saved().pendingCreate, undefined);
});

test("Render retains the creation request when its recovery lookup returns an empty body", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path === "/projects" && method === "POST") throw new TypeError("connection closed");
    return undefined;
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /connection closed/);
  c.intercept = ({ path, method }) =>
    path === "/projects" && method === "GET" ? new Response(null, { status: 200 }) : undefined;
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /invalid list response/);
  await assert.rejects(async () => d.backend.down({ purge: true }), /invalid list response/);
  assert.equal(d.saved().pendingCreate, "/projects: acme-qm");
  assert.deepEqual(writes(c.calls.slice(mark)), []);
});

test("Render refuses to adopt a resource after its accepted creation response is lost", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path !== "/projects" || method !== "POST") return undefined;
    c.projects.set("prj-acme", {
      id: "prj-acme",
      name: "acme-qm",
      owner: { id: "tea-acme" },
      environmentIds: ["evm-acme"],
    });
    throw new TypeError("connection closed");
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /connection closed/);
  c.intercept = undefined;
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /Refusing to adopt/);
  await assert.rejects(async () => d.backend.down({ purge: true }), /Refusing to adopt/);
  assert.equal(d.saved().pendingCreate, "/projects: acme-qm");
  assert.equal(c.projects.size, 1);
  assert.deepEqual(writes(c.calls.slice(mark)), []);
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
    true,
  );
});

for (const [name, externalConnectionString] of [
  ["missing", undefined],
  ["malformed", "private-password"],
  ["wrong protocol", "https://qm:private-password@pg.oregon-postgres.render.com/qm"],
] as const)
  test(`Render rejects ${name} external database connection details before service creation`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    c.intercept = (call) =>
      call.path === "/postgres/dpg-acme/connection-info"
        ? Response.json({
            internalConnectionString: "postgresql://qm:private-password@pg/qm",
            externalConnectionString,
          })
        : undefined;
    await assert.rejects(d.backend.up({ dryRun: false }), (error: Error) => {
      assert.match(error.message, /no valid external Postgres connection string/);
      assert.doesNotMatch(error.message, /private-password/);
      return true;
    });
    assert.equal(c.services.size, 0);
    assert.equal(
      writes(c.calls).some((call) => call.path === "/postgres/dpg-acme" && call.method === "PATCH"),
      false,
    );
  });

test("Render shutdown ignores app services outside the saved project", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const app = {
    ...c.services.get("srv-acme-web-ui")!,
    id: "srv-other-project-app",
    name: "qm-app-other",
    type: "private_service",
    environmentId: "evm-other-project",
  };
  c.services.set(app.id, app);
  c.envs.set(app.id, { QM_DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000002" });
  const mark = c.calls.length;
  await d.backend.down({});
  assert.equal(app.suspended, "not_suspended");
  assert.ok(c.calls.slice(mark).every((call) => !call.path.startsWith(`/services/${app.id}`)));
});

for (const serviceType of ["web_service", "private_service"])
  test(`Render protects published ${serviceType} apps in owner environments before shutdown or purge`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    await d.backend.up({ dryRun: false });
    const app = {
      ...c.services.get("srv-acme-web-ui")!,
      id: "srv-published-app",
      name: "qm-app-a1",
      environmentId: "evm-owner",
      type: serviceType,
    };
    c.projects.get("prj-acme")!.environmentIds.push("evm-owner");
    c.services.set(app.id, app);
    c.envs.set(app.id, { QM_DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000001" });
    for (const environmentId of ["evm-acme", "evm-owner"]) {
      app.environmentId = environmentId;
      for (const purge of [false, true]) {
        const mark = c.calls.length;
        await assert.rejects(async () => d.backend.down({ purge }), /Published apps still use this deployment/);
        assert.deepEqual(writes(c.calls.slice(mark)), []);
        assert.equal(d.saved().pendingPurge, undefined);
      }
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

test("Render secret push targets consumers and keeps managed MinIO credentials", async (t) => {
  const d = deployment(t, true);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.envs.get("srv-acme-core")!.AWS_SESSION_TOKEN = "old-session";
  writeFileSync(
    join(d.ctx.configDir, ".env"),
    `${readFileSync(join(d.ctx.configDir, ".env"), "utf8")}\nAWS_SESSION_TOKEN=\n`,
  );
  await d.backend.secretsPush();
  assert.equal(c.envs.get("srv-acme-core")!.AWS_SESSION_TOKEN, "old-session");
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
    c.calls.some((call) => call.path.includes("/jobs/") && call.path.endsWith("/cancel")),
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
  assert.equal(
    c.calls.filter((call) => call.path.includes("/jobs/") && call.path.endsWith("/cancel") && call.method === "POST")
      .length,
    1,
  );
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
  assert.equal(
    c.calls.filter((call) => call.path.includes("/jobs/") && call.path.endsWith("/cancel") && call.method === "POST")
      .length,
    1,
  );
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

test("Render rollback restores the previous service builds without changing stored data", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const release = d.saved().release;
  const workflowTaskId = d.saved().releaseWorkflowTaskId;
  await d.backend.up({ dryRun: false });
  const mark = c.calls.length;
  const secret = c.envs.get("srv-acme-minio")!.QM_STORAGE_SECRET_KEY;
  await d.backend.rollback();
  assert.deepEqual(
    writes(c.calls.slice(mark))
      .filter((call) => call.path.endsWith("/rollback"))
      .map((call) => [call.path, call.body]),
    [
      ["/services/srv-acme-core/rollback", { deployId: release.core }],
      ["/services/srv-acme-web-ui/rollback", { deployId: release["web-ui"] }],
    ],
  );
  assert.equal(c.envs.get("srv-acme-minio")!.QM_STORAGE_SECRET_KEY, secret);
  assert.equal(c.database?.id, "dpg-acme");
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_WORKFLOW_TASK_ID, workflowTaskId);
  assert.equal(c.workflowEnv.RENDER_DEPLOY_COMMIT, d.saved().releaseCommit);
  assert.equal(c.workflowEnv.GIT_SHA, d.saved().releaseCommit);
});

test("Render rejects a live service built from a different source commit", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path !== "/services/srv-acme-core/deploys" || method !== "POST") return undefined;
    const deploy = { id: "dep-wrong", status: "live", commit: { id: "b".repeat(40) } };
    c.deploys.set("srv-acme-core", deploy);
    return Response.json(deploy);
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /deployed commit b+.*expected a+/);
  assert.equal(d.saved().release, undefined);
  assert.equal(d.saved().updateInProgress, true);
});

test("Render rejects a workflow task from a different version", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path }) =>
    path === "/tasks"
      ? Response.json([
          {
            task: { id: "tsk-foreign", name: "qm_run", workflowId: "wfl-acme", workflowVersionId: "wfv-other" },
            cursor: "task",
          },
        ])
      : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /must register one qm_run task/);
  assert.equal(d.saved().release, undefined);
});

test("Render resumes rollback to the last good release after a partial update", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const successful = d.saved();
  c.intercept = ({ path, method }) =>
    path === "/services/srv-acme-web-ui/deploys" && method === "POST" ? new Response(null, { status: 500 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  assert.equal(d.saved().updateInProgress, true);
  assert.equal(d.saved().previousRelease, undefined);
  c.intercept = ({ path, method }) =>
    path === "/services/srv-acme-web-ui/rollback" && method === "POST"
      ? new Response(null, { status: 500 })
      : undefined;
  await assert.rejects(async () => d.backend.rollback(), /HTTP 500/);
  assert.ok(d.saved().rollbackProgress.restored.core);
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_WORKFLOW_TASK_ID, successful.releaseWorkflowTaskId);
  const mark = c.calls.length;
  c.intercept = undefined;
  await d.backend.rollback();
  assert.deepEqual(
    writes(c.calls.slice(mark))
      .filter((call) => call.path.endsWith("/rollback"))
      .map((call) => [call.path, call.body]),
    [["/services/srv-acme-web-ui/rollback", { deployId: successful.release["web-ui"] }]],
  );
  assert.equal(d.saved().rollbackProgress, undefined);
  assert.equal(d.saved().updateInProgress, undefined);
  assert.equal(d.saved().releaseWorkflowTaskId, successful.releaseWorkflowTaskId);
});

test("Render creates services and the workflow without credentials and drains automatic builds before pinning", async (t) => {
  const d = deployment(t);
  mkdirSync(join(d.ctx.configDir, "plugins", "reports"), { recursive: true });
  writeFileSync(join(d.ctx.configDir, "plugins", "reports", "Dockerfile"), "FROM node:24\n");
  const c = cloud(t, d);
  const canceled = new Set<string>();
  c.intercept = ({ path, method, body }) => {
    if (method === "POST" && path === "/services") {
      const create = body as {
        envVars: unknown[];
        secretFiles: unknown[];
        serviceDetails: { envSpecificDetails: { dockerCommand: string } };
      };
      assert.deepEqual(create.envVars, []);
      assert.deepEqual(create.secretFiles, []);
      assert.equal(create.serviceDetails.envSpecificDetails.dockerCommand, "/bin/sh -c exit 0");
    }
    if (method === "POST" && path === "/workflows") {
      assert.deepEqual((body as { envVars: unknown[] }).envVars, [{ key: "NODE_VERSION", value: "24.18.0" }]);
      assert.equal((body as { runCommand: string }).runCommand, "/bin/sh -c exit 0");
    }
    const serviceId = path.split("/")[2]!;
    if (path.includes("/deploys/") && path.endsWith("/cancel")) {
      canceled.add(serviceId);
      assert.deepEqual(c.envs.get(serviceId), {});
      assert.equal(c.deploys.get(serviceId)!.commit?.id, "b".repeat(40));
    }
    if (method === "PUT" && path.endsWith("/env-vars") && serviceId !== "wfl-acme") assert.ok(canceled.has(serviceId));
    if (method === "POST" && path.endsWith("/deploys")) {
      assert.ok(canceled.has(serviceId));
      assert.equal((body as { commitId: string }).commitId, "a".repeat(40));
      assert.notEqual(c.services.get(serviceId)!.serviceDetails.envSpecificDetails.dockerCommand, "/bin/sh -c exit 0");
    }
    return undefined;
  };
  await d.backend.up({ dryRun: false });
  assert.equal(c.services.size, 4);
  assert.equal(canceled.size, 4);
  assert.deepEqual(d.saved().bootstrapServices, {});
  assert.equal(d.saved().workflowBootstrap, undefined);
});

test("Render resumes safely and preserves encrypted credentials across an interrupted bootstrap", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const storage = { ...c.envs.get("srv-acme-minio")! };
  await d.backend.down({});
  let interrupted = false;
  c.intercept = ({ path, method }) => {
    if (path === "/services/srv-acme-minio/resume" && method === "POST") {
      assert.deepEqual(c.envs.get("srv-acme-minio"), {});
      assert.equal(
        c.services.get("srv-acme-minio")!.serviceDetails.envSpecificDetails.dockerCommand,
        "/bin/sh -c exit 0",
      );
    }
    if (path.startsWith("/services/srv-acme-minio/deploys/") && path.endsWith("/cancel") && !interrupted) {
      interrupted = true;
      return new Response(null, { status: 500 });
    }
    return undefined;
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  const recorded = readFileSync(join(d.ctx.configDir, "render.resources.json"), "utf8");
  assert.ok(d.saved().bootstrapServices.minio.env);
  for (const value of [storage.MINIO_ROOT_PASSWORD!, storage.QM_STORAGE_SECRET_KEY!, "e".repeat(64)])
    assert.ok(!recorded.includes(value));
  const mark = c.calls.length;
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.calls.slice(mark).filter((call) => call.path === "/services/srv-acme-minio/resume").length, 0);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, storage.MINIO_ROOT_PASSWORD);
  assert.equal(c.envs.get("srv-acme-minio")!.QM_STORAGE_SECRET_KEY, storage.QM_STORAGE_SECRET_KEY);
  assert.deepEqual(d.saved().bootstrapServices, {});
});

test("Render stops before API calls when the bootstrap encryption key changes", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path }) =>
    path.includes("/deploys/") && path.endsWith("/cancel") ? new Response(null, { status: 500 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  const envPath = join(d.ctx.configDir, ".env");
  writeFileSync(
    envPath,
    readFileSync(envPath, "utf8").replace(/^CORE_SIGNING_SECRET=.*$/m, `CORE_SIGNING_SECRET=${"f".repeat(64)}`),
  );
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /restore the CORE_SIGNING_SECRET used when bootstrap started/);
  assert.equal(c.calls.length, mark);
});

test("Render keeps the initial source commit when an interrupted bootstrap resumes after the branch moves", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path }) =>
    path.includes("/deploys/") && path.endsWith("/cancel") ? new Response(null, { status: 500 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${"c".repeat(40)}' "$4"\n`);
  c.intercept = undefined;
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  const pinned = c.calls.slice(mark).filter((call) => call.method === "POST" && call.path.endsWith("/deploys"));
  assert.equal(pinned.length, 3);
  for (const call of pinned) assert.equal((call.body as { commitId: string }).commitId, "a".repeat(40));
  assert.equal(d.saved().releaseCommit, "a".repeat(40));
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_COMMIT, "a".repeat(40));
});

for (const resource of ["retained", "deleted", "not created"]) {
  test(`Render ignores a retired plugin bootstrap when its service is ${resource}`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    await d.backend.up({ dryRun: false });
    const pluginDir = join(d.ctx.configDir, "plugins", "reports");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "Dockerfile"), "FROM node:24\n");
    c.intercept = ({ path, method, body }) => {
      if (resource === "not created")
        return path === "/services" && method === "POST" && (body as { name: string }).name === "acme-reports"
          ? new Response(null, { status: 503 })
          : undefined;
      return path.startsWith("/services/srv-acme-reports/deploys/") && path.endsWith("/cancel")
        ? new Response(null, { status: 503 })
        : undefined;
    };
    await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 503/);
    const bootstrap = d.saved().bootstrapServices.reports;
    assert.equal(bootstrap.commit, "a".repeat(40));
    assert.equal(bootstrap.drained, undefined);
    delete bootstrap.commit;
    if (resource === "deleted") {
      c.services.delete("srv-acme-reports");
      c.envs.delete("srv-acme-reports");
      c.deploys.delete("srv-acme-reports");
    }
    rmSync(pluginDir, { recursive: true });
    c.intercept = undefined;
    for (const commit of ["c".repeat(40), "d".repeat(40)]) {
      writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${commit}' "$4"\n`);
      const mark = c.calls.length;
      await hostingProvider("render").createBackend(d.ctx).up({ dryRun: false });
      const calls = c.calls.slice(mark);
      const deploys = calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys"));
      assert.deepEqual(
        deploys.map((call) => (call.body as { commitId: string }).commitId),
        [commit, commit],
      );
      const versions = calls.filter((call) => call.method === "POST" && call.path === "/workflowversions");
      assert.deepEqual(
        versions.map((call) => (call.body as { commit: string }).commit),
        [commit],
      );
      assert.equal(d.saved().releaseCommit, commit);
      assert.equal(d.saved().pendingCreate, undefined);
      assert.equal(Boolean(d.saved().services.reports), resource === "retained");
      assert.deepEqual(d.saved().bootstrapServices.reports, resource === "retained" ? bootstrap : undefined);
      assert.equal(
        calls.some((call) => call.method !== "GET" && call.path.includes("srv-acme-reports")),
        false,
      );
    }
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "Dockerfile"), "FROM node:24\n");
    const commit = "e".repeat(40);
    writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${commit}' "$4"\n`);
    const mark = c.calls.length;
    c.intercept = ({ method }) => {
      if (method !== "GET" && resource === "retained") assert.equal(d.saved().bootstrapServices.reports.commit, commit);
      return undefined;
    };
    await d.backend.up({ dryRun: false });
    const calls = c.calls.slice(mark);
    assert.equal(d.saved().bootstrapServices.reports, undefined);
    assert.equal(d.saved().releaseCommit, commit);
    const deploys = calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys"));
    assert.deepEqual(
      deploys.map((call) => (call.body as { commitId: string }).commitId),
      [commit, commit, commit],
    );
    const versions = calls.filter((call) => call.method === "POST" && call.path === "/workflowversions");
    assert.deepEqual(
      versions.map((call) => (call.body as { commit: string }).commit),
      [commit],
    );
    assert.equal(
      calls.filter((call) => call.method === "POST" && call.path === "/services").length,
      resource === "retained" ? 0 : 1,
    );
    assert.equal(c.deploys.get("srv-acme-reports")!.status, "live");
  });
}

test("Render joins a re-added plugin to a newer interrupted bootstrap", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const reportsDir = join(d.ctx.configDir, "plugins", "reports");
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, "Dockerfile"), "FROM node:24\n");
  c.intercept = ({ path }) => (path.endsWith("/cancel") ? new Response(null, { status: 503 }) : undefined);
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 503/);
  const reportsEnv = d.saved().bootstrapServices.reports.env;
  rmSync(reportsDir, { recursive: true });
  const analyticsDir = join(d.ctx.configDir, "plugins", "analytics");
  mkdirSync(analyticsDir, { recursive: true });
  writeFileSync(join(analyticsDir, "Dockerfile"), "FROM node:24\n");
  const commit = "b".repeat(40);
  writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${commit}' "$4"\n`);
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 503/);
  assert.equal(d.saved().bootstrapServices.reports.commit, undefined);
  assert.equal(d.saved().bootstrapServices.analytics.commit, commit);
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, "Dockerfile"), "FROM node:24\n");
  writeFileSync(join(d.ctx.configDir, "bin", "git"), `#!/bin/sh\nprintf '%s\t%s\n' '${"e".repeat(40)}' "$4"\n`);
  c.intercept = ({ method }) => {
    if (method !== "GET" && d.saved().bootstrapServices.reports) {
      assert.equal(d.saved().bootstrapServices.reports.commit, commit);
      assert.equal(d.saved().bootstrapServices.reports.env, reportsEnv);
    }
    return undefined;
  };
  const mark = c.calls.length;
  await hostingProvider("render").createBackend(d.ctx).up({ dryRun: false });
  const calls = c.calls.slice(mark);
  const deploys = calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys"));
  assert.deepEqual(
    deploys.map((call) => (call.body as { commitId: string }).commitId),
    [commit, commit, commit, commit],
  );
  const versions = calls.filter((call) => call.method === "POST" && call.path === "/workflowversions");
  assert.deepEqual(
    versions.map((call) => (call.body as { commit: string }).commit),
    [commit],
  );
  assert.equal(
    calls.some((call) => call.method === "POST" && call.path === "/services"),
    false,
  );
  assert.deepEqual(d.saved().bootstrapServices, {});
  assert.equal(d.saved().releaseCommit, commit);
});

test("Render retries a rejected resume without losing retained storage credentials", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const password = c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD;
  await d.backend.down({});
  c.intercept = ({ path }) =>
    path === "/services/srv-acme-minio/resume" ? new Response(null, { status: 429 }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 429/);
  assert.equal(d.saved().bootstrapServices.minio.requested, undefined);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, password);
  assert.deepEqual(d.saved().bootstrapServices, {});
});

for (const failure of ["connection closed", "HTTP 503"]) {
  test(`Render retries ${failure} before resume and retains storage credentials`, async (t) => {
    const d = deployment(t);
    const c = cloud(t, d);
    await d.backend.up({ dryRun: false });
    const storage = { ...c.envs.get("srv-acme-minio")! };
    await d.backend.down({});
    c.intercept = ({ path, method }) => {
      if (path !== "/services/srv-acme-minio/resume" || method !== "POST") return undefined;
      if (failure === "connection closed") throw new TypeError(failure);
      return new Response(null, { status: 503 });
    };
    await assert.rejects(d.backend.up({ dryRun: false }), new RegExp(failure));
    assert.equal(d.saved().bootstrapServices.minio.requested, true);
    assert.equal(c.services.get("srv-acme-minio")!.suspended, "suspended");
    c.intercept = undefined;
    const backend = hostingProvider("render").createBackend(d.ctx);
    await backend.up({ dryRun: false });
    assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, storage.MINIO_ROOT_PASSWORD);
    assert.equal(c.envs.get("srv-acme-minio")!.QM_STORAGE_SECRET_KEY, storage.QM_STORAGE_SECRET_KEY);
    assert.deepEqual(d.saved().bootstrapServices, {});
    assert.equal(c.calls.filter((call) => call.path === "/services/srv-acme-minio/resume").length, 2);
    await backend.down({ purge: true });
    assert.equal(c.services.size, 0);
    assert.equal(c.database, undefined);
  });
}

test("Render waits for the initial workflow registration to fail before adding credentials", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  let reads = 0;
  c.intercept = ({ path, method }) => {
    if (path === "/workflowversions" && method === "GET" && reads < 2) {
      assert.deepEqual(c.workflowEnv, { NODE_VERSION: "24.18.0" });
      const status = ++reads === 1 ? "registration_in_progress" : "registration_failed";
      return Response.json([{ workflowVersion: { id: "wfv-bootstrap", status } }]);
    }
    if (path === "/services/wfl-acme/env-vars") assert.equal(reads, 2);
    return undefined;
  };
  await d.backend.up({ dryRun: false });
  assert.equal(reads, 2);
  assert.equal(c.workflowEnv.CORE_SIGNING_SECRET, "e".repeat(64));
  assert.equal(d.saved().workflowBootstrap, undefined);
});
