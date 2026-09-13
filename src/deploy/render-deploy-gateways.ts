import { createHash, randomBytes } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import { sleep } from "../util/async.ts";
import type { DeployEndpoint } from "./deploy-store.ts";
import {
  RENDER_GATEWAY_IMAGE,
  RENDER_GATEWAY_COMMAND,
  RENDER_GATEWAY_AUTH_HEADER,
  RENDER_GATEWAY_APP_HEADER,
  renderGatewayConfig,
  renderGatewayConfigHash,
} from "./render-caddy.ts";

const CONFIG_FILE = "qm-render-gateway.json";
const OWNER_MARKER = "QM_GATEWAY_OWNER";
const CONFIG_PATH = "/__qm_gateway_config";
const HEALTH_PATH = "/__qm_gateway_health";
const FAILED_DEPLOYS = new Set(["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"]);

type Routes = Record<string, { host: string; port: number }>;

export interface StoredRenderGateway {
  ownerScopeId: string;
  token: string;
  environmentId?: string;
  environmentCreatePending?: boolean;
  gatewayServiceId?: string;
  gatewayCreatePending?: boolean;
  routes: Routes;
  desiredConfigHash: string;
  appliedConfigHash?: string;
  appliedDeployId?: string;
  suspendPending?: boolean;
  pendingDeploy?: { configHash: string; previousDeployIds: string[]; deployId?: string };
}

export interface RenderDeployGatewaysOptions {
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    allowMissing?: boolean,
    deadline?: number,
  ): Promise<T | null>;
  workspaceId: string;
  projectId: string;
  region: string;
  prefix: string;
  store: DurableMap<StoredRenderGateway>;
  timeoutMs: number;
  pollMs: number;
  fetchImpl?: typeof fetch;
}

interface Environment {
  id: string;
  name: string;
  projectId: string;
  networkIsolationEnabled: boolean;
  protectedStatus: string;
}

interface Service {
  id: string;
  name: string;
  ownerId: string;
  type: string;
  environmentId?: string;
  imagePath?: string;
  registryCredential?: unknown;
  suspended: string;
  serviceDetails: {
    url?: string;
    region?: string;
    runtime?: string;
    envSpecificDetails?: { dockerCommand?: string };
    numInstances?: number;
    disk?: unknown;
  };
}

interface Deploy {
  id: string;
  status?: string;
}

function rejected(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

export function createRenderDeployGateways(opts: RenderDeployGatewaysOptions) {
  const request = opts.request;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ownerHash = (owner: string): string => createHash("sha256").update(`${opts.projectId}\0${owner}`).digest("hex");
  const nameOf = (owner: string): string => `${opts.prefix}-gw-${ownerHash(owner).slice(0, 32)}`;
  const servicePath = (service: Service): string => `/services/${encodeURIComponent(service.id)}`;
  const save = (record: StoredRenderGateway): Promise<void> => opts.store.put(record.ownerScopeId, record);
  const deadlineOf = (): number => Date.now() + opts.timeoutMs;
  const pause = (deadline: number): Promise<void> => sleep(Math.max(1, Math.min(opts.pollMs, deadline - Date.now())));

  async function pages<T>(path: string, deadline: number): Promise<T[]> {
    const rows: T[] = [];
    const cursors = new Set<string>();
    let cursor = "";
    for (;;) {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page =
        (await request<Array<T & { cursor?: string }>>(
          "GET",
          `${path}${path.includes("?") ? "&" : "?"}${query}`,
          undefined,
          false,
          deadline,
        )) ?? [];
      rows.push(...page);
      if (page.length < 100) return rows;
      const next = page.at(-1)?.cursor;
      if (!next || cursors.has(next) || Date.now() >= deadline)
        throw new Error("Render gateway resource list is incomplete");
      cursors.add(next);
      cursor = next;
    }
  }

  async function project(deadline: number): Promise<void> {
    if (!opts.projectId || !opts.workspaceId) throw new Error("Render gateway project and workspace are required");
    const found = await request<{ id: string; owner: { id: string } }>(
      "GET",
      `/projects/${encodeURIComponent(opts.projectId)}`,
      undefined,
      false,
      deadline,
    );
    if (found?.id !== opts.projectId || found.owner?.id !== opts.workspaceId)
      throw new Error("Render gateway project belongs to another workspace");
  }

  function ownedEnvironment(environment: Environment, owner: string): Environment {
    if (
      environment.projectId !== opts.projectId ||
      environment.name !== nameOf(owner) ||
      environment.networkIsolationEnabled !== true ||
      environment.protectedStatus !== "protected"
    )
      throw new Error("Render gateway environment identity or network isolation changed");
    return environment;
  }

  async function findEnvironment(record: StoredRenderGateway, deadline: number): Promise<Environment | null> {
    await project(deadline);
    if (record.environmentId) {
      const found = await request<Environment>(
        "GET",
        `/environments/${encodeURIComponent(record.environmentId)}`,
        undefined,
        true,
        deadline,
      );
      if (!found || found.id !== record.environmentId)
        throw new Error("The retained Render gateway environment is missing");
      return ownedEnvironment(found, record.ownerScopeId);
    }
    const query = new URLSearchParams({ projectId: opts.projectId, name: nameOf(record.ownerScopeId) });
    const matches = (await pages<{ environment: Environment }>(`/environments?${query}`, deadline)).filter(
      ({ environment }) => environment.name === nameOf(record.ownerScopeId),
    );
    if (matches.length > 1) throw new Error("Render gateway environment identity is ambiguous");
    return matches[0] ? ownedEnvironment(matches[0].environment, record.ownerScopeId) : null;
  }

  async function recordFor(ownerScopeId: string): Promise<StoredRenderGateway> {
    const existing = await opts.store.get(ownerScopeId);
    if (existing) {
      if (existing.ownerScopeId !== ownerScopeId) throw new Error("Render gateway owner identity changed");
      return existing;
    }
    const token = randomBytes(32).toString("base64url");
    return opts.store.putIfAbsent(ownerScopeId, {
      ownerScopeId,
      token,
      routes: {},
      desiredConfigHash: renderGatewayConfigHash(token, {}),
    });
  }

  async function ensure(ownerScopeId: string): Promise<{ environmentId: string }> {
    const deadline = deadlineOf();
    let record = await recordFor(ownerScopeId);
    let environment = await findEnvironment(record, deadline);
    if (!record.environmentId && environment && !record.environmentCreatePending)
      throw new Error("An untracked Render gateway environment has the reserved name");
    if (!environment) {
      if (record.environmentCreatePending)
        throw new Error(
          "Render gateway environment creation is uncertain; retry after it appears or recover it manually",
        );
      record = { ...record, environmentCreatePending: true };
      await save(record);
      try {
        environment = await request<Environment>("POST", "/environments", {
          name: nameOf(ownerScopeId),
          projectId: opts.projectId,
          networkIsolationEnabled: true,
          protectedStatus: "protected",
        });
      } catch (error) {
        if (rejected(error)) await save({ ...record, environmentCreatePending: false });
        throw error;
      }
      if (!environment) throw new Error("Render gateway environment creation is uncertain; retry to reconcile it");
      ownedEnvironment(environment, ownerScopeId);
    }
    if (record.environmentId !== environment.id || record.environmentCreatePending)
      await save({ ...record, environmentId: environment.id, environmentCreatePending: false });
    return { environmentId: environment.id };
  }

  async function ownedService(service: Service, record: StoredRenderGateway, deadline: number): Promise<Service> {
    if (
      service.name !== nameOf(record.ownerScopeId) ||
      service.ownerId !== opts.workspaceId ||
      service.environmentId !== record.environmentId ||
      service.type !== "web_service" ||
      service.imagePath !== RENDER_GATEWAY_IMAGE ||
      service.registryCredential ||
      service.serviceDetails.region !== opts.region ||
      service.serviceDetails.runtime !== "image" ||
      service.serviceDetails.envSpecificDetails?.dockerCommand !== RENDER_GATEWAY_COMMAND ||
      service.serviceDetails.numInstances !== 1 ||
      service.serviceDetails.disk
    )
      throw new Error("Render gateway service identity or configuration changed");
    const marker = await request<{ value: string }>(
      "GET",
      `${servicePath(service)}/env-vars/${OWNER_MARKER}`,
      undefined,
      true,
      deadline,
    );
    if (marker?.value !== ownerHash(record.ownerScopeId))
      throw new Error("Render gateway service belongs to another owner");
    return service;
  }

  async function findService(record: StoredRenderGateway, deadline: number): Promise<Service | null> {
    if (record.gatewayServiceId) {
      const found = await request<Service>(
        "GET",
        `/services/${encodeURIComponent(record.gatewayServiceId)}`,
        undefined,
        true,
        deadline,
      );
      if (!found || found.id !== record.gatewayServiceId)
        throw new Error("The retained Render gateway service is missing");
      return ownedService(found, record, deadline);
    }
    const query = new URLSearchParams({ name: nameOf(record.ownerScopeId), ownerId: opts.workspaceId });
    const matches = (await pages<{ service: Service }>(`/services?${query}`, deadline)).filter(
      ({ service }) => service.name === nameOf(record.ownerScopeId),
    );
    if (matches.length > 1) throw new Error("Render gateway service identity is ambiguous");
    if (!matches[0]) return null;
    if (!record.gatewayCreatePending) throw new Error("An untracked Render gateway service has the reserved name");
    return ownedService(matches[0].service, record, deadline);
  }

  function endpointOf(service: Service, record: StoredRenderGateway, appId: string): DeployEndpoint {
    const url = new URL(service.serviceDetails.url ?? "http://invalid");
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.onrender\.com$/.test(url.hostname) ||
      (url.port && url.port !== "443") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Render gateway returned an invalid public address");
    return {
      host: url.hostname,
      port: 443,
      tls: true,
      proxyHeaders: {
        connection: "close",
        [RENDER_GATEWAY_AUTH_HEADER]: record.token,
        [RENDER_GATEWAY_APP_HEADER]: appId,
      },
    };
  }

  async function configIsLive(service: Service, record: StoredRenderGateway, hash: string, deadline: number) {
    const endpoint = endpointOf(service, record, "");
    try {
      const response = await fetchImpl(`https://${endpoint.host}${CONFIG_PATH}`, {
        headers: { [RENDER_GATEWAY_AUTH_HEADER]: record.token },
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      return (await response.text()) === hash;
    } catch {
      return false;
    }
  }

  async function deploys(service: Service, deadline: number): Promise<Deploy[]> {
    return (await pages<{ deploy: Deploy }>(`${servicePath(service)}/deploys`, deadline)).map(({ deploy }) => deploy);
  }

  async function idle(service: Service, deadline: number): Promise<Deploy[]> {
    for (;;) {
      const current = await deploys(service, deadline);
      if (current.every(({ status }) => status === "live" || FAILED_DEPLOYS.has(status ?? ""))) return current;
      if (Date.now() >= deadline) throw new Error("Render gateway has a deploy in progress; retry after it finishes");
      await pause(deadline);
    }
  }

  async function waitLive(initial: StoredRenderGateway, deadline: number): Promise<StoredRenderGateway> {
    let record = initial;
    while (Date.now() < deadline) {
      const service = await findService(record, deadline);
      if (service) {
        if (record.gatewayServiceId !== service.id) {
          record = { ...record, gatewayServiceId: service.id, gatewayCreatePending: false };
          await save(record);
        }
        const pending = record.pendingDeploy!;
        if (!pending.deployId) {
          const candidates = (await deploys(service, deadline)).filter(
            ({ id }) => !pending.previousDeployIds.includes(id),
          );
          if (candidates.length > 1) throw new Error("Render gateway deploy identity is ambiguous");
          if (candidates[0]) {
            record = { ...record, pendingDeploy: { ...pending, deployId: candidates[0].id } };
            await save(record);
          }
        }
        if (record.pendingDeploy?.deployId) {
          const deployed = await request<Deploy>(
            "GET",
            `${servicePath(service)}/deploys/${encodeURIComponent(record.pendingDeploy.deployId)}`,
            undefined,
            false,
            deadline,
          );
          if (FAILED_DEPLOYS.has(deployed?.status ?? "")) {
            await save({ ...record, pendingDeploy: undefined });
            throw new Error(`Render gateway deploy failed with status ${deployed?.status}`);
          }
          if (
            deployed?.status === "live" &&
            service.suspended === "not_suspended" &&
            (await configIsLive(service, record, record.pendingDeploy.configHash, deadline))
          ) {
            record = {
              ...record,
              appliedConfigHash: record.pendingDeploy.configHash,
              appliedDeployId: deployed.id,
              pendingDeploy: undefined,
            };
            await save(record);
            return record;
          }
        }
      }
      await pause(deadline);
    }
    throw new Error("Render gateway deploy is unconfirmed; retry to reconcile it");
  }

  async function applyRoutes(initial: StoredRenderGateway, deadline: number): Promise<StoredRenderGateway> {
    let record = initial;
    let service = await findService(record, deadline);
    if (!service && record.gatewayCreatePending)
      throw new Error("Render gateway creation is uncertain; retry after it appears or recover it manually");
    if (service?.suspended === "not_suspended" && record.appliedConfigHash === record.desiredConfigHash) {
      while (Date.now() < deadline) {
        if (await configIsLive(service, record, record.desiredConfigHash, deadline)) return record;
        await pause(deadline);
      }
      throw new Error("Render gateway configuration is not live; retry after the gateway is healthy");
    }
    const secretFiles = [{ name: CONFIG_FILE, content: renderGatewayConfig(record.token, record.routes) }];
    const previousDeployIds = service ? (await idle(service, deadline)).map(({ id }) => id) : [];
    if (service) await request("PUT", `${servicePath(service)}/secret-files`, secretFiles);
    record = {
      ...record,
      gatewayCreatePending: !service,
      pendingDeploy: { configHash: record.desiredConfigHash, previousDeployIds },
      suspendPending: false,
    };
    await save(record);
    try {
      if (!service) {
        const created = await request<{ service?: Service; deployId?: string }>("POST", "/services", {
          type: "web_service",
          name: nameOf(record.ownerScopeId),
          ownerId: opts.workspaceId,
          environmentId: record.environmentId,
          autoDeploy: "no",
          image: { ownerId: opts.workspaceId, imagePath: RENDER_GATEWAY_IMAGE },
          envVars: [
            { key: OWNER_MARKER, value: ownerHash(record.ownerScopeId) },
            { key: "PORT", value: "8080" },
          ],
          secretFiles,
          serviceDetails: {
            runtime: "image",
            envSpecificDetails: { dockerCommand: RENDER_GATEWAY_COMMAND },
            region: opts.region,
            plan: "0.5c-512mb",
            numInstances: 1,
            healthCheckPath: HEALTH_PATH,
          },
        });
        service = created?.service ?? null;
        if (service) {
          await ownedService(service, record, deadline);
          record = { ...record, gatewayServiceId: service.id, gatewayCreatePending: false };
        }
        if (created?.deployId)
          record = { ...record, pendingDeploy: { ...record.pendingDeploy!, deployId: created.deployId } };
      } else if (service.suspended === "suspended") {
        await request("POST", `${servicePath(service)}/resume`);
      } else {
        const deployed = await request<Deploy>("POST", `${servicePath(service)}/deploys`, {});
        if (deployed?.id) record = { ...record, pendingDeploy: { ...record.pendingDeploy!, deployId: deployed.id } };
      }
      await save(record);
    } catch (error) {
      if (rejected(error)) {
        await save({ ...record, gatewayCreatePending: false, pendingDeploy: undefined });
        throw error;
      }
    }
    return waitLive(record, deadline);
  }

  async function upsert(ownerScopeId: string, appId: string, endpoint: { host: string; port: number }) {
    await ensure(ownerScopeId);
    const deadline = deadlineOf();
    let record = await recordFor(ownerScopeId);
    if (record.suspendPending) record = await suspend(record, deadline);
    if (record.pendingDeploy) record = await waitLive(record, deadline);
    const routes = { ...record.routes, [appId]: endpoint };
    const desiredConfigHash = renderGatewayConfigHash(record.token, routes);
    renderGatewayConfig(record.token, routes);
    record = { ...record, routes, desiredConfigHash };
    await save(record);
    record = await applyRoutes(record, deadline);
    return endpointOf((await findService(record, deadline))!, record, appId);
  }

  async function suspend(initial: StoredRenderGateway, deadline: number): Promise<StoredRenderGateway> {
    let record = initial;
    let service = await findService(record, deadline);
    if (!service) {
      if (record.gatewayCreatePending)
        throw new Error("Render gateway creation is uncertain; reconcile it before suspension");
      return record;
    }
    record = { ...record, gatewayServiceId: service.id, gatewayCreatePending: false };
    await request("PUT", `${servicePath(service)}/secret-files`, [
      { name: CONFIG_FILE, content: renderGatewayConfig(record.token, {}) },
    ]);
    record = { ...record, suspendPending: true, appliedConfigHash: undefined };
    await save(record);
    if (service.suspended !== "suspended") {
      try {
        await request("POST", `${servicePath(service)}/suspend`);
      } catch (error) {
        if (rejected(error)) throw error;
      }
    }
    while (Date.now() < deadline) {
      service = await findService(record, deadline);
      if (service?.suspended === "suspended") {
        record = { ...record, suspendPending: false, pendingDeploy: undefined };
        await save(record);
        return record;
      }
      await pause(deadline);
    }
    throw new Error("Render gateway suspension is unconfirmed; retry to reconcile it");
  }

  async function remove(ownerScopeId: string, appId: string): Promise<void> {
    let record = await opts.store.get(ownerScopeId);
    if (!record) return;
    if (record.ownerScopeId !== ownerScopeId) throw new Error("Render gateway owner identity changed");
    const deadline = deadlineOf();
    await findEnvironment(record, deadline);
    if (record.suspendPending) record = await suspend(record, deadline);
    const routes = { ...record.routes };
    delete routes[appId];
    if (Object.keys(routes).length > 0 && record.pendingDeploy) record = await waitLive(record, deadline);
    record = { ...record, routes, desiredConfigHash: renderGatewayConfigHash(record.token, routes) };
    await save(record);
    if (Object.keys(routes).length > 0) {
      await applyRoutes(record, deadline);
      return;
    }
    await suspend(record, deadline);
  }

  async function endpoint(ownerScopeId: string, appId: string): Promise<DeployEndpoint | null> {
    const record = await opts.store.get(ownerScopeId);
    if (!record) return null;
    if (record.ownerScopeId !== ownerScopeId) throw new Error("Render gateway owner identity changed");
    if (
      !Object.hasOwn(record.routes, appId) ||
      record.pendingDeploy ||
      record.suspendPending ||
      !record.gatewayServiceId ||
      !record.environmentId ||
      !record.appliedDeployId ||
      record.appliedConfigHash !== record.desiredConfigHash
    )
      return null;
    const deadline = deadlineOf();
    await findEnvironment(record, deadline);
    const service = await findService(record, deadline);
    if (!service || service.suspended !== "not_suspended") return null;
    const deployed = await request<Deploy>(
      "GET",
      `${servicePath(service)}/deploys/${encodeURIComponent(record.appliedDeployId)}`,
      undefined,
      false,
      deadline,
    );
    if (deployed?.status !== "live" || !(await configIsLive(service, record, record.desiredConfigHash, deadline)))
      return null;
    return endpointOf(service, record, appId);
  }

  return { ensure, upsert, remove, endpoint };
}
