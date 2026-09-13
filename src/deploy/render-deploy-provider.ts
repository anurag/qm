import { Agent, fetch as undiciFetch } from "undici";
import { BlockList, isIP } from "node:net";
import type { RenderDeployArtifactAccess } from "./render-deploy-artifacts.ts";
import { LRUCache } from "lru-cache";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallow } from "../util/errors.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createRenderDeployGateways, type StoredRenderGateway } from "./render-deploy-gateways.ts";
import type { ScopeId } from "../types.ts";

const API_URL = "https://api.render.com/v1";
const APP_PORT = 8080;
const OWNER_MARKER = "QM_DEPLOYMENT_ID";
const ARTIFACT_FILE = "qm-render-artifact.json";
const FAILED_DEPLOYS = new Set(["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"]);

class RenderRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;

  constructor(message: string, status: number, retryAfterMs: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

interface RenderService {
  id: string;
  name: string;
  ownerId: string;
  type: string;
  suspended: string;
  environmentId?: string;
  serviceDetails: {
    url?: string;
    region?: string;
    numInstances?: number;
    disk?: { mountPath: string; sizeGB: number };
  };
}

interface RenderDeploy {
  id: string;
  status?: string;
}

interface RenderServicePage {
  service: RenderService;
  cursor: string;
}

interface RenderDeployPage {
  deploy: RenderDeploy;
  cursor?: string;
}

export interface StoredRenderDeploy {
  deploymentId: string;
  ownerScopeId: ScopeId;
  environmentId: string;
  transfer?: { ownerScopeId: ScopeId; environmentId: string };
  version: number;
  status: "pending" | "live" | "failed" | "suspending" | "suspended";
  createdService: boolean;
  previousDeployIds: string[];
  serviceId?: string;
  deployId?: string;
  liveVersion?: number;
}

export interface RenderDeployProviderOptions {
  apiKey: string;
  workspaceId: string;
  projectId: string;
  postgresId: string;
  baseImage?: string;
  source?: { repo: string; branch: string };
  region?: string;
  environmentId?: string;
  plan?: string;
  appPrefix?: string;
  registryCredentialId?: string;
  store: DurableMap<StoredRenderDeploy>;
  gatewayStore: DurableMap<StoredRenderGateway>;
  artifacts: {
    prepare(deployment: Deployment, version: DeploymentVersion): Promise<RenderDeployArtifactAccess>;
    revoke(deploymentId: string): Promise<void>;
  };
  deployTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  advisoryLock?: AdvisoryLock;
}

export function createRenderDeployProvider(opts: RenderDeployProviderOptions): DeployProvider {
  const fetchImpl = (opts.fetchImpl ?? undiciFetch) as typeof undiciFetch;
  const prefix = opts.appPrefix ?? "qm-app";
  const region = opts.region ?? "oregon";
  const timeoutMs = opts.deployTimeoutMs ?? 600_000;
  const pollMs = opts.pollIntervalMs ?? 2_000;
  const resolveCache = new LRUCache<string, DeployEndpoint>({ max: 500, ttl: 30_000 });
  const inflightResolves = new Map<string, Promise<DeployEndpoint | null>>();
  const queue = createKeyedQueue<string>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const gateways = createRenderDeployGateways({
    request,
    workspaceId: opts.workspaceId,
    projectId: opts.projectId,
    region,
    prefix,
    store: opts.gatewayStore,
    timeoutMs,
    pollMs,
    fetchImpl: fetchImpl as typeof fetch,
  });
  const invalidate = (id: string): void => {
    resolveCache.delete(id);
    inflightResolves.delete(id);
  };
  const withOwners = <T>(owners: string[], fn: () => Promise<T>): Promise<T> => {
    const [owner, ...rest] = [...new Set(owners)].sort();
    return owner === undefined
      ? fn()
      : queue(owner, () => advisoryLock.withLock(`render-deploy-owner:${owner}`, () => withOwners(rest, fn)));
  };
  const serialized = <T>(deployment: Deployment, fn: () => Promise<T>, toScope?: ScopeId): Promise<T> =>
    withOwners([deployment.ownerScopeId, ...(toScope ? [toScope] : [])], async () => {
      invalidate(deployment.id);
      try {
        return await fn();
      } finally {
        invalidate(deployment.id);
      }
    });

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    allowMissing = false,
    deadline = Date.now() + 30_000,
  ): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetchImpl(`${API_URL}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
        });
        if (allowMissing && response.status === 404) return null;
        if (!response.ok) {
          await response.body?.cancel();
          const retryAfter = response.headers.get("retry-after");
          let retryAfterMs = 0;
          if (retryAfter !== null) {
            retryAfterMs = /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Math.max(0, Date.parse(retryAfter) - Date.now());
          }
          throw new RenderRequestError(
            `Render ${method} ${path}: HTTP ${response.status}`,
            response.status,
            retryAfterMs,
          );
        }
        const text = await response.text();
        return text ? (JSON.parse(text) as T) : null;
      } catch (error) {
        const retryable =
          error instanceof RenderRequestError
            ? error.status === 429 || error.status >= 500
            : error instanceof TypeError ||
              (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
        if (method !== "GET" || !retryable || Date.now() >= deadline) throw error;
        const backoff = Math.min(10_000, Math.max(1, pollMs) * 2 ** Math.min(attempt, 4));
        const retryAfterMs = error instanceof RenderRequestError ? error.retryAfterMs : 0;
        await sleep(Math.min(deadline - Date.now(), Math.max(backoff, retryAfterMs || 0)));
        if (Date.now() >= deadline) throw error;
      }
    }
  }

  function ensureConfigured(): void {
    if (!opts.apiKey) throw new Error("RENDER_API_KEY is required for DEPLOY_PROVIDER=render");
    if (!opts.workspaceId) throw new Error("RENDER_WORKSPACE_ID is required for DEPLOY_PROVIDER=render");
    if (!/^prj-[a-z0-9]+$/.test(opts.projectId)) throw new Error("RENDER_PROJECT_ID must be a project ID (prj-...)");
    if (!/^dpg-[a-z0-9]+(?:-a)?$/.test(opts.postgresId))
      throw new Error("RENDER_POSTGRES_ID must be a PostgreSQL ID (dpg-...)");
    if (!opts.baseImage && !opts.source)
      throw new Error(
        "RENDER_DEPLOY_IMAGE or RENDER_DEPLOY_REPO and RENDER_DEPLOY_BRANCH are required for DEPLOY_PROVIDER=render",
      );
    if (opts.source && (!opts.source.repo || !opts.source.branch))
      throw new Error("RENDER_DEPLOY_REPO and RENDER_DEPLOY_BRANCH must be set together");
    if (opts.baseImage && opts.source)
      throw new Error("Set RENDER_DEPLOY_IMAGE or RENDER_DEPLOY_REPO and RENDER_DEPLOY_BRANCH, not both");
    if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(prefix)) {
      throw new Error("RENDER_DEPLOY_APP_PREFIX must be a lowercase DNS label with at most 20 characters");
    }
  }

  const pathOf = (service: RenderService): string => `/services/${encodeURIComponent(service.id)}`;
  const nameOf = (deployment: Deployment): string => `${prefix}-${deployment.id}`;

  async function ownedService(
    service: RenderService,
    deployment: Deployment,
    deadline?: number,
  ): Promise<RenderService> {
    const record = await opts.store.get(deployment.id);
    if (record && record.ownerScopeId !== deployment.ownerScopeId)
      throw new Error(`Render app ${deployment.id} belongs to another ownership scope`);
    if (record?.transfer) throw new Error(`Render app ${deployment.id} has an incomplete ownership transfer`);
    const environmentId =
      record?.environmentId ?? (await opts.gatewayStore.get(deployment.ownerScopeId))?.environmentId;
    if (
      service.name !== nameOf(deployment) ||
      service.ownerId !== opts.workspaceId ||
      service.type !== "private_service" ||
      service.serviceDetails.region !== region ||
      !environmentId ||
      service.environmentId !== environmentId
    )
      throw new Error(`Render service ${service.name} is not the expected private app service in ${region}`);
    if (service.serviceDetails.disk || service.serviceDetails.numInstances !== 1)
      throw new Error(`Render app ${service.id} must use one instance without a persistent disk`);
    const marker = await request<{ value: string }>(
      "GET",
      `${pathOf(service)}/env-vars/${OWNER_MARKER}`,
      undefined,
      true,
      deadline,
    );
    if (marker?.value !== deployment.id)
      throw new Error(`Render service ${service.name} belongs to another deployment`);
    return service;
  }

  async function findService(
    deployment: Deployment,
    deadline?: number,
    serviceId?: string,
  ): Promise<RenderService | null> {
    if (serviceId) {
      const service = await request<RenderService>(
        "GET",
        `/services/${encodeURIComponent(serviceId)}`,
        undefined,
        true,
        deadline,
      );
      return service ? ownedService(service, deployment, deadline) : null;
    }
    const name = nameOf(deployment);
    let cursor = "";
    for (;;) {
      const query = new URLSearchParams({
        name,
        ownerId: opts.workspaceId,
        limit: "100",
        ...(cursor ? { cursor } : {}),
      });
      const page = (await request<RenderServicePage[]>("GET", `/services?${query}`, undefined, false, deadline)) ?? [];
      const found = page.find(({ service }) => service.name === name && service.ownerId === opts.workspaceId)?.service;
      if (found) return ownedService(found, deployment, deadline);
      const nextCursor = page.at(-1)?.cursor;
      if (page.length < 100 || !nextCursor || nextCursor === cursor) return null;
      cursor = nextCursor;
    }
  }

  function endpointOf(service: RenderService): DeployEndpoint {
    const address = service.serviceDetails.url;
    if (!address) throw new Error(`Render service ${service.id} has no private address`);
    const url = new URL(address.includes("://") ? address : `http://${address}`);
    if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`Render service ${service.id} returned an invalid private address`);
    }
    return { host: url.hostname, port: APP_PORT, proxyHeaders: { connection: "close" } };
  }

  async function listDeploys(service: RenderService, deadline = Date.now() + 30_000): Promise<RenderDeploy[]> {
    const deploys: RenderDeploy[] = [];
    const cursors = new Set<string>();
    let cursor = "";
    for (;;) {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page =
        (await request<RenderDeployPage[]>("GET", `${pathOf(service)}/deploys?${query}`, undefined, false, deadline)) ??
        [];
      deploys.push(...page.map(({ deploy }) => deploy));
      if (page.length < 100) return deploys;
      if (Date.now() >= deadline) throw new Error(`Render deploy history for ${service.id} exceeded the deadline`);
      const next = page.at(-1)?.cursor;
      if (typeof next !== "string" || !next || cursors.has(next))
        throw new Error(`Render deploy history for ${service.id} returned an invalid pagination cursor`);
      cursors.add(next);
      cursor = next;
    }
  }

  async function waitForIdle(service: RenderService): Promise<RenderDeploy[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const deploys = await listDeploys(service, deadline);
      const pending = deploys.find((deploy) => deploy.status !== "live" && !FAILED_DEPLOYS.has(deploy.status ?? ""));
      if (!pending) return deploys;
      if (Date.now() >= deadline)
        throw new Error(`Render deploy ${pending.id} is still ${pending.status ?? "pending"}; retry after it finishes`);
      await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
    }
  }

  function pendingError(record: StoredRenderDeploy, cause?: unknown): Error {
    const recovery = record.deployId
      ? "retry to reconcile it"
      : "operator recovery is required if no matching Render operation appears";
    return new Error(
      `Render deployment ${record.deploymentId} version ${record.version} is still pending; ${recovery}${cause instanceof Error ? `: ${cause.message}` : ""}`,
      { cause },
    );
  }

  async function save(record: StoredRenderDeploy): Promise<void> {
    await opts.store.put(record.deploymentId, record);
  }

  async function unconfirmed(deployment: Deployment): Promise<boolean> {
    const record = await opts.store.get(deployment.id);
    if (record?.transfer || (record && record.ownerScopeId !== deployment.ownerScopeId))
      throw new Error(`Render app ${deployment.id} has an incomplete ownership transfer`);
    return (
      record !== null &&
      ((record.status === "pending" && record.liveVersion === undefined) ||
        record.status === "suspending" ||
        record.status === "suspended" ||
        (record.liveVersion !== undefined && record.liveVersion !== deployment.appliedVersion))
    );
  }

  async function recoverRejectedCreate(
    deployment: Deployment,
    record: StoredRenderDeploy,
  ): Promise<StoredRenderDeploy | null> {
    if (record.status !== "failed" || !record.createdService || record.serviceId) return record;
    const found = await findService(deployment);
    if (found) return { ...record, serviceId: found.id };
    await opts.artifacts.revoke(deployment.id);
    await opts.store.delete(deployment.id);
    return null;
  }

  async function suspendService(deployment: Deployment, record: StoredRenderDeploy): Promise<void> {
    let pending: StoredRenderDeploy = { ...record, status: "suspending" };
    await save(pending);
    try {
      let service = await findService(deployment, undefined, pending.serviceId);
      if (!service) throw new Error("The retained Render app service is missing; restore the service before retrying");
      pending = { ...pending, serviceId: service.id };
      await save(pending);
      if (service.suspended !== "suspended") await request("POST", `${pathOf(service)}/suspend`);
      const deadline = Date.now() + timeoutMs;
      while (service.suspended !== "suspended") {
        if (Date.now() >= deadline) throw new Error("Render app suspension was not confirmed before the deadline");
        service = await findService(deployment, deadline, pending.serviceId);
        if (!service) throw new Error("The retained Render app service is missing");
        if (service.suspended !== "suspended") await sleep(Math.max(1, pollMs));
      }
      await opts.artifacts.revoke(deployment.id);
      await gateways.remove(deployment.ownerScopeId, deployment.id);
      await save({ ...pending, status: "suspended", createdService: false });
    } catch (error) {
      throw pendingError(pending, error);
    }
  }

  async function allowDatabaseAccess(service: RenderService): Promise<void> {
    const range = (value: string, allowAll = false) => {
      if (typeof value !== "string") throw new Error("Render returned an invalid outbound IP range");
      const [address, mask, ...extra] = value.split("/");
      const version = isIP(address!);
      const maxPrefix = version === 4 ? 32 : 128;
      const prefix = mask === undefined ? maxPrefix : Number(mask);
      if (
        !version ||
        address!.includes("%") ||
        extra.length ||
        (mask !== undefined && !/^\d+$/.test(mask)) ||
        !Number.isInteger(prefix) ||
        prefix < (allowAll ? 0 : 1) ||
        prefix > maxPrefix
      )
        throw new Error("Render returned an invalid outbound IP range");
      const family = version === 4 ? ("ipv4" as const) : ("ipv6" as const);
      const block = new BlockList();
      block.addSubnet(address!, prefix, family);
      return { cidrBlock: `${address}/${prefix}`, address: address!, prefix, family, block };
    };
    const same = (a: ReturnType<typeof range>, b: ReturnType<typeof range>) =>
      a.prefix === b.prefix && a.family === b.family && a.block.check(b.address, b.family);
    const outbound = await request<{ ips: string[] }>("GET", `${pathOf(service)}/outbound-ips`);
    if (!Array.isArray(outbound?.ips) || !outbound.ips.length)
      throw new Error("Render app outbound IP ranges are unavailable");
    const reported = outbound.ips.map((ip) => range(ip));
    const required = reported.filter((value, index) => !reported.slice(0, index).some((prior) => same(value, prior)));
    const path = `/postgres/${encodeURIComponent(opts.postgresId)}`;
    const read = async () => {
      const database = await request<{
        id: string;
        owner: { id: string };
        region: string;
        environmentId?: string;
        ipAllowList: Array<{ cidrBlock: string; description: string }>;
      }>("GET", path);
      if (
        database?.id !== opts.postgresId ||
        database.owner?.id !== opts.workspaceId ||
        database.region !== region ||
        !database.environmentId ||
        !Array.isArray(database.ipAllowList)
      )
        throw new Error("Render app database does not match the configured workspace and region");
      const environment = await request<{ id: string; projectId: string }>(
        "GET",
        `/environments/${encodeURIComponent(database.environmentId)}`,
      );
      if (environment?.id !== database.environmentId || environment.projectId !== opts.projectId)
        throw new Error("Render app database belongs to another project");
      return database.ipAllowList;
    };
    const missing = (rules: Array<{ cidrBlock: string }>) => {
      const existing = rules.map((rule) => range(rule.cidrBlock, true));
      return required.filter((wanted) => !existing.some((current) => same(wanted, current)));
    };
    if (!missing(await read()).length) return;
    await advisoryLock.withLock(`render-app-database-network:${opts.postgresId}`, async () => {
      const current = await read();
      const additions = missing(current);
      if (!additions.length) return;
      const ipAllowList = [
        ...current,
        ...additions.map(({ cidrBlock }) => ({ cidrBlock, description: "QM Render app outbound IP range" })),
      ];
      if (ipAllowList.length > 600) throw new Error("Render app database IP allowlist is full");
      await request("PATCH", path, { ipAllowList });
      if (missing(await read()).length) throw new Error("Render app database network access is not confirmed");
    });
  }

  async function waitLive(deployment: Deployment, initial: StoredRenderDeploy): Promise<RenderService> {
    const deadline = Date.now() + timeoutMs;
    let record = initial;
    let service: RenderService | null = null;
    let status: string | undefined;
    let databaseReady = false;
    const previous = new Set(record.previousDeployIds);
    const finish = async (deploy: RenderDeploy): Promise<boolean> => {
      status = deploy.status;
      if (status !== "live" && !FAILED_DEPLOYS.has(status ?? "")) return false;
      if (status === "live") {
        const endpoint = await gateways.upsert(deployment.ownerScopeId, deployment.id, endpointOf(service!));
        const dispatcher = new Agent({ pipelining: 0 });
        try {
          const requestOptions = {
            headers: endpoint.proxyHeaders,
            redirect: "manual" as const,
            signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))),
            dispatcher,
          };
          const response = await fetchImpl(`https://${endpoint.host}:${endpoint.port}/`, requestOptions);
          await response.body?.cancel();
          if (response.status < 200 || response.status >= 500) return false;
        } catch {
          return false;
        } finally {
          await dispatcher.destroy();
        }
      }
      record = { ...record, status: status === "live" ? "live" : "failed", deployId: deploy.id };
      if (status === "live") {
        record.liveVersion = record.version;
        record.createdService = false;
      }
      await save(record);
      return true;
    };
    try {
      while (Date.now() < deadline) {
        if (!service) {
          service = await findService(deployment, deadline, record.serviceId);
          if (service) {
            if (record.serviceId && record.serviceId !== service.id)
              throw new Error(`Render service identity changed for deployment ${deployment.id}`);
            record = { ...record, serviceId: service.id };
            await save(record);
            await allowDatabaseAccess(service);
            databaseReady = true;
          }
        }
        if (service && !record.deployId) {
          const deploy = (await listDeploys(service, deadline)).find((candidate) => !previous.has(candidate.id));
          if (deploy) {
            record = { ...record, deployId: deploy.id };
            await save(record);
          }
        }
        if (service && record.deployId) {
          const deploy = await request<RenderDeploy>(
            "GET",
            `${pathOf(service)}/deploys/${encodeURIComponent(record.deployId)}`,
            undefined,
            false,
            deadline,
          );
          if (deploy && (await finish(deploy))) {
            if (record.status === "live") return service;
            throw new Error(`Render deploy ${record.deployId} ended with status ${status}`);
          }
        }
        await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
      }
      throw new Error(
        status === "live"
          ? `Render app did not accept HTTP on port ${APP_PORT} within ${Math.round(timeoutMs / 1000)}s`
          : `Render deploy ${record.deployId ?? "queued"} did not become live within ${Math.round(timeoutMs / 1000)}s`,
      );
    } catch (error) {
      if (service && !databaseReady) throw pendingError(record, error);
      if (record.status === "pending" && service && record.deployId) {
        const deployPath = `${pathOf(service)}/deploys/${encodeURIComponent(record.deployId)}`;
        const canceled = await request<RenderDeploy>("POST", `${deployPath}/cancel`).catch((cancelError) => {
          swallow("render-deploy: cancel incomplete deploy", cancelError);
          return null;
        });
        const current = canceled?.status
          ? canceled
          : await request<RenderDeploy>("GET", deployPath).catch((readError) => {
              swallow("render-deploy: read incomplete deploy", readError);
              return null;
            });
        if (current && (await finish(current)) && current.status === "live") return service;
      }
      if (record.status === "failed") {
        if (record.createdService) await suspendService(deployment, record);
        throw error;
      }
      throw pendingError(record, error);
    }
  }

  return {
    profile: { managedScaleToZero: false, storage: { database: "postgres", files: "signed-urls" } },
    apply: (deployment, version) =>
      serialized(deployment, async () => {
        ensureConfigured();
        const { environmentId } = await gateways.ensure(deployment.ownerScopeId);
        let previous = await opts.store.get(deployment.id);
        if (previous) previous = await recoverRejectedCreate(deployment, previous);
        if ((previous?.status === "failed" && previous.createdService) || previous?.status === "suspending") {
          await suspendService(deployment, previous);
          previous = await opts.store.get(deployment.id);
        }
        if (previous?.status === "pending") {
          const recovered = await waitLive(deployment, previous);
          if (previous.version === version.version)
            return gateways.upsert(deployment.ownerScopeId, deployment.id, endpointOf(recovered));
          previous = await opts.store.get(deployment.id);
        }
        let service = await findService(deployment, undefined, previous?.serviceId);
        if (!service && previous?.serviceId)
          throw new Error("The retained Render app service is missing; restore the service before retrying");
        if (service && previous?.serviceId && service.id !== previous.serviceId)
          throw new Error(`Render service identity changed for deployment ${deployment.id}`);
        if (
          service &&
          service.suspended !== "suspended" &&
          previous?.status === "live" &&
          previous.version === version.version &&
          deployment.appliedVersion !== previous.version
        )
          return gateways.upsert(deployment.ownerScopeId, deployment.id, endpointOf(service));
        if (service) await waitForIdle(service);
        if (service) await allowDatabaseAccess(service);
        const artifact = await opts.artifacts.prepare(deployment, version);
        const env = { ...version.env, ...artifact.runtimeEnv, PORT: String(APP_PORT), [OWNER_MARKER]: deployment.id };
        const envVars = Object.entries(env).map(([key, value]) => ({ key, value }));
        const secretFiles = [{ name: ARTIFACT_FILE, content: JSON.stringify(artifact) }];
        const source = opts.source
          ? { repo: opts.source.repo, branch: opts.source.branch, rootDir: "" }
          : {
              image: {
                ownerId: opts.workspaceId,
                imagePath: opts.baseImage,
                ...(opts.registryCredentialId ? { registryCredentialId: opts.registryCredentialId } : {}),
              },
            };
        const runtime = opts.source
          ? {
              runtime: "docker",
              envSpecificDetails: {
                dockerContext: ".",
                dockerfilePath: "deploy/render-runner/Dockerfile",
                dockerCommand: "",
              },
            }
          : { runtime: "image" };
        if (service) {
          await request("PUT", `${pathOf(service)}/env-vars`, envVars);
          await request("PUT", `${pathOf(service)}/secret-files`, secretFiles);
          await request("PATCH", pathOf(service), {
            autoDeploy: "no",
            ...source,
            serviceDetails: { ...runtime, maxShutdownDelaySeconds: 300 },
          });
        }
        const previousDeployIds = service ? (await waitForIdle(service)).map((deploy) => deploy.id) : [];
        const liveVersion = previous?.liveVersion ?? deployment.appliedVersion;
        let record: StoredRenderDeploy = {
          deploymentId: deployment.id,
          ownerScopeId: deployment.ownerScopeId,
          environmentId,
          version: version.version,
          status: "pending",
          createdService: !service,
          previousDeployIds,
          ...(service ? { serviceId: service.id } : {}),
          ...(liveVersion === undefined ? {} : { liveVersion }),
        };
        await save(record);
        try {
          if (!service) {
            const created = await request<{ service?: RenderService; deployId?: string }>("POST", "/services", {
              type: "private_service",
              name: nameOf(deployment),
              ownerId: opts.workspaceId,
              environmentId,
              autoDeploy: "no",
              ...source,
              envVars,
              secretFiles,
              serviceDetails: {
                ...runtime,
                plan: opts.plan ?? "0.5c-512mb",
                region,
                numInstances: 1,
                maxShutdownDelaySeconds: 300,
              },
            });
            service = created?.service ?? null;
            record = {
              ...record,
              ...(service ? { serviceId: service.id } : {}),
              ...(created?.deployId ? { deployId: created.deployId } : {}),
            };
          } else if (service.suspended === "suspended") {
            await request("POST", `${pathOf(service)}/resume`);
          } else {
            const deploy = await request<RenderDeploy>("POST", `${pathOf(service)}/deploys`, {});
            if (deploy?.id) record = { ...record, deployId: deploy.id };
          }
          await save(record);
        } catch (error) {
          if (error instanceof RenderRequestError && error.status < 500) {
            await save({ ...record, status: "failed" });
            if (record.createdService) {
              await opts.artifacts.revoke(deployment.id);
              await opts.store.delete(deployment.id);
            }
            throw error;
          }
          swallow("render-deploy: reconcile uncertain request", error);
        }
        return gateways.upsert(deployment.ownerScopeId, deployment.id, endpointOf(await waitLive(deployment, record)));
      }),
    async resolveEndpoint(deployment) {
      ensureConfigured();
      if (deployment.status === "archived" || (await unconfirmed(deployment))) return null;
      const cached = resolveCache.get(deployment.id);
      if (cached) return cached;
      const inflight = inflightResolves.get(deployment.id);
      if (inflight) return inflight;
      const resolve = (async () => {
        const record = await opts.store.get(deployment.id);
        const service = await findService(deployment, undefined, record?.serviceId);
        if (!service || service.suspended === "suspended") return null;
        const deploys = await request<RenderDeployPage[]>("GET", `${pathOf(service)}/deploys?status=live&limit=1`);
        return deploys?.some(({ deploy }) => deploy.status === "live")
          ? gateways.endpoint(deployment.ownerScopeId, deployment.id)
          : null;
      })()
        .then(async (endpoint) => {
          if (await unconfirmed(deployment)) return null;
          if (endpoint && inflightResolves.get(deployment.id) === resolve) resolveCache.set(deployment.id, endpoint);
          return endpoint;
        })
        .finally(() => {
          if (inflightResolves.get(deployment.id) === resolve) inflightResolves.delete(deployment.id);
        });
      inflightResolves.set(deployment.id, resolve);
      return resolve;
    },
    async logs(deployment, logOpts) {
      ensureConfigured();
      const service = await findService(deployment);
      if (!service) return null;
      const limit = Math.max(1, Math.min(2000, Math.floor(logOpts.tailLines)));
      const messages: string[] = [];
      let startTime: string | undefined = new Date(0).toISOString();
      let endTime: string | undefined = new Date().toISOString();
      while (messages.length < limit) {
        const query: URLSearchParams = new URLSearchParams({
          ownerId: opts.workspaceId,
          resource: service.id,
          type: "app",
          direction: "backward",
          limit: String(Math.min(100, limit - messages.length)),
          ...(startTime ? { startTime } : {}),
          ...(endTime ? { endTime } : {}),
        });
        const page = await request<{
          logs: Array<{ message: string }>;
          hasMore: boolean;
          nextStartTime?: string;
          nextEndTime?: string;
        }>("GET", `/logs?${query}`);
        if (!page) break;
        messages.push(...page.logs.map((log) => log.message));
        if (!page.hasMore || !page.logs.length || (page.nextStartTime === startTime && page.nextEndTime === endTime))
          break;
        startTime = page.nextStartTime;
        endTime = page.nextEndTime;
      }
      return messages.reverse().join("\n");
    },
    transferOwnership: (deployment, toScope) =>
      serialized(
        deployment,
        async () => {
          ensureConfigured();
          let record = await opts.store.get(deployment.id);
          if (!record) return;
          if (record.ownerScopeId === toScope && record.status === "suspended" && !record.transfer) return;
          if (record.transfer && record.transfer.ownerScopeId !== toScope)
            throw new Error(`Render app ${deployment.id} has an incomplete ownership transfer`);
          const target = await gateways.ensure(toScope);
          if (!record.transfer) {
            if (record.status === "pending") await waitLive(deployment, record);
            record = (await opts.store.get(deployment.id))!;
            await suspendService(deployment, record);
            record = {
              ...(await opts.store.get(deployment.id))!,
              transfer: { ownerScopeId: toScope, environmentId: target.environmentId },
            };
            await save(record);
          }
          const servicePath = `/services/${encodeURIComponent(record.serviceId!)}`;
          let service = await request<RenderService>("GET", servicePath);
          if (
            !service ||
            service.id !== record.serviceId ||
            service.name !== nameOf(deployment) ||
            service.ownerId !== opts.workspaceId ||
            service.type !== "private_service" ||
            service.suspended !== "suspended" ||
            service.serviceDetails.region !== region ||
            !service.environmentId ||
            ![record.environmentId, target.environmentId].includes(service.environmentId)
          )
            throw new Error(`Render app ${deployment.id} is not the expected suspended service`);
          const marker = await request<{ value: string }>("GET", `${servicePath}/env-vars/${OWNER_MARKER}`);
          if (marker?.value !== deployment.id)
            throw new Error(`Render service ${service.name} belongs to another deployment`);
          if (service.environmentId !== target.environmentId) {
            try {
              await request("POST", `/environments/${target.environmentId}/resources`, { resourceIds: [service.id] });
            } catch (error) {
              service = await request<RenderService>("GET", servicePath);
              if (service?.environmentId !== target.environmentId) throw error;
            }
          }
          service = await request<RenderService>("GET", servicePath);
          if (service?.environmentId !== target.environmentId || service.suspended !== "suspended")
            throw new Error(`Render app ${deployment.id} ownership transfer is not confirmed`);
          await save({
            ...record,
            ownerScopeId: toScope,
            environmentId: target.environmentId,
            transfer: undefined,
            status: "suspended",
          });
        },
        toScope,
      ),
    destroy: (deployment) =>
      serialized(deployment, async () => {
        ensureConfigured();
        const stored = await opts.store.get(deployment.id);
        if (stored) {
          const recovered = await recoverRejectedCreate(deployment, stored);
          if (recovered) await suspendService(deployment, recovered);
          return;
        }
        const service = await findService(deployment);
        if (service) {
          await suspendService(deployment, {
            deploymentId: deployment.id,
            ownerScopeId: deployment.ownerScopeId,
            environmentId: service.environmentId!,
            version: deployment.currentVersion,
            status: "suspending",
            createdService: false,
            previousDeployIds: [],
            serviceId: service.id,
          });
        } else {
          await opts.artifacts.revoke(deployment.id);
          await gateways.remove(deployment.ownerScopeId, deployment.id);
        }
      }),
  };
}
