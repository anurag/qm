import { createDeployService, type DeployService, type DeployServiceDeps } from "./deploy-service.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createNoopAdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue } from "../util/async.ts";
import type { StoredRenderDeploy } from "./render-deploy-provider.ts";

export function createRenderDeployService(
  deps: DeployServiceDeps & { renderStore: DurableMap<StoredRenderDeploy> },
): DeployService {
  const base = createDeployService(deps);
  const queue = createKeyedQueue();
  const locks = deps.advisoryLock ?? createNoopAdvisoryLock();
  const run = async <T>(idOrName: string, operation: () => Promise<T>): Promise<T> => {
    const deployment = await base.getDeployment(idOrName);
    const id = deployment?.id ?? `name:${idOrName}`;
    return queue(id, () =>
      locks.withLock(`render-service:${id}`, async () => {
        try {
          return await operation();
        } catch (error) {
          const current = deployment ? await deps.deployStore.get(deployment.id) : null;
          const record = deployment ? await deps.renderStore.get(deployment.id) : null;
          if (
            current?.appliedVersion !== undefined &&
            !record?.pending &&
            current.currentVersion !== current.appliedVersion
          )
            await deps.deployStore.setCurrentVersion(current.id, current.appliedVersion);
          throw error;
        }
      }),
    );
  };
  return {
    ...base,
    deploy: (input) => (input.name ? run(input.name, () => base.deploy(input)) : base.deploy(input)),
    redeploy: (id, input) => run(id, () => base.redeploy(id, input)),
    rollbackDeployment: (id, version) => run(id, () => base.rollbackDeployment(id, version)),
    archiveDeployment: (id) => run(id, () => base.archiveDeployment(id)),
    restoreDeployment: (id, actorId) => run(id, () => base.restoreDeployment(id, actorId)),
    renameDeployment: (id, name) => run(id, () => base.renameDeployment(id, name)),
    transferDeploymentOwner: (id, scope, actor) => run(id, () => base.transferDeploymentOwner(id, scope, actor)),
    pushGit: (id, receive) => run(id, () => base.pushGit(id, receive)),
    deployOrUpdate: (input) =>
      input.name || input.renameFrom
        ? run(input.renameFrom ?? input.name!, () => base.deployOrUpdate(input))
        : base.deployOrUpdate(input),
  };
}
