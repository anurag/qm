import { BlockList, isIP } from "node:net";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { Deployment } from "./deploy-store.ts";
import type { StoredRenderDeploy } from "./render-deploy-provider.ts";
import { RenderApiError, type RenderApi } from "./render-api.ts";

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
  return {
    assertEnvironment,
    async ensure(deployment: Deployment, initial: StoredRenderDeploy): Promise<StoredRenderDeploy> {
      let record = initial;
      if (record.environmentId) {
        await assertEnvironment(deployment, record.environmentId);
        return record;
      }
      const project = await api.request<{ owner: { id: string } }>("GET", `/projects/${opts.projectId}`);
      if (project?.owner.id !== opts.workspaceId) throw new Error("Render project belongs to another workspace");
      const matches: Environment[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const query = new URLSearchParams({ projectId: opts.projectId, name: opts.name(deployment), limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const found = await api.request<Array<{ environment: Environment; cursor?: string }>>(
          "GET",
          `/environments?${query}`,
        );
        if (!Array.isArray(found)) throw new Error("Render returned an invalid app environment list");
        matches.push(
          ...found.map(({ environment }) => environment).filter((env) => env.name === opts.name(deployment)),
        );
        if (found.length < 100) break;
        cursor = found.at(-1)?.cursor;
        if (!cursor || cursors.has(cursor)) throw new Error("Render environment pagination did not advance");
        cursors.add(cursor);
      } while (cursor);
      if (matches.length > 1) throw new Error("Render app environment identity is ambiguous");
      let environment = matches[0];
      if (environment && !record.environmentCreatePending)
        throw new Error("An untracked Render environment has this app's name");
      if (!environment) {
        record = { ...record, environmentCreatePending: true };
        await opts.store.put(record.deploymentId, record);
        try {
          environment =
            (await api.request<Environment>("POST", "/environments", {
              name: opts.name(deployment),
              projectId: opts.projectId,
              networkIsolationEnabled: true,
              protectedStatus: "protected",
            })) ?? undefined;
        } catch (error) {
          if (error instanceof RenderApiError && error.rejected)
            await opts.store.put(record.deploymentId, { ...record, environmentCreatePending: undefined });
          throw error;
        }
      }
      environment = check(deployment, environment);
      record = { ...record, environmentId: environment.id, environmentCreatePending: undefined };
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
                current.prefix === wanted.prefix &&
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
