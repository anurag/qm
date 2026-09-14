import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appPrefixOf, updateConfigUrls, type QmConfig, type RenderConfig } from "../config.ts";
import { deploymentLayerRequest, httpDeploymentLayerTransport, syncDeploymentLayer } from "../deployment-layer.ts";
import { CliError, errMessage, note, ok, step } from "../log.ts";
import { renderMinioCommand, renderMinioInitCommand } from "../render-minio.ts";
import type { ResolvedPlugin } from "../plugins.ts";
import { renderServiceEnv, renderWorkloads, type RenderBuild } from "../render-services.ts";
import { computedSecrets, runtimeSecretNames } from "../secrets.ts";
import { serviceHost } from "../services.ts";
import { capture, deploymentSecretValue, isInvalidSecret, sleep } from "../util.ts";
import { doctorCommon, localDoctorSecrets } from "./doctor.ts";
import type { DeployContext } from "./registry.ts";
import type { Backend } from "./types.ts";

export const renderDeploymentLayerTransport = httpDeploymentLayerTransport({
  timeoutMs: 60_000,
  urlOf: (config) => {
    if (!config.apiUrl) throw new CliError("Render requires apiUrl; qm init --target render sets it");
    const url = new URL(config.apiUrl);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".onrender.com") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new CliError("Render deployment-layer URL must be the assigned HTTPS core onrender.com URL");
    url.pathname = "/v1/deployment-layer";
    return url;
  },
});

type ServiceType = "web_service" | "private_service";
interface SavedService {
  id: string;
  name: string;
  type: ServiceType;
}
interface RenderService extends SavedService {
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
    numInstances: number;
    runtime: string;
    healthCheckPath?: string;
    maxShutdownDelaySeconds?: number;
    envSpecificDetails: { dockerCommand?: string; dockerfilePath?: string; dockerContext?: string };
    disk?: { id: string; mountPath: string; sizeGB: number };
  };
}
interface RenderPostgres {
  id: string;
  name: string;
  owner: { id: string };
  environmentId: string;
  region: string;
  status: string;
  suspended: string;
  plan: string;
  diskSizeGB: number;
}
interface RenderJob {
  id: string;
  serviceId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
}
interface RenderDeploy {
  id: string;
  status: string;
  commit?: { id: string };
}
const bootstrapCommand = "/bin/sh -c exit 0";
const failedDeployStatuses = ["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"];
interface RenderWorkflow {
  id: string;
  name: string;
  ownerId: string;
  region: string;
  environmentId?: string;
  slug: string;
}
interface Project {
  id: string;
  name: string;
  owner: { id: string };
  environmentIds: string[];
}
interface Environment {
  id: string;
  name: string;
  projectId: string;
}
interface State {
  version: 1;
  orgId: string;
  workspaceId: string;
  region: string;
  appPrefix: string;
  projectId?: string;
  environmentId?: string;
  postgresId?: string;
  workflowId?: string;
  workflowSlug?: string;
  workflowTaskId?: string;
  workflowBootstrap?: { commit: string; drained?: boolean };
  releaseWorkflowTaskId?: string;
  previousReleaseWorkflowTaskId?: string;
  sourceCommit?: string;
  releaseCommit?: string;
  previousReleaseCommit?: string;
  services: Record<string, SavedService>;
  pendingPurge?: boolean;
  dirtyServices?: string[];
  bootstrapServices?: Record<
    string,
    {
      env: string;
      commit?: string;
      previousDeployIds: string[];
      deployId?: string;
      requested?: boolean;
      drained?: boolean;
    }
  >;
  pendingCreate?: string;
  release?: Record<string, string>;
  previousRelease?: Record<string, string>;
  updateInProgress?: boolean;
  rollbackProgress?: {
    services: Record<string, string>;
    commit: string;
    taskId: string;
    interruptedUpdate: boolean;
    restored: Record<string, string>;
  };
}
type Workload = RenderBuild & {
  name: string;
  type: ServiceType;
  plan: string;
  plugin?: ResolvedPlugin;
  command?: string;
  health?: string;
  diskSizeGB?: number;
};
type RenderRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
class RenderApiError extends CliError {
  readonly status: number;
  constructor(status: number, path: string, method: string) {
    super(`Render ${method} ${path.split("?")[0]} failed (HTTP ${status})`);
    this.status = status;
  }
}
function client(apiKey: string): RenderRequest {
  return async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(`https://api.render.com/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (!response.ok) throw new RenderApiError(response.status, path, method);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
}
function coordinates(config: QmConfig): RenderConfig {
  if (!config.render || config.render.workspaceId === "tea-replaceme")
    throw new CliError("Set render.workspaceId to your Render workspace ID before deployment");
  return config.render;
}
function statePath(ctx: DeployContext): string {
  return join(ctx.configDir, "render.resources.json");
}
function readState(ctx: DeployContext, optional = false): State {
  const render = coordinates(ctx.config);
  if (!existsSync(statePath(ctx))) {
    if (!optional) throw new CliError("No Render resource record exists; run qm up");
    return {
      version: 1,
      orgId: ctx.config.orgId,
      workspaceId: render.workspaceId,
      region: render.region,
      appPrefix: appPrefixOf(ctx.config),
      services: {},
    };
  }
  const state = JSON.parse(readFileSync(statePath(ctx), "utf8")) as State;
  if (state.version !== 1 || !state.services || Array.isArray(state.services))
    throw new CliError(
      "The Render resource record is not a direct API deployment record; do not use it to adopt existing resources",
    );
  if (
    state.orgId !== ctx.config.orgId ||
    state.workspaceId !== render.workspaceId ||
    state.region !== render.region ||
    state.appPrefix !== appPrefixOf(ctx.config)
  )
    throw new CliError("render.resources.json belongs to another organization, workspace, region, or app prefix");
  return state;
}
function saveState(ctx: DeployContext, state: State): void {
  const path = statePath(ctx);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function removeRenderLock(path: string, owner?: string): void {
  if (owner) rmSync(join(path, owner), { force: true });
  try {
    rmdirSync(path);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}
async function locked<T>(ctx: DeployContext, operation: () => Promise<T>): Promise<T> {
  const path = join(ctx.configDir, ".render.lock");
  const candidate = mkdtempSync(`${path}-`);
  const owner = `owner-${randomUUID()}`;
  let acquired = false;
  const busy = () => new CliError("Another Render operation holds .render.lock; wait for it to finish and retry");
  try {
    writeFileSync(join(candidate, owner), String(process.pid));
    for (;;) {
      try {
        const files = readdirSync(path);
        const previous = files[0];
        if (files.length > 1 || (previous && previous !== "pid" && !/^owner-[a-f0-9-]{36}$/.test(previous)))
          throw busy();
        let stale = Date.now() - statSync(path).mtimeMs > 5_000;
        if (previous) {
          const pid = Number(readFileSync(join(path, previous), "utf8"));
          if (Number.isInteger(pid) && pid > 0) {
            stale = false;
            try {
              process.kill(pid, 0);
            } catch (error) {
              stale = (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          }
        }
        if (!stale) throw busy();
        removeRenderLock(path, previous);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        renameSync(candidate, path);
        acquired = true;
        break;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    return await operation();
  } finally {
    if (acquired) removeRenderLock(path, owner);
    else rmSync(candidate, { recursive: true, force: true });
  }
}
function credentialValues(ctx: DeployContext, envFile = ctx.envFile): Map<string, string> {
  const values = localDoctorSecrets(ctx.configDir, envFile);
  for (const secret of computedSecrets(ctx.config)) {
    if (!secret.required && values.get(secret.name)?.trim() === "") {
      values.set(secret.name, "");
      continue;
    }
    const value = deploymentSecretValue(secret.name, values.get(secret.name));
    if (value !== undefined) values.set(secret.name, value);
  }
  return values;
}
function api(ctx: DeployContext, envFile?: string): RenderRequest {
  const key = credentialValues(ctx, envFile ?? ctx.envFile).get("RENDER_API_KEY");
  if (!key || isInvalidSecret("RENDER_API_KEY", key)) throw new CliError("RENDER_API_KEY is required; run qm setup");
  return client(key);
}
function requireSecrets(ctx: DeployContext, values: ReadonlyMap<string, string>): void {
  const missing = computedSecrets(ctx.config).filter(
    (secret) =>
      secret.required && secret.managedBy === "operator" && isInvalidSecret(secret.name, values.get(secret.name)),
  );
  if (missing.length)
    throw new CliError(
      `Required secrets are missing: ${missing.map((secret) => secret.name).join(", ")}; run qm setup`,
    );
}
async function requestArray<T>(request: RenderRequest, path: string): Promise<T[]> {
  const page = await request<unknown>(path);
  if (page === null) return [];
  if (!Array.isArray(page)) throw new CliError(`Render GET ${path.split("?")[0]} returned an invalid list response`);
  return page as T[];
}
async function list<T>(request: RenderRequest, path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const url = new URL(path, "https://api.render.com");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await requestArray<Record<string, unknown>>(request, `${url.pathname}${url.search}`);
    out.push(...page.map((item) => item[key] as T));
    if (page.length < 100) return out;
    const next = page.at(-1)?.cursor;
    if (typeof next !== "string" || seen.has(next)) throw new CliError("Render pagination did not advance");
    seen.add(next);
    cursor = next;
  }
}
async function envVars(request: RenderRequest, id: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await list<{ key: string; value: string }>(request, `/services/${id}/env-vars`, "envVar")).map((item) => [
      item.key,
      item.value,
    ]),
  );
}
function pairs(values: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
}
function same(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(pairs(a)) === JSON.stringify(pairs(b));
}
function workloads(ctx: DeployContext): Workload[] {
  const render = coordinates(ctx.config);
  const out: Workload[] = [];
  if (render.storage.type === "minio")
    out.push({
      name: "minio",
      source: render.source,
      dockerfile: "deploy/render-minio/Dockerfile",
      command: renderMinioCommand,
      type: "web_service",
      plan: render.storage.plan,
      health: "/minio/health/live",
      diskSizeGB: render.storage.diskSizeGB,
    });
  for (const item of renderWorkloads(ctx.config, ctx.configDir)) {
    const privateService = !!item.plugin || (item.name === "web-ui" && ctx.config.services.includes("portal"));
    const type = privateService ? "private_service" : "web_service";
    out.push({
      ...item,
      type,
      plan: item.name === "core" ? render.corePlan : render.servicePlan,
      ...(item.name === "core" && !item.plugin ? { command: "node src/render/start.ts" } : {}),
      ...(type === "web_service" ? { health: "/healthz" } : {}),
    });
  }
  return out;
}
async function inventory(
  ctx: DeployContext,
  request: RenderRequest,
  state: State,
  missing = false,
  retired: readonly string[] = [],
) {
  let project: Project | undefined;
  if (state.projectId) {
    project = await request<Project>(`/projects/${state.projectId}`);
    if (
      project.owner.id !== state.workspaceId ||
      project.name !== `${state.appPrefix}-qm` ||
      project.id !== state.projectId
    )
      throw new CliError("The saved Render project does not match this deployment");
    if (state.environmentId && !project.environmentIds.includes(state.environmentId))
      throw new CliError("The saved Render environment is no longer in the project");
  } else if (state.environmentId || state.postgresId || Object.keys(state.services).length)
    throw new CliError("The Render resource record has no project binding");
  if (state.environmentId) {
    const environment = await request<Environment>(`/environments/${state.environmentId}`);
    if (environment.projectId !== state.projectId || environment.name !== "production")
      throw new CliError("The saved Render environment does not match this deployment");
  } else if (state.postgresId || Object.keys(state.services).length)
    throw new CliError("The Render resource record has no environment binding");
  const services = new Map<string, RenderService>();
  for (const [component, saved] of Object.entries(state.services)) {
    let service: RenderService;
    try {
      service = await request<RenderService>(`/services/${saved.id}`);
    } catch (error) {
      if ((missing || retired.includes(component)) && error instanceof RenderApiError && error.status === 404) continue;
      throw error;
    }
    if (
      service.id !== saved.id ||
      service.name !== `${state.appPrefix}-${component}` ||
      saved.name !== service.name ||
      service.type !== saved.type ||
      service.ownerId !== state.workspaceId ||
      service.environmentId !== state.environmentId ||
      service.serviceDetails.region !== state.region
    )
      throw new CliError(
        `Saved Render service ${component} does not match its workspace, environment, name, type, or region`,
      );
    services.set(component, service);
  }
  let postgres: RenderPostgres | undefined;
  if (state.postgresId) {
    try {
      postgres = await request<RenderPostgres>(`/postgres/${state.postgresId}`);
    } catch (error) {
      if (!(missing && error instanceof RenderApiError && error.status === 404)) throw error;
    }
    if (
      postgres &&
      (postgres.id !== state.postgresId ||
        postgres.owner.id !== state.workspaceId ||
        postgres.name !== `${state.appPrefix}-pg` ||
        postgres.environmentId !== state.environmentId ||
        postgres.region !== state.region)
    )
      throw new CliError("The saved Render Postgres does not match this deployment");
  }
  let workflow: RenderWorkflow | undefined;
  if (state.workflowId) {
    try {
      workflow = await request<RenderWorkflow>(`/workflows/${state.workflowId}`);
    } catch (error) {
      if (!(missing && error instanceof RenderApiError && error.status === 404)) throw error;
    }
    if (
      workflow &&
      (workflow.ownerId !== state.workspaceId ||
        workflow.region !== state.region ||
        workflow.name !== `${state.appPrefix}-worker` ||
        workflow.id !== state.workflowId ||
        (workflow.environmentId && workflow.environmentId !== state.environmentId))
    )
      throw new CliError("The saved Render workflow does not match this deployment");
  }
  return { services, postgres, workflow, environmentIds: project?.environmentIds ?? [] };
}
async function assertAvailable(
  request: RenderRequest,
  path: string,
  key: string,
  name: string,
  ownerId: string,
): Promise<void> {
  const found = await list<{ name: string }>(request, `${path}?${new URLSearchParams({ ownerId, name })}`, key);
  if (found.some((item) => item.name === name))
    throw new CliError(
      `Render ${name} already exists without a saved resource ID. Refusing to adopt it; inspect the resource and restore this deployment's render.resources.json`,
    );
}
async function recoverPendingCreate(ctx: DeployContext, request: RenderRequest, state: State): Promise<void> {
  if (!state.pendingCreate) return;
  const pending = /^\/(projects|postgres|workflows|services): (.+)$/.exec(state.pendingCreate);
  if (!pending) throw new CliError("The saved Render creation request is invalid; restore render.resources.json");
  const collection = pending[1] as "projects" | "postgres" | "workflows" | "services";
  const name = pending[2]!;
  const query = new URLSearchParams({ ownerId: state.workspaceId, name });
  const found = (
    await list<{ id: string; name: string; type: ServiceType; slug: string }>(
      request,
      `/${collection}?${query}`,
      collection === "postgres" ? collection : collection.slice(0, -1),
    )
  ).filter((item) => item.name === name);
  if (found.length > 1)
    throw new CliError(
      `Render has several resources named ${name}; remove the duplicates and restore render.resources.json`,
    );
  const created = found[0];
  if (created) {
    if (collection === "projects") state.projectId ??= created.id;
    else if (collection === "postgres") state.postgresId ??= created.id;
    else if (collection === "workflows") {
      state.workflowId ??= created.id;
      state.workflowSlug ??= created.slug;
    } else state.services[name.slice(state.appPrefix.length + 1)] ??= { id: created.id, name, type: created.type };
  }
  delete state.pendingCreate;
  saveState(ctx, state);
}
async function poll(label: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20 * 60_000;
  let nextUpdate = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new CliError(`${label} did not become ready in 20 minutes; use qm status and qm logs`);
    if (Date.now() >= nextUpdate) {
      step(`waiting for ${label}`);
      nextUpdate = Date.now() + 30_000;
    }
    await sleep(3_000);
  }
}
export function renderInternalUrl(service: Pick<RenderService, "name" | "slug">): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(service.slug))
    throw new CliError(`Render returned an invalid private hostname for ${service.name}`);
  return `http://${service.slug}:8080`;
}
function publicUrl(service: RenderService): string {
  const url = new URL(service.serviceDetails.url);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".onrender.com") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new CliError(`Render returned an invalid public address for ${service.name}`);
  return url.origin;
}
async function waitDeploy(
  request: RenderRequest,
  service: RenderService,
  id?: string,
  previousId?: string,
  expectedCommit?: string,
): Promise<void> {
  await poll(service.name, async () => {
    const deploy = id
      ? await request<RenderDeploy>(`/services/${service.id}/deploys/${id}`)
      : (await requestArray<{ deploy: RenderDeploy }>(request, `/services/${service.id}/deploys?limit=1`))[0]?.deploy;
    if (!deploy || deploy.id === previousId) return false;
    id = deploy.id;
    if (failedDeployStatuses.includes(deploy.status))
      throw new CliError(
        `${service.name} deploy ${deploy.id} ended with ${deploy.status}; fix the error and run qm up again`,
      );
    if (deploy.status === "live" && expectedCommit && deploy.commit?.id !== expectedCommit)
      throw new CliError(
        `${service.name} deployed commit ${deploy.commit?.id ?? "unknown"}, expected ${expectedCommit}`,
      );
    return deploy.status === "live";
  });
  ok(`${service.name}: live`);
}
async function idleDeploys(request: RenderRequest, service: RenderService): Promise<RenderDeploy[]> {
  let history: RenderDeploy[] = [];
  await poll(`${service.name} previous deploys`, async () => {
    history = await list<RenderDeploy>(request, `/services/${service.id}/deploys`, "deploy");
    return history.every((deploy) => deploy.status === "live" || failedDeployStatuses.includes(deploy.status));
  });
  return history;
}
function bootstrapEnvKey(values: ReadonlyMap<string, string>): Buffer {
  const secret = values.get("CORE_SIGNING_SECRET");
  if (!secret) throw new CliError("CORE_SIGNING_SECRET is required to preserve Render bootstrap credentials");
  return createHash("sha256").update(`qm-render-bootstrap-v1\0${secret}`).digest();
}
function sealBootstrapEnv(state: State, name: string, env: Record<string, string>, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${state.workspaceId}/${state.appPrefix}/${name}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(env)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function openBootstrapEnv(state: State, name: string, key: Buffer): Record<string, string> | undefined {
  const bootstrap = state.bootstrapServices?.[name];
  if (!bootstrap) return undefined;
  try {
    const value = Buffer.from(bootstrap.env, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${state.workspaceId}/${state.appPrefix}/${name}`));
    decipher.setAuthTag(value.subarray(12, 28));
    const env: unknown = JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString());
    if (
      !env ||
      typeof env !== "object" ||
      Array.isArray(env) ||
      Object.values(env).some((value) => typeof value !== "string")
    )
      throw new Error("Invalid bootstrap environment");
    return env as Record<string, string>;
  } catch {
    throw new CliError(
      `Cannot decrypt ${name} bootstrap credentials; restore the CORE_SIGNING_SECRET used when bootstrap started`,
    );
  }
}
async function prepareBootstrap(
  ctx: DeployContext,
  request: RenderRequest,
  state: State,
  workload: Workload,
  service: RenderService,
  env: Record<string, string>,
  key: Buffer,
): Promise<RenderService> {
  if (!state.bootstrapServices?.[workload.name] && service.suspended !== "suspended") return service;
  const bootstraps = (state.bootstrapServices ??= {});
  if (!bootstraps[workload.name]) {
    const history = await idleDeploys(request, service);
    bootstraps[workload.name] = {
      env: sealBootstrapEnv(state, workload.name, env, key),
      commit: state.sourceCommit!,
      previousDeployIds: history.map((deploy) => deploy.id),
    };
    saveState(ctx, state);
  }
  const bootstrap = bootstraps[workload.name]!;
  if (bootstrap.drained) return service;
  if (!bootstrap.requested || service.suspended === "suspended") {
    await request(`/services/${service.id}/env-vars`, "PUT", []);
    await request(`/services/${service.id}/secret-files`, "PUT", []);
    await request(`/services/${service.id}`, "PATCH", {
      autoDeploy: "no",
      ...buildSource(workload),
      serviceDetails: {
        runtime: "docker",
        envSpecificDetails: { ...dockerSettings(workload), dockerCommand: bootstrapCommand },
      },
    });
    bootstrap.requested = true;
    saveState(ctx, state);
    try {
      await request(`/services/${service.id}/resume`, "POST");
    } catch (error) {
      if (error instanceof RenderApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        delete bootstrap.requested;
        saveState(ctx, state);
      }
      throw error;
    }
  }
  await poll(`${service.name} bootstrap`, async () => {
    const history = await list<RenderDeploy>(request, `/services/${service.id}/deploys`, "deploy");
    const automatic = history.find((deploy) =>
      bootstrap.deployId ? deploy.id === bootstrap.deployId : !bootstrap.previousDeployIds.includes(deploy.id),
    );
    if (!automatic) return false;
    if (automatic.status !== "live" && !failedDeployStatuses.includes(automatic.status))
      await request(`/services/${service.id}/deploys/${automatic.id}/cancel`, "POST");
    await idleDeploys(request, service);
    return true;
  });
  bootstrap.drained = true;
  saveState(ctx, state);
  return request<RenderService>(`/services/${service.id}`);
}
async function deploy(request: RenderRequest, service: RenderService, commit: string): Promise<void> {
  const previousId = (await idleDeploys(request, service))[0]?.id;
  if (service.suspended === "suspended") throw new CliError(`${service.name} must finish bootstrap before deployment`);
  const result = await request<{ id: string } | undefined>(`/services/${service.id}/deploys`, "POST", {
    clearCache: "do_not_clear",
    commitId: commit,
  });
  await waitDeploy(request, service, result?.id, previousId, commit);
}

async function runJob(
  request: RenderRequest,
  service: RenderService,
  workspaceId: string,
  startCommand: string,
  label: string,
  report: boolean,
): Promise<void> {
  const job = await request<RenderJob>(`/services/${service.id}/jobs`, "POST", { startCommand });
  if (!/^job-[a-z0-9]+$/.test(job.id) || job.serviceId !== service.id)
    throw new CliError(`Render returned an invalid ${label} job for ${service.id}; inspect its jobs before retrying`);
  if (report) step(`${service.name}: ${label} job ${job.id}`);
  const path = `/services/${service.id}/jobs/${job.id}`;
  const deadline = Date.now() + 20 * 60_000;
  let current = job;
  try {
    for (;;) {
      if (Date.now() >= deadline) throw new CliError("did not finish within 20 minutes");
      const received = await request<RenderJob>(path);
      if (received.id !== job.id || received.serviceId !== service.id)
        throw new CliError("Render returned a job from another service");
      current = received;
      if (Date.now() >= deadline) throw new CliError("did not finish within 20 minutes");
      if (current.status === "succeeded") {
        if (report) ok(`${service.name}: ${label} passed`);
        return;
      }
      if (current.status !== "pending" && current.status !== "running")
        throw new CliError(`ended with ${current.status}`);
      await sleep(Math.min(3_000, deadline - Date.now()));
    }
  } catch (error) {
    let message = errMessage(error);
    if (current.status !== "succeeded" && current.status !== "failed" && current.status !== "canceled") {
      try {
        await request(`${path}/cancel`, "POST");
      } catch (cancelError) {
        message += `; cancellation failed: ${errMessage(cancelError)}`;
      }
    }
    const logs = new URLSearchParams({ ownerId: workspaceId, resource: job.id, direction: "backward", limit: "100" });
    throw new CliError(`Render ${label} job ${job.id} ${message}. Read its logs: GET /v1/logs?${logs}`);
  }
}
async function liveSession(
  request: RenderRequest,
  core: RenderService,
  workspaceId: string,
  report: boolean,
): Promise<void> {
  await runJob(
    request,
    core,
    workspaceId,
    `timeout -s TERM -k 30 1200 node src/deployment/postdeploy-smoke.ts session ${renderInternalUrl(core)}`,
    "live session",
    report,
  );
}
async function createResource<T>(
  ctx: DeployContext,
  request: RenderRequest,
  state: State,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  state.pendingCreate = `${path}: ${String(body.name)}`;
  saveState(ctx, state);
  try {
    return await request<T>(path, "POST", body);
  } catch (error) {
    if (error instanceof RenderApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
      delete state.pendingCreate;
      saveState(ctx, state);
    }
    throw error;
  }
}
async function provision(ctx: DeployContext, request: RenderRequest, state: State): Promise<RenderPostgres> {
  const render = coordinates(ctx.config);
  if (!state.projectId) {
    const name = `${state.appPrefix}-qm`;
    await assertAvailable(request, "/projects", "project", name, state.workspaceId);
    const project = await createResource<Project>(ctx, request, state, "/projects", {
      name,
      ownerId: state.workspaceId,
      environments: [{ name: "production" }],
    });
    state.projectId = project.id;
    delete state.pendingCreate;
    saveState(ctx, state);
  }
  if (!state.environmentId) {
    const project = await request<Project>(`/projects/${state.projectId}`);
    const environments = await Promise.all(
      project.environmentIds.map((id) => request<Environment>(`/environments/${id}`)),
    );
    const production = environments.filter((item) => item.name === "production" && item.projectId === state.projectId);
    if (production.length !== 1) throw new CliError("The Render project must contain one production environment");
    state.environmentId = production[0]!.id;
    saveState(ctx, state);
  }
  if (!state.postgresId) {
    const name = `${state.appPrefix}-pg`;
    await assertAvailable(request, "/postgres", "postgres", name, state.workspaceId);
    const postgres = await createResource<RenderPostgres>(ctx, request, state, "/postgres", {
      name,
      ownerId: state.workspaceId,
      environmentId: state.environmentId,
      region: state.region,
      plan: render.postgresPlan,
      version: "18",
      diskSizeGB: render.postgresDiskSizeGB,
      ipAllowList: [],
    });
    state.postgresId = postgres.id;
    delete state.pendingCreate;
    saveState(ctx, state);
  }
  let postgres = (await inventory(ctx, request, state)).postgres!;
  if (postgres.diskSizeGB > render.postgresDiskSizeGB)
    throw new CliError("Render Postgres storage cannot shrink; keep postgresDiskSizeGB at its current size or larger");
  if (postgres.suspended === "suspended") await request(`/postgres/${postgres.id}/resume`, "POST");
  if (postgres.plan !== render.postgresPlan || postgres.diskSizeGB !== render.postgresDiskSizeGB)
    await request(`/postgres/${postgres.id}`, "PATCH", {
      plan: render.postgresPlan,
      diskSizeGB: render.postgresDiskSizeGB,
    });
  await poll("Render Postgres", async () => {
    postgres = await request<RenderPostgres>(`/postgres/${state.postgresId}`);
    if (postgres.status === "recovery_failed") throw new CliError("Render Postgres recovery failed");
    return postgres.status === "available";
  });
  return postgres;
}
async function reconcileWorkflow(
  ctx: DeployContext,
  request: RenderRequest,
  state: State,
  env: Record<string, string>,
): Promise<void> {
  const render = coordinates(ctx.config);
  const buildConfig = {
    ...render.source,
    rootDir: "",
    runtime: "node",
    buildCommand: "npm ci --omit=dev --ignore-scripts",
  };
  const runCommand = "node src/render/workflows.ts";
  const workerEnv = {
    ...env,
    DATA_DIR: "/tmp/qm",
    RENDER_WORKFLOW_SLUG: "",
    RENDER_WORKFLOW_TASK_ID: "",
    NODE_VERSION: "24.18.0",
  };
  let workflow: RenderWorkflow;
  if (!state.workflowId) {
    const name = `${state.appPrefix}-worker`;
    await assertAvailable(request, "/workflows", "workflow", name, state.workspaceId);
    state.workflowBootstrap ??= { commit: state.sourceCommit! };
    saveState(ctx, state);
    workflow = await createResource<RenderWorkflow>(ctx, request, state, "/workflows", {
      name,
      ownerId: state.workspaceId,
      region: state.region,
      buildConfig,
      runCommand: bootstrapCommand,
      autoDeployTrigger: "off",
      envVars: pairs({ NODE_VERSION: "24.18.0" }),
    });
    state.workflowId = workflow.id;
    state.workflowSlug = workflow.slug;
    delete state.pendingCreate;
    saveState(ctx, state);
  } else {
    workflow = (await inventory(ctx, request, state)).workflow!;
  }
  if (!workflow.environmentId) {
    await request(`/environments/${state.environmentId}/resources`, "POST", { resourceIds: [workflow.id] });
    workflow = (await inventory(ctx, request, state)).workflow!;
  }
  if ((workflow.environmentId && workflow.environmentId !== state.environmentId) || !workflow.slug)
    throw new CliError("Render workflow was not attached to this deployment environment");
  state.workflowSlug = workflow.slug;
  saveState(ctx, state);
  const path = `/workflowversions?${new URLSearchParams({ workflowId: workflow.id, limit: "1" })}`;
  if (state.workflowBootstrap && !state.workflowBootstrap.drained) {
    await poll(`${workflow.name} bootstrap`, async () => {
      const version = (await requestArray<{ workflowVersion: { id: string; status: string } }>(request, path))[0]
        ?.workflowVersion;
      return !version || ["ready", "build_failed", "registration_failed"].includes(version.status);
    });
    state.workflowBootstrap.drained = true;
    saveState(ctx, state);
  }
  await request(`/workflows/${workflow.id}`, "PATCH", { buildConfig, runCommand, autoDeployTrigger: "off" });
  await request(`/services/${workflow.id}/env-vars`, "PUT", pairs(workerEnv));
  const previous = (await requestArray<{ workflowVersion: { id: string; status: string } }>(request, path))[0]
    ?.workflowVersion;
  await request("/workflowversions", "POST", { workflowId: workflow.id, commit: state.sourceCommit });
  let versionId: string | undefined;
  await poll(`${workflow.name} workflow`, async () => {
    const version = (await requestArray<{ workflowVersion: { id: string; status: string } }>(request, path))[0]
      ?.workflowVersion;
    if (!version || version.id === previous?.id) return false;
    if (["build_failed", "registration_failed"].includes(version.status))
      throw new CliError(`Render workflow ${version.id} ended with ${version.status}`);
    versionId = version.id;
    return version.status === "ready";
  });
  const tasks = await list<{ id: string; name: string; workflowId: string; workflowVersionId: string }>(
    request,
    `/tasks?${new URLSearchParams({ workflowVersionId: versionId! })}`,
    "task",
  );
  const selected = tasks.filter(
    (task) => task.name === "qm_run" && task.workflowId === workflow.id && task.workflowVersionId === versionId,
  );
  if (selected.length !== 1) throw new CliError("The Render workflow version must register one qm_run task");
  state.workflowTaskId = selected[0]!.id;
  delete state.workflowBootstrap;
  saveState(ctx, state);
  ok(`${workflow.name}: ready`);
}

function serviceEnv(
  ctx: DeployContext,
  workload: Workload,
  values: Map<string, string>,
  databaseUrl: string,
  appDatabaseEndpoint: string,
  state: State,
  services: Map<string, RenderService>,
  existing: Record<string, string>,
): Record<string, string> {
  if (workload.name === "minio" && !workload.plugin) {
    for (const key of ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "QM_STORAGE_SECRET_KEY"])
      if (state.services.minio && !existing[key])
        throw new CliError(`Saved MinIO has no ${key}; restore its environment variable before deployment`);
    return {
      HOST: "0.0.0.0",
      PORT: "9000",
      MINIO_BROWSER: "off",
      MINIO_ROOT_USER: existing.MINIO_ROOT_USER ?? `qm-root-${randomBytes(12).toString("hex")}`,
      MINIO_ROOT_PASSWORD: existing.MINIO_ROOT_PASSWORD ?? randomBytes(32).toString("hex"),
      QM_STORAGE_SECRET_KEY: existing.QM_STORAGE_SECRET_KEY ?? randomBytes(32).toString("hex"),
      MINIO_API_STALE_UPLOADS_EXPIRY: "24h",
      MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL: "6h",
      MINIO_API_CORS_ALLOW_ORIGIN: ctx.config.publicUrl,
    };
  }
  const resolved = new Map(values);
  for (const secret of computedSecrets(ctx.config)) {
    if (secret.managedBy !== "operator" || resolved.has(secret.name)) continue;
    const names = runtimeSecretNames(
      workload.name,
      secret,
      ctx.config.plugins.filter((item) => item.coreAccess !== false).map((item) => item.name),
    );
    const stored = names.map((name) => existing[name]).find((value) => value !== undefined);
    if (stored !== undefined) resolved.set(secret.name, stored);
  }
  const core = services.get("core");
  const web = services.get("web-ui");
  return renderServiceEnv(
    ctx.config,
    workload.name,
    resolved,
    {
      databaseUrl,
      coreUrl: core ? renderInternalUrl(core) : "http://127.0.0.1:8080",
      ...(web ? { webUiUrl: web.type === "private_service" ? renderInternalUrl(web) : publicUrl(web) } : {}),
      projectId: state.projectId,
      environmentId: state.environmentId,
      postgresId: state.postgresId,
      appDatabaseEndpoint,
      minioServiceId: state.services.minio?.id,
      workflowSlug: state.workflowSlug,
      workflowTaskId: state.workflowTaskId,
      sourceCommit: state.sourceCommit,
    },
    workload.plugin,
  );
}
function buildSource(workload: Workload) {
  return { repo: workload.source.repo, branch: workload.source.branch, rootDir: "" };
}

function dockerSettings(workload: Workload) {
  return { dockerCommand: workload.command ?? "", dockerfilePath: workload.dockerfile, dockerContext: "." };
}

async function reconcileService(
  request: RenderRequest,
  state: State,
  workload: Workload,
  service: RenderService,
  env: Record<string, string>,
  existing: Record<string, string>,
): Promise<boolean> {
  if (service.type !== workload.type)
    throw new CliError(`${workload.name} changes its Render service type; use a new app prefix for this topology`);
  const details = service.serviceDetails;
  if (details.numInstances !== 1 || (workload.diskSizeGB ? details.disk?.mountPath !== "/data" : !!details.disk))
    throw new CliError(
      `${workload.name} must have one instance ${workload.diskSizeGB ? "with its persistent disk at /data" : "without a disk"}`,
    );
  let changed = false;
  if (workload.diskSizeGB && details.disk) {
    if (details.disk.sizeGB > workload.diskSizeGB)
      throw new CliError("MinIO storage cannot shrink; keep diskSizeGB at its current size or larger");
    if (details.disk.sizeGB !== workload.diskSizeGB) {
      await request(`/disks/${details.disk.id}`, "PATCH", { sizeGB: workload.diskSizeGB });
      changed = true;
    }
  }
  const buildChanged =
    (service.repo ?? "")
      .replace(/\/$/, "")
      .replace(/\.git$/, "")
      .toLowerCase() !== workload.source.repo.toLowerCase() ||
    service.branch !== workload.source.branch ||
    !!service.rootDir ||
    details.envSpecificDetails.dockerfilePath !== workload.dockerfile ||
    details.envSpecificDetails.dockerContext !== ".";
  if (
    buildChanged ||
    details.runtime !== "docker" ||
    service.autoDeploy !== "no" ||
    details.plan !== workload.plan ||
    (details.envSpecificDetails.dockerCommand ?? "") !== (workload.command ?? "") ||
    (workload.health !== undefined && details.healthCheckPath !== workload.health) ||
    (!workload.diskSizeGB && details.maxShutdownDelaySeconds !== 300)
  ) {
    await request(`/services/${service.id}`, "PATCH", {
      autoDeploy: "no",
      ...buildSource(workload),
      serviceDetails: {
        runtime: "docker",
        plan: workload.plan,
        envSpecificDetails: dockerSettings(workload),
        ...(workload.health ? { healthCheckPath: workload.health } : {}),
        ...(!workload.diskSizeGB ? { maxShutdownDelaySeconds: 300 } : {}),
      },
    });
    changed = true;
  }
  if (!same(env, existing)) {
    await request(`/services/${service.id}/env-vars`, "PUT", pairs(env));
    changed = true;
  }
  return changed;
}
export function renderConfigErrors(
  config: QmConfig,
  plugins: readonly ResolvedPlugin[],
): Array<{ clause: string; message: string }> {
  const errors: Array<{ clause: string; message: string }> = [];
  const add = (message: string): void => {
    errors.push({ clause: "config.v1", message });
  };
  if (!config.render) add("Render requires a render config block");
  if (!config.apiUrl) add("Render requires apiUrl; qm init --target render sets it");
  for (const url of [config.publicUrl, config.apiUrl]) {
    if (url && (new URL(url).protocol !== "https:" || !new URL(url).hostname.endsWith(".onrender.com")))
      add("Render hosting currently uses the assigned HTTPS onrender.com URLs");
  }
  if (!config.services.includes("web-ui")) add("Render hosting requires web-ui");
  if (config.services.includes("admin") && !config.services.includes("portal"))
    add("Render admin requires the authenticated portal");
  if (plugins.some((plugin) => plugin.kind === "image")) add("Render plugins require Git source Dockerfiles");
  if (Object.keys(config.imageOverrides).length || config.imageFrom)
    add("Render builds from Git; remove imageOverrides and imageFrom");
  if (config.env.core?.RENDER_DEPLOY_IMAGE !== undefined)
    add("Render builds apps from Git; remove env.core.RENDER_DEPLOY_IMAGE");
  for (const plugin of config.plugins) {
    if (config.render?.storage.type === "minio" && plugin.name === "minio")
      add(`Render reserves plugin name ${plugin.name} for bundled storage`);
    if (plugin.coreAccess === false && plugin.secrets?.some((secret) => secret.name === "DATABASE_URL"))
      add(`Render plugin ${plugin.name} cannot use the core DATABASE_URL when coreAccess is false`);
  }
  if (config.skills.length) add("Place extra Render deployment skills in sandbox/skills instead of skills[]");
  if (config.vms && Object.keys(config.vms).length)
    add("Use render.corePlan and render.servicePlan instead of vms for Render");
  const managed = {
    DATA_DIR: "/data",
    SESSION_STORE: "postgres",
    RUN_STORE: "postgres",
    WORKSPACE_STORE: "s3",
    SNAPSHOT_STORE: "s3",
    TRANSFER_STORE: "s3",
    SANDBOX_BACKEND: "render",
    DEPLOY_PROVIDER: "render",
    RENDER_WORKSPACE_ID: config.render?.workspaceId ?? "",
    RENDER_REGION: config.render?.region ?? "",
    RENDER_APP_REGION: config.render?.appRegion ?? config.render?.region ?? "",
  };
  for (const [key, value] of Object.entries(managed)) {
    if (config.env.core?.[key] !== undefined && config.env.core[key] !== value)
      add(`Render requires env.core.${key}=${value}`);
  }
  for (const key of [...Object.keys(managed), "DATABASE_URL", "PUBLIC_API_URL"]) {
    if (config.secretEnv?.core?.[key]) add(`Render derives core ${key}; remove its secretEnv entry`);
  }
  for (const key of [
    "RENDER_DEPLOY_REPO",
    "RENDER_DEPLOY_BRANCH",
    "RENDER_DEPLOY_COMMIT",
    "GIT_SHA",
    "RENDER_PROJECT_ID",
    "RENDER_ENVIRONMENT_ID",
    "RENDER_POSTGRES_ID",
    "RENDER_MINIO_SERVICE_ID",
    "RENDER_APP_DATABASE_ENDPOINT",
    "RENDER_WORKFLOW_SLUG",
    "RENDER_WORKFLOW_TASK_ID",
  ]) {
    if (config.env.core?.[key] !== undefined || config.secretEnv?.core?.[key] !== undefined)
      add(`Render derives core ${key}; remove its env or secretEnv entry`);
  }
  if (config.render?.storage.type === "minio") {
    for (const key of [
      "S3_BUCKET",
      "S3_REGION",
      "S3_FORCE_PATH_STYLE",
      "AWS_ENDPOINT_URL_S3",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "RENDER_QM_MINIO",
      "MINIO_ROOT_USER",
      "MINIO_ROOT_PASSWORD",
      "QM_STORAGE_SECRET_KEY",
    ]) {
      if (config.env.core?.[key] !== undefined || config.secretEnv?.core?.[key] !== undefined)
        add(`Render manages core ${key}; remove its env or secretEnv entry`);
    }
  }

  return errors;
}

export function createRenderBackend(ctx: DeployContext): Backend {
  return {
    up: async (opts) => {
      if (
        opts.buildFrom ||
        opts.buildFromPath ||
        opts.buildOnly ||
        opts.candidate ||
        opts.candidateOut ||
        opts.inactive ||
        opts.imageFrom ||
        opts.imageLabel ||
        opts.imageRepoPrefix
      )
        throw new CliError("Set render.source for Git builds");
      const errors = renderConfigErrors(ctx.config, []);
      if (errors.length) throw new CliError(errors.map((error) => error.message).join("\n"));
      const desired = workloads(ctx);
      if (opts.only?.length)
        throw new CliError("Render qm up reconciles the complete deployment; --only is not supported");
      for (const name of opts.restart ?? [])
        if (!desired.some((item) => item.name === serviceHost(name)))
          throw new CliError(`No Render workload exists for ${name}`);
      if (opts.dryRun) {
        step(`create or reconcile Render project ${appPrefixOf(ctx.config)}-qm and its production environment`);
        step(`create or reconcile Postgres (${coordinates(ctx.config).postgresPlan})`);
        for (const workload of desired)
          step(
            `${workload.name}: ${workload.type}, ${workload.plan}, ${workload.source.repo} branch ${workload.source.branch}, ${workload.dockerfile}${workload.diskSizeGB ? `, ${workload.diskSizeGB} GB persistent disk` : ""}`,
          );
        step("create or update the Git-built Render workflow in the same project");
        step("set service connections and secrets, deploy changes, and upload the deployment layer");
        return;
      }
      await locked(ctx, async () => {
        const state = readState(ctx, true);
        const source = coordinates(ctx.config).source;
        let remote: string;
        try {
          remote = capture("git", ["ls-remote", "--exit-code", source.repo, `refs/heads/${source.branch}`], {
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          }).trim();
        } catch {
          throw new CliError(`Cannot resolve Render Git branch ${source.branch}; check repository access`);
        }
        const [commit, ref] = remote.split(/\s+/);
        if (!commit || !/^[a-f0-9]{40}$/.test(commit) || ref !== `refs/heads/${source.branch}`)
          throw new CliError("Render Git source did not resolve to one branch commit");
        const pendingCommits = new Set([
          ...Object.entries(state.bootstrapServices ?? {}).flatMap(([name, bootstrap]) =>
            bootstrap.commit && !bootstrap.drained && desired.some((item) => item.name === name)
              ? [bootstrap.commit]
              : [],
          ),
          ...(state.workflowBootstrap && !state.workflowBootstrap.drained ? [state.workflowBootstrap.commit] : []),
        ]);
        if (pendingCommits.size > 1)
          throw new CliError("Render bootstrap has conflicting source commits; restore the resource record");
        state.sourceCommit = [...pendingCommits][0] ?? commit;
        if (state.pendingPurge)
          throw new CliError("Render cleanup is incomplete; run qm down --purge before deployment");
        if (state.rollbackProgress)
          throw new CliError("Render rollback is incomplete; run qm rollback before deployment");
        const values = credentialValues(ctx);
        requireSecrets(ctx, values);
        const bootstrapKey = bootstrapEnvKey(values);
        for (const name of Object.keys(state.bootstrapServices ?? {})) openBootstrapEnv(state, name, bootstrapKey);
        await doctorCommon(ctx.config, values, { requiredSecretValues: true, configDir: ctx.configDir });
        const request = api(ctx);
        await request(`/owners/${state.workspaceId}`);
        await recoverPendingCreate(ctx, request, state);
        const retired = [
          ...new Set([...Object.keys(state.services), ...Object.keys(state.bootstrapServices ?? {})]),
        ].filter((name) => !desired.some((item) => item.name === name));
        const bound = await inventory(ctx, request, state, false, retired);
        for (const name of retired) {
          if (bound.services.has(name)) {
            if (state.bootstrapServices?.[name]) delete state.bootstrapServices[name]!.commit;
            continue;
          }
          delete state.services[name];
          if (state.bootstrapServices) delete state.bootstrapServices[name];
          state.dirtyServices = state.dirtyServices?.filter((item) => item !== name);
        }
        for (const workload of desired) {
          const bootstrap = state.bootstrapServices?.[workload.name];
          if (bootstrap && !bootstrap.drained) bootstrap.commit ??= state.sourceCommit;
        }
        saveState(ctx, state);
        state.updateInProgress = true;
        saveState(ctx, state);
        const postgres = await provision(ctx, request, state);
        const info = await request<{ internalConnectionString: string; externalConnectionString: string }>(
          `/postgres/${postgres.id}/connection-info`,
        );
        if (!info.internalConnectionString)
          throw new CliError("Render returned no internal Postgres connection string");
        let appDatabaseUrl: URL;
        try {
          appDatabaseUrl = new URL(info.externalConnectionString);
          if (!["postgres:", "postgresql:"].includes(appDatabaseUrl.protocol) || !appDatabaseUrl.hostname)
            throw new Error();
        } catch {
          throw new CliError("Render returned no valid external Postgres connection string");
        }
        appDatabaseUrl.username = "";
        appDatabaseUrl.password = "";
        appDatabaseUrl.pathname = "/";
        appDatabaseUrl.search = "?sslmode=verify-full";
        appDatabaseUrl.hash = "";
        const appDatabaseEndpoint = appDatabaseUrl.href;
        const { services } = await inventory(ctx, request, state);
        const envs = new Map<string, Record<string, string>>();
        for (const workload of desired) {
          let service = services.get(workload.name);
          let env =
            openBootstrapEnv(state, workload.name, bootstrapKey) ?? (service ? await envVars(request, service.id) : {});
          if (!service) {
            const name = `${state.appPrefix}-${workload.name}`;
            await assertAvailable(request, "/services", "service", name, state.workspaceId);
            env = serviceEnv(
              ctx,
              workload,
              values,
              info.internalConnectionString,
              appDatabaseEndpoint,
              state,
              services,
              env,
            );
            state.bootstrapServices ??= {};
            state.bootstrapServices[workload.name] ??= {
              env: sealBootstrapEnv(state, workload.name, env, bootstrapKey),
              commit: state.sourceCommit!,
              previousDeployIds: [],
              requested: true,
            };
            saveState(ctx, state);
            const result = await createResource<{ service: RenderService; deployId: string }>(
              ctx,
              request,
              state,
              "/services",
              {
                type: workload.type,
                name,
                ownerId: state.workspaceId,
                environmentId: state.environmentId,
                ...buildSource(workload),
                autoDeploy: "no",
                envVars: [],
                secretFiles: [],
                serviceDetails: {
                  runtime: "docker",
                  plan: workload.plan,
                  region: state.region,
                  numInstances: 1,
                  envSpecificDetails: { ...dockerSettings(workload), dockerCommand: bootstrapCommand },
                  ...(workload.health ? { healthCheckPath: workload.health } : {}),
                  ...(workload.diskSizeGB
                    ? { disk: { name: "data", mountPath: "/data", sizeGB: workload.diskSizeGB } }
                    : {}),
                  ...(!workload.diskSizeGB ? { maxShutdownDelaySeconds: 300 } : {}),
                },
              },
            );
            service = result.service;
            state.services[workload.name] = { id: service.id, name, type: workload.type };
            state.bootstrapServices[workload.name]!.deployId = result.deployId;
            delete state.pendingCreate;
            state.dirtyServices = [...new Set([...(state.dirtyServices ?? []), workload.name])];
            saveState(ctx, state);
            services.set(workload.name, service);
            await inventory(ctx, request, state);
          }
          envs.set(workload.name, env);
          if (workload.name === "minio" && !workload.plugin) {
            if (!env.QM_STORAGE_SECRET_KEY)
              throw new CliError("Saved MinIO has no QM_STORAGE_SECRET_KEY; restore it before deployment");
            values.set("AWS_ACCESS_KEY_ID", "qm-storage");
            values.set("AWS_SECRET_ACCESS_KEY", env.QM_STORAGE_SECRET_KEY);
            values.set("AWS_ENDPOINT_URL_S3", publicUrl(service));
          }
        }
        const urls = {
          apiUrl: publicUrl(services.get("core")!),
          publicUrl: publicUrl(services.get(ctx.config.services.includes("portal") ? "portal" : "web-ui")!),
        };
        const current = readFileSync(ctx.configPath, "utf8");
        const updated = updateConfigUrls(current, urls);
        if (updated !== current) writeFileSync(ctx.configPath, updated);
        Object.assign(ctx.config, urls);
        for (const workload of desired) {
          let service = services.get(workload.name)!;
          const existing = envs.get(workload.name)!;
          service = await prepareBootstrap(ctx, request, state, workload, service, existing, bootstrapKey);
          services.set(workload.name, service);
          const env = serviceEnv(
            ctx,
            workload,
            values,
            info.internalConnectionString,
            appDatabaseEndpoint,
            state,
            services,
            existing,
          );
          if (workload.name === "core" && !workload.plugin) {
            await reconcileWorkflow(ctx, request, state, env);
            env.RENDER_WORKFLOW_SLUG = state.workflowSlug!;
            env.RENDER_WORKFLOW_TASK_ID = state.workflowTaskId!;
          }
          const pending = state.dirtyServices?.includes(workload.name) ?? false;
          state.dirtyServices = [...new Set([...(state.dirtyServices ?? []), workload.name])];
          saveState(ctx, state);
          const changed = await reconcileService(
            request,
            state,
            workload,
            service,
            env,
            await envVars(request, service.id),
          );
          const latest = (
            await requestArray<{ deploy: { id: string; status: string } }>(
              request,
              `/services/${service.id}/deploys?limit=1`,
            )
          )[0]?.deploy;
          if (
            changed ||
            (!workload.diskSizeGB && workload.source) ||
            pending ||
            service.suspended === "suspended" ||
            opts.restart?.some((name) => serviceHost(name) === workload.name) ||
            !latest ||
            failedDeployStatuses.includes(latest.status)
          )
            await deploy(request, service, state.sourceCommit!);
          else await waitDeploy(request, service);
          if (workload.name === "minio" && !workload.plugin)
            await runJob(
              request,
              service,
              state.workspaceId,
              renderMinioInitCommand(service.slug),
              "MinIO initialization",
              true,
            );
          if (state.bootstrapServices) delete state.bootstrapServices[workload.name];
          state.dirtyServices = state.dirtyServices.filter((name) => name !== workload.name);
          saveState(ctx, state);
        }
        await poll("core readiness", async () => {
          try {
            return (await fetch(`${urls.apiUrl}/healthz`, { signal: AbortSignal.timeout(30_000), redirect: "error" }))
              .ok;
          } catch {
            return false;
          }
        });
        await syncDeploymentLayer({
          config: ctx.config,
          configDir: ctx.configDir,
          sandboxDir: ctx.sandboxDir,
          transport: renderDeploymentLayerTransport,
          ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
        });
        const release: Record<string, string> = {};
        for (const workload of desired.filter((item) => !item.diskSizeGB)) {
          const service = services.get(workload.name)!;
          const current = (
            await requestArray<{ deploy: RenderDeploy }>(request, `/services/${service.id}/deploys?limit=1`)
          )[0]?.deploy;
          if (!current || current.status !== "live") throw new CliError(`${workload.name} has no live deployment`);
          release[workload.name] = current.id;
        }
        state.previousRelease = state.release;
        state.previousReleaseWorkflowTaskId = state.releaseWorkflowTaskId;
        state.releaseWorkflowTaskId = state.workflowTaskId;
        state.previousReleaseCommit = state.releaseCommit;
        state.releaseCommit = state.sourceCommit;
        state.release = release;
        delete state.updateInProgress;
        saveState(ctx, state);
        const retained = Object.keys(state.services).filter((name) => !desired.some((item) => item.name === name));
        if (retained.length)
          note(
            `Retained services outside the current config: ${retained.join(", ")}. Remove them in Render when their data is no longer needed`,
          );
        note(`QM: ${urls.publicUrl}`);
        note(`Core API: ${urls.apiUrl}`);
      });
    },
    status: async () => {
      const request = api(ctx);
      const state = readState(ctx);
      const bound = await inventory(ctx, request, state, state.pendingPurge);
      note(
        `project: ${state.projectId}, production: ${state.environmentId}${state.pendingPurge ? " (cleanup pending)" : ""}`,
      );
      if (bound.workflow) note(`workflow: ${bound.workflow.slug} (${bound.workflow.id})`);
      if (bound.postgres) note(`postgres: ${bound.postgres.status} (${bound.postgres.id})`);
      for (const [name, service] of bound.services) {
        const recent = await requestArray<{ deploy: { status: string } }>(
          request,
          `/services/${service.id}/deploys?limit=1`,
        );
        note(
          `${name}: ${service.suspended}, ${recent[0]?.deploy.status ?? "no deploy"} (${service.id}) ${service.serviceDetails.url}`,
        );
      }
    },
    logs: async (service, opts) => {
      const request = api(ctx);
      const bound = await inventory(ctx, request, readState(ctx));
      const host = service ? serviceHost(service) : undefined;
      const ids = host
        ? [bound.services.get(host)?.id].filter((id): id is string => Boolean(id))
        : [...bound.services.values()].map((item) => item.id);
      if (!ids.length) throw new CliError(`No Render service exists${host ? ` for ${host}` : ""}`);
      const resources = { workspaceId: coordinates(ctx.config).workspaceId };
      const seen = new Set<string>();
      let start = "";
      let initial = true;
      do {
        const entries = new Map<string, { id: string; timestamp: string; message: string }>();
        const count = initial ? (opts.tail ?? 100) : Infinity;
        let pageStart = start || "1970-01-01T00:00:00.000Z";
        let pageEnd = new Date().toISOString();
        const windowEnd = pageEnd;
        while (entries.size < count) {
          const query = new URLSearchParams({
            ownerId: resources.workspaceId,
            limit: String(Math.min(count - entries.size, 100)),
            direction: initial ? "backward" : "forward",
            startTime: pageStart,
            endTime: pageEnd,
          });
          for (const id of ids) query.append("resource", id);
          const result = await request<{
            logs: Array<{ id: string; timestamp: string; message: string }>;
            hasMore: boolean;
            nextStartTime: string;
            nextEndTime: string;
          }>(`/logs?${query}`);
          for (const log of result.logs) entries.set(log.id, log);
          if (!result.hasMore || entries.size >= count) break;
          if (
            !result.nextStartTime ||
            !result.nextEndTime ||
            (result.nextStartTime === pageStart && result.nextEndTime === pageEnd)
          )
            throw new CliError("Render log pagination did not advance");
          pageStart = result.nextStartTime;
          pageEnd = result.nextEndTime;
        }
        const logs = [...entries.values()];
        if (initial) logs.reverse();
        for (const log of logs) {
          if (!seen.has(log.id)) note(`${log.timestamp} ${log.message}`);
          seen.add(log.id);
          start = log.timestamp;
        }
        if (!start) start = windowEnd;
        initial = false;
        if (seen.size > 10_000) {
          const keep = [...seen].slice(-1000);
          seen.clear();
          for (const id of keep) seen.add(id);
        }
        if (opts.follow) await sleep(2_000);
      } while (opts.follow);
    },
    down: async (opts) =>
      locked(ctx, async () => {
        const request = api(ctx);
        const state = readState(ctx);
        await recoverPendingCreate(ctx, request, state);
        if (state.pendingPurge && !opts.purge) throw new CliError("Render cleanup is incomplete; run qm down --purge");
        const bound = await inventory(ctx, request, state, !!opts.purge);
        const hosted = await list<RenderService>(
          request,
          `/services?${new URLSearchParams({ ownerId: state.workspaceId })}`,
          "service",
        );
        const owned = new Set(Object.values(state.services).map((service) => service.id));
        const environments = new Set(bound.environmentIds);
        for (const service of hosted) {
          if (
            owned.has(service.id) ||
            service.ownerId !== state.workspaceId ||
            !environments.has(service.environmentId) ||
            !["web_service", "private_service"].includes(service.type) ||
            (!opts.purge && service.suspended === "suspended")
          )
            continue;
          const env = await envVars(request, service.id);
          if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(env.QM_DEPLOYMENT_ID ?? ""))
            throw new CliError(
              opts.purge
                ? "Published apps still use this deployment's database and object storage. Back up app data and delete their Render services before qm down --purge"
                : "Published apps still use this deployment. Archive or stop them before qm down",
            );
        }
        if (opts.purge) {
          state.pendingPurge = true;
          saveState(ctx, state);
        }
        const order = Object.entries(state.services).sort(([a], [b]) => Number(a === "minio") - Number(b === "minio"));
        for (const [name, saved] of order) {
          const service = bound.services.get(name);
          if (opts.purge) {
            if (service) await request(`/services/${saved.id}`, "DELETE");
            delete state.services[name];
            if (state.bootstrapServices) delete state.bootstrapServices[name];
            saveState(ctx, state);
            ok(`${name}: deleted`);
          } else if (service && service.suspended !== "suspended") {
            await request(`/services/${saved.id}/suspend`, "POST");
            ok(`${name}: suspended`);
          }
        }
        if (opts.purge) {
          if (bound.workflow) await request(`/workflows/${bound.workflow.id}`, "DELETE");
          delete state.workflowId;
          delete state.workflowSlug;
          delete state.workflowTaskId;
          delete state.workflowBootstrap;
          if (bound.postgres) await request(`/postgres/${bound.postgres.id}`, "DELETE");
          delete state.postgresId;
          delete state.bootstrapServices;
          delete state.pendingPurge;
          delete state.dirtyServices;
          saveState(ctx, state);
          note(
            "QM services, Postgres, and the MinIO disk are deleted. The project and production environment are retained for future deployment",
          );
        } else note("Postgres, persistent disks, and stored objects are retained. Storage charges continue");
      }),
    rollback: async (to) =>
      locked(ctx, async () => {
        if (to) throw new CliError("Render rollback uses the last successful deployment; omit --to");
        const request = api(ctx);
        const state = readState(ctx);
        if (!state.rollbackProgress) {
          const interruptedUpdate = state.updateInProgress === true;
          const services = interruptedUpdate ? state.release : state.previousRelease;
          const commit = interruptedUpdate ? state.releaseCommit : state.previousReleaseCommit;
          const taskId = interruptedUpdate ? state.releaseWorkflowTaskId : state.previousReleaseWorkflowTaskId;
          if (!services || !Object.keys(services).length || !commit || !taskId)
            throw new CliError("No successful Render deployment is recorded for rollback");
          state.rollbackProgress = { services, commit, taskId, interruptedUpdate, restored: {} };
        }
        const target = state.rollbackProgress;
        const bound = await inventory(ctx, request, state);
        for (const [name, deployId] of Object.entries(target.services)) {
          const service = bound.services.get(name);
          if (!service || service.serviceDetails.disk)
            throw new CliError(`The rollback service ${name} is missing or has a disk`);
          await request(`/services/${service.id}/deploys/${deployId}`);
        }
        const core = bound.services.get("core");
        if (!core) throw new CliError("The core service is missing");
        saveState(ctx, state);
        await request(`/services/${core.id}/env-vars/RENDER_WORKFLOW_TASK_ID`, "PUT", { value: target.taskId });
        for (const serviceId of [core.id, state.workflowId].filter((id): id is string => Boolean(id))) {
          for (const key of ["RENDER_DEPLOY_COMMIT", "GIT_SHA"])
            await request(`/services/${serviceId}/env-vars/${key}`, "PUT", { value: target.commit });
        }
        for (const [name, deployId] of Object.entries(target.services)) {
          if (target.restored[name]) continue;
          const service = bound.services.get(name)!;
          const deploy = await request<RenderDeploy>(`/services/${service.id}/rollback`, "POST", { deployId });
          await waitDeploy(request, service, deploy.id, undefined, target.commit);
          target.restored[name] = deploy.id;
          saveState(ctx, state);
        }
        if (!target.interruptedUpdate) {
          state.previousRelease = state.release;
          state.previousReleaseCommit = state.releaseCommit;
          state.previousReleaseWorkflowTaskId = state.releaseWorkflowTaskId;
        }
        state.release = target.restored;
        state.releaseCommit = target.commit;
        state.sourceCommit = target.commit;
        state.releaseWorkflowTaskId = target.taskId;
        state.workflowTaskId = target.taskId;
        state.dirtyServices = state.dirtyServices?.filter((name) => !target.services[name]);
        delete state.updateInProgress;
        delete state.rollbackProgress;
        saveState(ctx, state);
        note("Previous Render builds restored. Postgres and object data are retained; migrations are not reversed");
      }),
    doctor: async () => {
      const values = credentialValues(ctx);
      await doctorCommon(ctx.config, values, { requiredSecretValues: true, configDir: ctx.configDir });
      const render = coordinates(ctx.config);
      const request = api(ctx);
      await request(`/owners/${render.workspaceId}`);
      workloads(ctx);
      if (existsSync(statePath(ctx))) await inventory(ctx, request, readState(ctx));
      ok(`Render workspace: ${render.workspaceId}`);
    },
    secretsPush: async (envFile) =>
      locked(ctx, async () => {
        const request = api(ctx, envFile);
        const state = readState(ctx);
        if (state.pendingPurge) throw new CliError("Render cleanup is incomplete; run qm down --purge");
        const bound = await inventory(ctx, request, state);
        const values = credentialValues(ctx, envFile);
        requireSecrets(ctx, values);
        const plugins = ctx.config.plugins.filter((item) => item.coreAccess !== false).map((item) => item.name);
        for (const workload of renderWorkloads(ctx.config, ctx.configDir)) {
          const service = bound.services.get(workload.name);
          if (!service) throw new CliError(`No Render service exists for ${workload.name}; run qm up`);
          let changed = false;
          for (const secret of computedSecrets(ctx.config)) {
            if (secret.managedBy !== "operator") continue;
            const value = values.get(secret.name);
            if (value === undefined) continue;
            for (const key of runtimeSecretNames(workload.name, secret, plugins)) {
              state.dirtyServices = [...new Set([...(state.dirtyServices ?? []), workload.name])];
              saveState(ctx, state);
              await request(`/services/${service.id}/env-vars/${encodeURIComponent(key)}`, "PUT", { value });
              changed = true;
            }
          }
          if (changed) ok(`${workload.name}: secrets saved`);
        }
        note("Run qm up to deploy the saved secrets");
      }),
    checkLive: async (opts) => {
      const report = opts?.report ?? true;
      const request = api(ctx);
      const state = readState(ctx);
      const bound = await inventory(ctx, request, state);
      const core = bound.services.get("core");
      const web = bound.services.get(ctx.config.services.includes("portal") ? "portal" : "web-ui");
      if (!core || !web) throw new CliError("The Render deployment has no core or web service; run qm up");
      if (ctx.config.apiUrl !== publicUrl(core) || ctx.config.publicUrl !== publicUrl(web))
        throw new CliError("Configured Render URLs do not match the owned services; run qm up");
      for (const [name, url] of [
        ["core", ctx.config.apiUrl],
        ["web", ctx.config.publicUrl],
      ]) {
        const response = await fetch(`${url}/healthz`, {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
        if (!response.ok) throw new CliError(`${name} health check failed (HTTP ${response.status})`);
        if (report) ok(`${name}: healthy`);
      }
      const layer = await deploymentLayerRequest({
        config: ctx.config,
        configDir: ctx.configDir,
        method: "GET",
        transport: renderDeploymentLayerTransport,
        ...(ctx.envFile ? { envFile: ctx.envFile } : {}),
      });
      if (layer.status !== 200) throw new CliError(`Core deployment layer check failed (HTTP ${layer.status})`);
      if (report) ok("core: signed deployment layer access works");
      await liveSession(request, core, state.workspaceId, report);
    },
  };
}
