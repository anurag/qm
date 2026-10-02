import { BlockList, isIP } from "node:net";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { Deployment } from "./deploy-store.ts";
import type { StoredRenderDeploy } from "./render-deploy-provider.ts";
import { list, RenderApiError, type RenderApi } from "./render-api.ts";

interface Environment {
  id: string;
  name: string;
  projectId: string;
  networkIsolationEnabled: boolean;
}

function range(value: string, allowAll = false) {
  const [address, mask, ...extra] = value.split("/");
  const version = isIP(address!);
  const max = version === 4 ? 32 : 128;
  const prefix = mask === undefined ? max : Number(mask);
  if (
    !version ||
    address!.includes("%") ||
    extra.length ||
    (mask !== undefined && !/^\d+$/.test(mask)) ||
    !Number.isInteger(prefix) ||
    prefix < (allowAll ? 0 : 1) ||
    prefix > max
  )
    throw new Error("Render returned an invalid outbound IP range");
  const family = version === 4 ? ("ipv4" as const) : ("ipv6" as const);
  const block = new BlockList();
  block.addSubnet(address!, prefix, family);
  return { address: address!, prefix, family, block, cidrBlock: `${address}/${prefix}` };
}

export function createRenderAppNetwork(opts: {
  api: RenderApi;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  postgresId: string;
  region: string;
  store: DurableMap<StoredRenderDeploy>;
  locks: AdvisoryLock;
  name(deployment: Deployment): string;
}) {
  const { api } = opts;
  function check(deployment: Deployment, environment: Environment | null | undefined): Environment {
    if (
      !environment ||
      environment.projectId !== opts.projectId ||
      !environment.networkIsolationEnabled ||
      environment.name !== opts.name(deployment)
    )
      throw new Error("Render app environment ownership or network isolation changed");
    return environment;
  }
  const assertEnvironment = async (deployment: Deployment, environmentId: string | undefined): Promise<Environment> => {
    if (!environmentId) throw new Error("The Render app has no retained isolated environment");
    return check(
      deployment,
      await api.request<Environment>("GET", `/environments/${encodeURIComponent(environmentId)}`),
    );
  };
  async function named(deployment: Deployment): Promise<Environment | undefined> {
    const name = opts.name(deployment);
    const found = await list<Environment>(api, "/environments", "environment", { projectId: opts.projectId, name });
    const matches = found.filter((env) => env.name === name && env.projectId === opts.projectId);
    return matches.sort((a, b) => a.id.localeCompare(b.id))[0];
  }
  return {
    assertEnvironment,
    async ensure(deployment: Deployment, initial: StoredRenderDeploy): Promise<StoredRenderDeploy> {
      if (initial.environmentId) {
        await assertEnvironment(deployment, initial.environmentId);
        return initial;
      }
      const project = await api.request<{ owner: { id: string } }>("GET", `/projects/${opts.projectId}`);
      if (project?.owner.id !== opts.workspaceId) throw new Error("Render project belongs to another workspace");
      let environment = await named(deployment);
      if (!environment) {
        try {
          const created = await api.request<Environment>("POST", "/environments", {
            name: opts.name(deployment),
            projectId: opts.projectId,
            networkIsolationEnabled: true,
            protectedStatus: "protected",
          });
          environment = (await named(deployment)) ?? created ?? undefined;
        } catch (error) {
          if (!(error instanceof RenderApiError && error.rejected)) throw error;
          environment = await named(deployment);
          if (!environment) throw error;
        }
      }
      if (environment && !environment.networkIsolationEnabled)
        throw new Error(
          "A Render environment with this app's name is not network-isolated; enable isolation or delete it",
        );
      const record = { ...initial, environmentId: check(deployment, environment).id };
      await opts.store.put(record.deploymentId, record);
      return record;
    },
    async allowDatabaseAccess(serviceId: string): Promise<void> {
      const outbound = await api.request<{ ips: string[] }>(
        "GET",
        `/services/${encodeURIComponent(serviceId)}/outbound-ips`,
      );
      if (!Array.isArray(outbound?.ips) || !outbound.ips.length)
        throw new Error("Render app outbound IP ranges are unavailable");
      const required = outbound.ips.map((value) => range(value));
      await opts.locks.withLock(`render-app-database-network:${opts.postgresId}`, async () => {
        const path = `/postgres/${encodeURIComponent(opts.postgresId)}`;
        const database = await api.request<{
          id: string;
          owner: { id: string };
          environmentId?: string;
          region: string;
          ipAllowList: Array<{ cidrBlock: string; description: string }>;
        }>("GET", path);
        if (
          database?.id !== opts.postgresId ||
          database.owner.id !== opts.workspaceId ||
          database.environmentId !== opts.environmentId ||
          database.region !== opts.region ||
          !Array.isArray(database.ipAllowList)
        )
          throw new Error("Render Postgres does not belong to the configured environment");
        const existing = database.ipAllowList.map(({ cidrBlock }) => range(cidrBlock, true));
        const additions = required.filter(
          (wanted) =>
            !existing.some(
              (current) =>
                current.family === wanted.family &&
                current.prefix <= wanted.prefix &&
                current.block.check(wanted.address, wanted.family),
            ),
        );
        if (additions.length) {
          const ipAllowList = [
            ...database.ipAllowList,
            ...additions.map(({ cidrBlock }) => ({ cidrBlock, description: "QM Render app outbound IP range" })),
          ];
          if (ipAllowList.length > 600) throw new Error("Render app database IP allowlist is full");
          await api.request("PATCH", path, { ipAllowList });
        }
      });
    },
  };
}
