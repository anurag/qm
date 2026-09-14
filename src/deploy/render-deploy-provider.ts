import { randomBytes } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import type { DeployProvider } from "./deploy-provider.ts";
import type { Deployment, DeploymentVersion, DeployEndpoint } from "./deploy-store.ts";
import type { RenderDeployArtifacts } from "./render-deploy-artifacts.ts";
import { createRenderApi, list, RenderApiError } from "./render-api.ts";
import { createRenderAppNetwork } from "./render-app-network.ts";

const FAILED = new Set(["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"]);
const OWNER_MARKER = "QM_DEPLOYMENT_ID";
const RENDER_APP_AUTH_HEADER = "x-qm-render-app-token";

interface Service {
  id: string;
  name: string;
  ownerId: string;
  environmentId?: string;
  type: string;
  suspended: string;
  serviceDetails: { url?: string; region?: string; disk?: unknown; numInstances?: number };
}

interface Deploy {
  id: string;
  status: string;
  commit?: { id: string };
}

export interface StoredRenderDeploy {
  deploymentId: string;
  appRegion?: string;
  serviceId?: string;
  environmentId?: string;
  token: string;
  liveVersion?: number;
  suspended: boolean;
  pending?: {
    version: number;
    runnerCommit: string;
    readinessNonce: string;
    previousDeployId?: string;
    deployId?: string;
  };
}

export interface RenderDeployProviderOptions {
  apiKey: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  postgresId: string;
  source: { repo: string; branch: string; commit: string };
  region?: string;
  appRegion?: string;
  plan?: string;
  appPrefix?: string;
  store: DurableMap<StoredRenderDeploy>;
  artifacts: RenderDeployArtifacts;
  resources: {
    ensure(deploymentId: string): Promise<Record<string, string>>;
    suspend(deploymentId: string): Promise<void>;
  };
  deployTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  advisoryLock?: AdvisoryLock;
}

export function createRenderDeployProvider(opts: RenderDeployProviderOptions): DeployProvider {
  const api = createRenderApi(opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const prefix = opts.appPrefix ?? "qm-app";
  const region = opts.region ?? "oregon";
  const timeout = opts.deployTimeoutMs ?? 600_000;
  const poll = opts.pollIntervalMs ?? 2_000;
  const locks = opts.advisoryLock ?? createNoopAdvisoryLock();
  const queue = createKeyedQueue();
  const endpoints = new LRUCache<string, DeployEndpoint>({ max: 500, ttl: 10_000 });
  const name = (d: Deployment) => `${prefix}-${d.id}`;
  const path = (s: Service) => `/services/${encodeURIComponent(s.id)}`;
  const save = (r: StoredRenderDeploy) => opts.store.put(r.deploymentId, r);
  const network = createRenderAppNetwork({ ...opts, region, api, locks, name });
  const serialized = <T>(d: Deployment, run: () => Promise<T>) =>
    queue(d.id, () =>
      locks.withLock(`render-provider:${d.id}`, async () => {
        endpoints.delete(d.id);
        try {
          return await run();
        } finally {
          endpoints.delete(d.id);
        }
      }),
    );

  async function validate(): Promise<void> {
    if (
      !opts.apiKey ||
      !opts.workspaceId ||
      !/^prj-[a-z0-9]+$/.test(opts.projectId) ||
      !opts.environmentId ||
      !opts.source.repo ||
      !opts.source.branch
    )
      throw new Error("Render app deployment requires a workspace, project, environment, and Git source");
    if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(prefix))
      throw new Error("Render app prefix must be a lowercase DNS label of at most 20 characters");
    if (!/^[a-f0-9]{40}$/.test(opts.source.commit)) throw new Error("Render app runner commit must be a Git SHA");
    const environment = await api.request<{ id: string; projectId: string }>(
      "GET",
      `/environments/${encodeURIComponent(opts.environmentId)}`,
    );
    if (environment?.id !== opts.environmentId || environment.projectId !== opts.projectId)
      throw new Error("Render app environment does not belong to the configured project");
  }

  async function owned(service: Service, deployment: Deployment): Promise<Service> {
    const record = await opts.store.get(deployment.id);
    await network.assertEnvironment(deployment, record?.environmentId);
    if (
      service.name !== name(deployment) ||
      service.ownerId !== opts.workspaceId ||
      service.environmentId !== record?.environmentId ||
      service.type !== "web_service" ||
      service.serviceDetails.region !== (record?.appRegion ?? region) ||
      service.serviceDetails.disk ||
      service.serviceDetails.numInstances !== 1
    )
      throw new Error(`Render app ${deployment.id} is not the expected diskless gated service`);
    const marker = await api.request<{ value: string }>("GET", `${path(service)}/env-vars/${OWNER_MARKER}`);
    if (marker?.value !== deployment.id) throw new Error("Render app service ownership does not match");
    return service;
  }

  async function find(deployment: Deployment, record: StoredRenderDeploy): Promise<Service | null> {
    if (record.serviceId) {
      const service = await api.request<Service>(
        "GET",
        `/services/${encodeURIComponent(record.serviceId)}`,
        undefined,
        true,
      );
      if (!service) throw new Error("The retained Render app service is missing; restore it before retrying");
      return owned(service, deployment);
    }
    const services = await list<Service>(api, "/services", "service", {
      name: name(deployment),
      ownerId: opts.workspaceId,
    });
    const service = services.find((row) => row.name === name(deployment));
    return service ? owned(service, deployment) : null;
  }

  const deployments = (service: Service) => list<Deploy>(api, `${path(service)}/deploys`, "deploy");

  function endpoint(service: Service, record: StoredRenderDeploy): DeployEndpoint {
    const value = service.serviceDetails.url;
    if (!value) throw new Error("Render app has no HTTPS address");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("Render app has an invalid HTTPS address");
    return {
      host: url.hostname,
      port: 443,
      tls: true,
      proxyHeaders: { [RENDER_APP_AUTH_HEADER]: record.token, connection: "close" },
    };
  }

  async function ready(service: Service, record: StoredRenderDeploy, nonce: string): Promise<boolean> {
    const address = endpoint(service, record);
    try {
      const response = await fetchImpl(`https://${address.host}:${address.port}/__qm_ready`, {
        headers: address.proxyHeaders,
        redirect: "manual",
        signal: AbortSignal.timeout(3_000),
      });
      await response.body?.cancel();
      return response.status === 204 && response.headers.get("x-qm-render-app-ready") === nonce;
    } catch {
      return false;
    }
  }

  async function latest(service: Service): Promise<Deploy | undefined> {
    const page = await api.request<Array<{ deploy: Deploy }>>("GET", `${path(service)}/deploys?limit=1`);
    if (!Array.isArray(page)) throw new Error("Render returned an invalid deploy list");
    return page[0]?.deploy;
  }

  const active = (deploy: Deploy) => deploy.status !== "live" && !FAILED.has(deploy.status);

  async function settle(service: Service): Promise<void> {
    for (const deploy of (await deployments(service)).filter(active))
      await api.request("POST", `${path(service)}/deploys/${encodeURIComponent(deploy.id)}/cancel`);
    await idle(service);
  }

  async function finish(
    deployment: Deployment,
    initial: StoredRenderDeploy,
  ): Promise<{ service: Service; record: StoredRenderDeploy }> {
    let record = initial;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const service = await find(deployment, record);
      if (service) {
        if (!record.serviceId) {
          record = { ...record, serviceId: service.id };
          await save(record);
        }
        const pending = record.pending;
        if (!pending) return { service, record };
        if (!pending.deployId) {
          const own = (deploy: Deploy | undefined) =>
            deploy && deploy.id !== pending.previousDeployId ? deploy : undefined;
          let found = own(await latest(service));
          if (!found) {
            try {
              found =
                (await api.request<Deploy>("POST", `${path(service)}/deploys`, { commitId: pending.runnerCommit })) ??
                undefined;
            } catch (error) {
              if (error instanceof RenderApiError && error.rejected) {
                await save({ ...record, pending: undefined });
                throw error;
              }
              found = own(await latest(service));
              if (!found) throw error;
            }
          }
          if (found?.id) {
            record = { ...record, pending: { ...pending, deployId: found.id } };
            await save(record);
          }
        }
        if (pending.deployId) {
          const deploy = await api.request<Deploy>(
            "GET",
            `${path(service)}/deploys/${encodeURIComponent(pending.deployId)}`,
          );
          if (deploy && FAILED.has(deploy.status)) {
            await save({ ...record, pending: undefined });
            throw new Error(`Render deploy ${deploy.id} ${deploy.status}`);
          }
          if (deploy?.status === "live" && (await ready(service, record, pending.readinessNonce))) {
            if (deploy.commit?.id !== pending.runnerCommit) {
              await save({ ...record, pending: undefined });
              throw new Error("The Render app runner was built from a different Git commit");
            }
            record = { ...record, liveVersion: pending.version, suspended: false, pending: undefined };
            await save(record);
            return { service, record };
          }
        }
      }
      await sleep(Math.max(1, poll));
    }
    throw new Error(`Render app ${deployment.id} has an unconfirmed deployment; retry to reconcile it`);
  }

  async function idle(service: Service): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!(await deployments(service)).some(active)) return;
      await sleep(Math.max(1, poll));
    }
    throw new Error("The previous Render deployment is still pending");
  }

  async function apply(deployment: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
    await validate();
    let record = await opts.store.get(deployment.id);
    if (!record)
      record = await opts.store.putIfAbsent(deployment.id, {
        deploymentId: deployment.id,
        appRegion: opts.appRegion ?? region,
        token: randomBytes(32).toString("base64url"),
        suspended: false,
      });
    record = await network.ensure(deployment, record);
    if (record.pending) {
      const recovered = await finish(deployment, record);
      record = recovered.record;
      if (record.liveVersion === version.version) return endpoint(recovered.service, record);
    }
    let service = await find(deployment, record);
    if (
      service &&
      service.suspended !== "suspended" &&
      !record.suspended &&
      record.liveVersion === version.version &&
      deployment.appliedVersion !== version.version
    )
      return endpoint(service, record);
    const source = { repo: opts.source.repo, branch: opts.source.branch, rootDir: "", autoDeploy: "no" };
    const runtime = {
      runtime: "docker",
      envSpecificDetails: { dockerContext: ".", dockerfilePath: "deploy/render-runner/Dockerfile", dockerCommand: "" },
      maxShutdownDelaySeconds: 45,
      healthCheckPath: "/__qm_ready",
    };
    const bootstrap = {
      ...runtime,
      envSpecificDetails: { ...runtime.envSpecificDetails, dockerCommand: "/bin/sh -c exit 0" },
    };
    if (!service) {
      let created: { service: Service } | undefined;
      try {
        created =
          (await api.request<{ service: Service }>("POST", "/services", {
            type: "web_service",
            name: name(deployment),
            ownerId: opts.workspaceId,
            environmentId: record.environmentId,
            ...source,
            envVars: [{ key: OWNER_MARKER, value: deployment.id }],
            secretFiles: [],
            serviceDetails: {
              ...bootstrap,
              plan: opts.plan ?? "0.5c-512mb",
              region: record.appRegion ?? region,
              numInstances: 1,
            },
          })) ?? undefined;
      } catch (error) {
        if (error instanceof RenderApiError && error.rejected) throw error;
      }
      service = created?.service ?? (await find(deployment, record));
      if (!service) throw new Error("Render app bootstrap is unconfirmed; retry to reconcile it");
      record = { ...record, serviceId: service.id };
      await save(record);
    } else if (service.suspended === "suspended") {
      const before = (await latest(service))?.id;
      await api.request("PATCH", path(service), { ...source, serviceDetails: bootstrap });
      await api.request("POST", `${path(service)}/resume`);
      const deadline = Date.now() + timeout;
      while ((await latest(service))?.id === before) {
        if (Date.now() >= deadline) throw new Error("The resumed Render app has not started its deployment");
        await sleep(Math.max(1, poll));
      }
    }
    await settle(service);
    await network.allowDatabaseAccess(service.id);
    const resources = await opts.resources.ensure(deployment.id);
    const artifact = await opts.artifacts.prepare(deployment, version);
    const readinessNonce = randomBytes(32).toString("base64url");
    const envVars = Object.entries({
      PORT: "8080",
      QM_RENDER_APP_TOKEN: record.token,
      [OWNER_MARKER]: deployment.id,
    }).map(([key, value]) => ({ key, value }));
    const secretFiles = [
      {
        name: "qm-render-artifact.json",
        content: JSON.stringify({ ...artifact, readinessNonce, runtimeEnv: { ...version.env, ...resources } }),
      },
    ];
    await api.request("PUT", `${path(service)}/env-vars`, envVars);
    await api.request("PUT", `${path(service)}/secret-files`, secretFiles);
    await api.request("PATCH", path(service), { ...source, serviceDetails: runtime });
    const previousDeployId = (await latest(service))?.id;
    record = {
      ...record,
      pending: {
        version: version.version,
        runnerCommit: opts.source.commit,
        readinessNonce,
        ...(previousDeployId ? { previousDeployId } : {}),
      },
    };
    await save(record);
    const live = await finish(deployment, record);
    return endpoint(live.service, live.record);
  }

  return {
    profile: { managedScaleToZero: false },
    apply: (deployment, version) => serialized(deployment, () => apply(deployment, version)),
    async resolveEndpoint(deployment) {
      if (deployment.status === "archived") return null;
      const record = await opts.store.get(deployment.id);
      if (!record || record.suspended || record.liveVersion === undefined) return null;
      const cached = endpoints.get(deployment.id);
      if (cached) return cached;
      const service = await find(deployment, record);
      if (!service || service.suspended === "suspended") return null;
      const address = endpoint(service, record);
      endpoints.set(deployment.id, address);
      return address;
    },
    destroy: (deployment) =>
      serialized(deployment, async () => {
        await validate();
        const record = await opts.store.get(deployment.id);
        if (!record) return;
        let service = await find(deployment, record);
        if (service && service.suspended !== "suspended") await api.request("POST", `${path(service)}/suspend`);
        const deadline = Date.now() + timeout;
        while (service && service.suspended !== "suspended") {
          if (Date.now() >= deadline) throw new Error("Render app suspension is not confirmed");
          await sleep(Math.max(1, poll));
          service = await find(deployment, record);
        }
        await opts.resources.suspend(deployment.id);
        await opts.artifacts.revoke(deployment.id);
        await save({ ...record, suspended: true, pending: undefined });
      }),
    async logs(deployment, { tailLines }) {
      const record = await opts.store.get(deployment.id);
      if (!record?.serviceId) return null;
      await find(deployment, record);
      const query = new URLSearchParams({
        ownerId: opts.workspaceId,
        resource: record.serviceId,
        type: "app",
        direction: "backward",
        limit: String(Math.max(1, Math.min(100, tailLines))),
      });
      const page = await api.request<{ logs: Array<{ message: string }> }>("GET", `/logs?${query}`);
      return (
        page?.logs
          .map((log) => log.message)
          .reverse()
          .join("\n") ?? null
      );
    },
  };
}
