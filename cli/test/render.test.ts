import assert from "node:assert/strict";

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { test, type TestContext } from "node:test";

import { type DeployContext } from "../src/backends/registry.ts";

import { createRenderBackend, renderConfigErrors, renderDeploymentLayerTransport } from "../src/backends/render.ts";

import { loadConfigAt, parseConfigJson } from "../src/config.ts";

import { renderScaffold } from "../src/provider-scaffold.ts";

import { computedSecrets } from "../src/secrets.ts";

import { renderInternalUrl } from "../src/render-domains.ts";

import { renderMinioCommand } from "../src/render-minio.ts";

import { renderClient } from "../src/render-api.ts";

function deployment(t: TestContext, portal = false) {
  const dir = mkdtempSync(join(tmpdir(), "qm-render-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncommit=$(cat '${join(dir, "commit")}' 2>/dev/null || printf '%s' '${"a".repeat(40)}')\nprintf '%s\t%s\n' "$commit" "$4"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const raw = parseConfigJson(
    renderScaffold.renderConfig("acme", "anthropic", "resend", { repo: "https://github.com/acme/qm", branch: "main" }),
  ) as Record<string, any>;
  raw.render.workspaceId = "tea-acme";
  raw.services = portal ? ["core", "web-ui", "portal", "auth", "admin"] : ["core", "web-ui"];
  raw.env = {
    ...(portal ? { auth: { ...raw.env.auth, AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" } } : {}),
    core: { ...raw.env.core, HARNESS: "pi" },
  };
  delete raw.modelProvider;
  delete raw.secretEnv;
  const configPath = join(dir, "qm.config.jsonc");
  writeFileSync(configPath, JSON.stringify(raw));
  writeFileSync(configPath, JSON.stringify({ ...raw, target: "docker", sandbox: undefined }));
  const config = loadConfigAt(configPath).config;
  Object.assign(config, { target: "render", sandbox: { backend: "render" } });
  writeFileSync(configPath, JSON.stringify(raw));
  writeFileSync(
    join(dir, ".env"),
    computedSecrets(config)
      .filter((secret) => secret.managedBy === "operator" && secret.required)
      .map((secret) => `${secret.name}=${"e".repeat(64)}`)
      .join("\n"),
  );
  const ctx: DeployContext = {
    config,
    configPath,
    configDir: dir,
    sandboxDir: join(dir, "sandbox"),
    target: config.target,
  };
  return {
    ctx,
    backend: createRenderBackend(ctx),
    saved: () => JSON.parse(readFileSync(join(dir, "render.resources.json"), "utf8")),
    setCommit: (commit: string) => writeFileSync(join(dir, "commit"), commit),
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
    url?: string;
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

interface CustomDomainRecord {
  id: string;
  name: string;
  domainType: "apex" | "subdomain";
  publicSuffix: string;
  verificationStatus: "verified" | "unverified";
  redirectForName: string;
  createdAt: string;
  server: { id: string; name: string };
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
    runtimeEnvs: new Map<string, Record<string, string>>(),
    deployEnvs: new Map<string, Record<string, string>>(),
    deploys: new Map<string, { id: string; status: string; commit?: { id: string } }>(),
    deploysById: new Map<string, { id: string; serviceId?: string; status: string; commit?: { id: string } }>(),
    projects: new Map<string, Project>(),
    customDomains: new Map<string, CustomDomainRecord[]>(),
    database: undefined as Database | undefined,
    intercept: undefined as ((call: Call) => Response | undefined | Promise<Response | undefined>) | undefined,
    nextDeployStatus: "live",
    automaticDeployStatus: "build_in_progress",
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
        assert.ok([state.services.get("srv-acme-core")!.serviceDetails.url, d.ctx.config.apiUrl].includes(url.origin));
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
      assert.deepEqual(d.saved().pendingCreate, { collection: "projects", name: "acme-qm" });
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
      const deploy = {
        id: `dep-${++state.next}`,
        serviceId: id,
        status: state.automaticDeployStatus,
        commit: { id: "b".repeat(40) },
      };
      state.deploys.set(id, deploy);
      state.deploysById.set(deploy.id, deploy);
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
      if (path === `/services/${id}/custom-domains`) {
        const domains = state.customDomains.get(id) ?? [];
        if (method === "GET")
          return Response.json(domains.map((customDomain) => ({ customDomain, cursor: customDomain.id })));
        const record = (name: string, redirectForName: string): CustomDomainRecord => ({
          id: `cd-${++state.next}`,
          name,
          domainType: name.split(".").length > 2 ? "subdomain" : "apex",
          publicSuffix: name.split(".").at(-1)!,
          verificationStatus: "unverified",
          redirectForName,
          createdAt: "2026-09-21T00:00:00Z",
          server: { id, name: service.name },
        });
        const domain = record(body.name, "");
        const created = domain.domainType === "apex" ? [domain, record(`www.${domain.name}`, domain.name)] : [domain];
        state.customDomains.set(id, [...domains, ...created]);
        return Response.json(created, { status: 201 });
      }
      if (path.startsWith(`/services/${id}/custom-domains/`)) {
        const key = decodeURIComponent(path.split("/")[4]!);
        const domain = (state.customDomains.get(id) ?? []).find((item) => item.id === key || item.name === key);
        if (!domain) return missing();
        if (path.endsWith("/verify")) return new Response("Custom domain verification triggered", { status: 202 });
        return Response.json(domain);
      }
      if (path.startsWith(`/services/${id}/env-vars/`)) {
        state.envs.get(id)![decodeURIComponent(path.split("/").at(-1)!)] = body.value;
        return empty();
      }
      if (path === `/services/${id}/rollback`) {
        const source = state.deploysById.get(body.deployId);
        if (!source) return missing();
        const deploy = { id: `dep-${++state.next}`, serviceId: id, status: "live", commit: source.commit };
        state.deploys.set(id, deploy);
        state.deploysById.set(deploy.id, deploy);
        const environment = { ...state.deployEnvs.get(source.id) };
        state.deployEnvs.set(deploy.id, environment);
        state.runtimeEnvs.set(id, environment);
        return Response.json(deploy);
      }
      if (path === `/services/${id}/deploys`) {
        if (method === "GET") {
          const latest = state.deploys.get(id);
          const history = [...state.deploysById.values()]
            .reverse()
            .filter((deploy) => deploy.serviceId === id && deploy.id !== latest?.id);
          return Response.json(
            [...(latest ? [latest] : []), ...history]
              .filter(
                (deploy) =>
                  !url.searchParams.has("status") || url.searchParams.getAll("status").includes(deploy.status),
              )
              .slice(0, Number(url.searchParams.get("limit") ?? 100))
              .map((deploy) => ({ deploy })),
          );
        }
        const deploy = {
          id: `dep-${++state.next}`,
          serviceId: id,
          status: state.nextDeployStatus,
          commit: { id: body.commitId },
        };
        state.deploys.set(id, deploy);
        state.deploysById.set(deploy.id, deploy);
        const environment = { ...state.envs.get(id) };
        state.deployEnvs.set(deploy.id, environment);
        state.runtimeEnvs.set(id, environment);
        return Response.json(deploy);
      }
      if (path.endsWith("/cancel") && path.includes("/deploys/")) {
        const deploy = state.deploysById.get(path.split("/").at(-2)!);
        if (!deploy) return missing();
        deploy.status = "canceled";
        return empty();
      }
      if (path.startsWith(`/services/${id}/deploys/`)) {
        const deploy = state.deploysById.get(path.split("/").at(-1)!);
        return deploy ? Response.json(deploy) : missing();
      }
      if (path === `/services/${id}/jobs` && method === "POST")
        return Response.json({ id: "job-acmecanary", serviceId: id, status: "pending" }, { status: 201 });
      if (path === `/services/${id}/jobs/job-acmecanary`)
        return Response.json({ id: "job-acmecanary", serviceId: id, status: state.nextJobStatus });
      if (path === `/services/${id}/jobs/job-acmecanary/cancel` && method === "POST")
        return Response.json({ id: "job-acmecanary", serviceId: id, status: "canceled" });
      if (path.endsWith("/suspend") || path.endsWith("/resume")) {
        service.suspended = path.endsWith("/suspend") ? "suspended" : "not_suspended";
        if (service.suspended === "not_suspended") {
          const deploy = {
            id: `dep-${++state.next}`,
            serviceId: id,
            status: state.automaticDeployStatus,
            commit: { id: "b".repeat(40) },
          };
          state.deploys.set(id, deploy);
          state.deploysById.set(deploy.id, deploy);
        }
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

test("Render accepts null empty lists for projects, Postgres, and services", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  const resources = new Set(["/projects", "/postgres", "/services"]);
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
  assert.equal(c.database?.region, "oregon");
  for (const service of c.services.values()) assert.equal(service.serviceDetails.region, "oregon");
  d.ctx.config.env.core = { ...d.ctx.config.env.core, RENDER_APP_REGION: "ohio" };
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /RENDER_APP_REGION=virginia/.test(error.message)));
  delete d.ctx.config.env.core.RENDER_APP_REGION;
  d.ctx.config.secretEnv = { core: { RENDER_APP_REGION: "CUSTOM_APP_REGION" } };
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /RENDER_APP_REGION.*secretEnv/.test(error.message)));
});

test("Render rejects a non-array list with a clear error", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) =>
    call.path === "/services" && call.method === "GET" ? Response.json({ unexpected: true }) : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), {
    message: "Render GET /services returned an invalid list response",
  });
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
  assert.equal(core.WORKERS, undefined);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, minio.MINIO_ROOT_PASSWORD);
});

test("Render plan needs no API calls, Git repository, or state file", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: true });
  assert.equal(c.calls.length, 0);
  assert.equal(existsSync(join(d.ctx.configDir, "render.resources.json")), false);
});

test("Render refuses to change an unknown MinIO version without an explicit upgrade", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const saved = d.saved();
  delete saved.minioSource;
  writeFileSync(join(d.ctx.configDir, "render.resources.json"), JSON.stringify(saved));
  delete c.deploys.get("srv-acme-minio")!.commit;
  d.setCommit("c".repeat(40));
  const mark = c.calls.length;
  await assert.rejects(d.backend.up({ dryRun: false }), /MinIO has no saved Git source.*render.resources.json/);
  assert.ok(!writes(c.calls.slice(mark)).some((call) => call.path === "/services/srv-acme-minio/deploys"));
});

test("Render requests wait for an HTTP-date Retry-After before retrying", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 17) });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? new Response(null, { status: 429, headers: { "retry-after": new Date(Date.now() + 20_000).toUTCString() } })
      : Response.json({ ok: true });
  });
  const pending = renderClient("test-key")<{ ok: boolean }>("/owners/test");
  await new Promise(setImmediate);
  t.mock.timers.tick(19_999);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(calls, 2);
});

test("Render waits for MinIO initialization before deploying core and retries a failed job", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.nextJobStatus = "failed";
  await assert.rejects(d.backend.up({ dryRun: false }), /MinIO initialization job.*failed/);
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
  const command = (writesAfter[initialized]!.body as { startCommand: string }).startCommand;
  const env = c.envs.get("srv-acme-minio")!;
  for (const secret of [env.MINIO_ROOT_PASSWORD!, env.QM_STORAGE_SECRET_KEY!])
    assert.equal(command.includes(secret), false);
});

test("Render builds QM services and MinIO from Git", async (t) => {
  const d = deployment(t, true);
  d.ctx.config.render!.source = { repo: "https://github.com/acme/qm", branch: "render-test" };
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
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_REPO, "https://github.com/acme/qm");
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_BRANCH, "render-test");
  c.services.get("srv-acme-minio")!.serviceDetails.plan = "starter";
  c.services.get("srv-acme-core")!.serviceDetails.plan = "pro";
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.deepEqual(d.saved().services, saved.services);
  const changes = writes(c.calls.slice(mark));
  assert.ok(changes.some((call) => call.path === "/services/srv-acme-core/deploys" && call.method === "POST"));
  assert.ok(!changes.some((call) => call.path === "/services/srv-acme-minio/deploys"));
  assert.ok(!changes.some((call) => call.path === "/services/srv-acme-minio" && call.method === "PATCH"));
  assert.ok(!changes.some((call) => call.path === "/services/srv-acme-core" && call.method === "PATCH"));
});

test("Render retries after env write failure after a preceding service update succeeds", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.render!.corePlan = "4c-8g";
  d.ctx.config.env.core!.FEATURE = "new";
  c.intercept = (call) =>
    call.path === "/services/srv-acme-core/env-vars" && call.method === "PUT"
      ? new Response(null, { status: 500, headers: { "retry-after": "0" } })
      : undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /HTTP 500/);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-core")!.FEATURE, "new");
});

test("Render retains completed resource IDs after a later create fails", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = (call) =>
    call.path === "/services" && call.method === "POST" && (call.body as { name: string }).name === "acme-core"
      ? Response.json(
          { message: "plan is not available" },
          { status: 400, headers: { "render-request-id": "req-core" } },
        )
      : undefined;
  await assert.rejects(
    d.backend.up({ dryRun: false }),
    /POST \/services failed \(HTTP 400\): \{"message":"plan is not available"\} \[request id req-core\]/,
  );
  assert.equal(Object.keys(d.saved().services).length, 1);
  assert.equal(d.saved().pendingCreate, undefined);
  c.intercept = undefined;
  await d.backend.up({ dryRun: false });
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
});

test("Render cancels an active deploy before it submits an update", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const previous = c.deploys.get("srv-acme-core")!;
  let canceled = false;
  let triggered = false;
  let readsAfterCancel = 0;
  c.intercept = ({ path, method }) => {
    if (path === "/services/srv-acme-core/deploys" && method === "GET" && !triggered)
      return Response.json([
        { deploy: previous },
        {
          deploy: { id: "dep-active", status: "update_in_progress" },
        },
      ]);
    if (path === "/services/srv-acme-core/deploys/dep-active" && method === "GET")
      return Response.json({
        id: "dep-active",
        status: canceled && ++readsAfterCancel > 1 ? "canceled" : "update_in_progress",
      });
    if (path === "/services/srv-acme-core/deploys/dep-active/cancel" && method === "POST") {
      canceled = true;
      return new Response(null, { status: 204 });
    }
    if (path === "/services/srv-acme-core/deploys" && method === "POST") {
      assert.equal(canceled, true);
      triggered = true;
    }
    return undefined;
  };
  d.ctx.config.render!.corePlan = "4c-8g";
  await d.backend.up({ dryRun: false });
  assert.equal(triggered, true);
  assert.ok(readsAfterCancel >= 2);
  assert.equal(
    c.calls.filter(
      ({ path, method, url }) =>
        path === "/services/srv-acme-core/deploys" && method === "GET" && url.searchParams.get("limit") === "100",
    ).length,
    2,
  );
});

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
  assert.deepEqual(d.saved().pendingCreate, { collection: "projects", name: "acme-qm" });
  assert.deepEqual(writes(c.calls.slice(mark)), []);
  c.intercept = undefined;
  await assert.rejects(d.backend.up({ dryRun: false }), /creation of acme-qm is unresolved/);
  assert.deepEqual(d.saved().pendingCreate, { collection: "projects", name: "acme-qm" });
});

test("Render records a resource after its accepted creation response is lost", async (t) => {
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
  assert.deepEqual(d.saved().pendingCreate, { collection: "projects", name: "acme-qm" });
  c.intercept = undefined;
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(d.saved().pendingCreate, undefined);
  assert.equal(d.saved().projectId, "prj-acme");
  assert.equal(c.projects.size, 1);
  assert.equal(c.calls.slice(mark).filter((call) => call.method === "POST" && call.path === "/projects").length, 0);
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
  assert.equal(d.saved().pendingCreate, undefined);
  assert.equal(c.projects.size, 1);
  assert.equal(c.services.size, 3);
});

test("Render updates retain stored operator secrets for the core", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  c.envs.get("srv-acme-core")!.RESEND_API_KEY = "re_stored_only";
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-core")!.RESEND_API_KEY, "re_stored_only");
  assert.equal(c.envs.get("srv-acme-web-ui")!.RESEND_API_KEY, undefined);
});

test("Render rejects disk shrink, plain HTTP URLs, and a shared hostname", async (t) => {
  const d = deployment(t);
  cloud(t, d);
  await d.backend.up({ dryRun: false });
  d.ctx.config.render!.storage.diskSizeGB = 1;
  await assert.rejects(d.backend.up({ dryRun: false }), /cannot shrink/);
  for (const publicUrl of ["http://qm.example.com", "https://qm.example.com:8443"]) {
    d.ctx.config.publicUrl = publicUrl;
    assert.ok(
      renderConfigErrors(d.ctx.config, []).some((error) => /HTTPS origin URLs on port 443/.test(error.message)),
    );
  }
  d.ctx.config.publicUrl = "https://qm.example.com";
  d.ctx.config.apiUrl = "https://qm.example.com/";
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /different hostnames/.test(error.message)));
  d.ctx.config.apiUrl = "https://www.qm.example.com";
  assert.ok(renderConfigErrors(d.ctx.config, []).some((error) => /www subdomain/.test(error.message)));
  d.ctx.config.apiUrl = "https://api.qm.example.com";
  assert.deepEqual(renderConfigErrors(d.ctx.config, []), []);
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
    "https://core.onrender.com:8443",
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
  const d = deployment(t, true);
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
  d.setCommit("c".repeat(40));
  d.ctx.config.render!.storage.diskSizeGB = 20;
  d.ctx.config.render!.postgresDiskSizeGB = 20;
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(c.envs.get("srv-acme-core")!.DEPLOY_PROVIDER, "render");
  assert.equal(c.services.get("srv-acme-minio")!.serviceDetails.disk!.sizeGB, 20);
  assert.equal(c.deploys.get("srv-acme-minio")!.commit!.id, "a".repeat(40));
  assert.equal(c.database!.diskSizeGB, 20);
  assert.equal(c.envs.get("srv-acme-minio")!.MINIO_ROOT_PASSWORD, root);
  assert.equal(
    c.calls.slice(mark).some((call) => call.path === "/services" && call.method === "POST"),
    false,
  );
});

test("Render rejects a live service built from a different source commit", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  c.intercept = ({ path, method }) => {
    if (path !== "/services/srv-acme-core/deploys" || method !== "POST") return undefined;
    const deploy = { id: "dep-wrong", status: "live", commit: { id: "b".repeat(40) } };
    c.deploys.set("srv-acme-core", deploy);
    c.deploysById.set(deploy.id, deploy);
    return Response.json(deploy);
  };
  await assert.rejects(d.backend.up({ dryRun: false }), /deployed commit b+.*expected a+/);
  assert.equal(d.saved().releases, undefined);
  assert.equal(d.saved().updateInProgress, true);
});

test("Render creates services with a no-op command and cancels the automatic build before pinning", async (t) => {
  const d = deployment(t);
  mkdirSync(join(d.ctx.configDir, "plugins", "reports"), { recursive: true });
  writeFileSync(join(d.ctx.configDir, "plugins", "reports", "Dockerfile"), "FROM node:24\n");
  const c = cloud(t, d);
  const canceled = new Set<string>();
  c.intercept = ({ path, method, body }) => {
    if (method === "POST" && path === "/services") {
      const create = body as {
        envVars: Array<{ key: string }>;
        secretFiles: unknown[];
        serviceDetails: { envSpecificDetails: { dockerCommand: string } };
      };
      assert.ok(create.envVars.some((pair) => pair.key === "PORT"));
      assert.deepEqual(create.secretFiles, []);
      assert.equal(create.serviceDetails.envSpecificDetails.dockerCommand, "/bin/sh -c exit 0");
    }
    const serviceId = path.split("/")[2]!;
    if (path.includes("/deploys/") && path.endsWith("/cancel")) {
      canceled.add(serviceId);
      assert.equal(c.deploys.get(serviceId)!.commit?.id, "b".repeat(40));
    }
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
});

test("Render keeps the selected MinIO commit when an interrupted bootstrap retries after the branch moves", async (t) => {
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
  assert.deepEqual(
    pinned.map((call) => (call.body as { commitId: string }).commitId),
    ["a".repeat(40), "c".repeat(40), "c".repeat(40)],
  );
  assert.equal(d.saved().releases[0].commit, "c".repeat(40));
  assert.equal(c.envs.get("srv-acme-core")!.RENDER_DEPLOY_COMMIT, "c".repeat(40));
});

test("Render records a service after its creation reply is lost and ignores same-named services elsewhere", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  await d.backend.up({ dryRun: false });
  const core = c.services.get("srv-acme-core")!;
  c.services.set("srv-elsewhere", { ...core, id: "srv-elsewhere", environmentId: "evm-other" });
  const state = d.saved();
  delete state.services.core;
  state.pendingCreate = { collection: "services", name: "acme-core" };
  writeFileSync(join(d.ctx.configDir, "render.resources.json"), JSON.stringify(state));
  const mark = c.calls.length;
  await d.backend.up({ dryRun: false });
  assert.equal(d.saved().pendingCreate, undefined);
  assert.deepEqual(d.saved().services.core, { id: "srv-acme-core", name: "acme-core", type: "web_service" });
  assert.equal(c.calls.slice(mark).filter((call) => call.method === "POST" && call.path === "/services").length, 0);
});

test("Render branch resolution keeps Git diagnostics before cloud changes", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  writeFileSync(
    join(d.ctx.configDir, "bin", "git"),
    "#!/bin/sh\nprintf 'fatal: could not resolve host review.invalid\\n' >&2\nexit 128\n",
  );
  await assert.rejects(
    d.backend.up({ dryRun: false }),
    /Cannot resolve Render Git branch.*fatal: could not resolve host review.invalid/s,
  );
  assert.deepEqual(c.calls, []);
});

test("Render deployment accepts a Git ref that contains non-breaking space", async (t) => {
  const d = deployment(t);
  const c = cloud(t, d);
  d.ctx.config.render!.source.branch = "fix/non\u00a0breaking";
  await d.backend.up({ dryRun: false });
  assert.equal(c.services.get("srv-acme-core")!.branch, d.ctx.config.render!.source.branch);
  assert.equal(c.runtimeEnvs.get("srv-acme-core")!.GIT_SHA, "a".repeat(40));
});
