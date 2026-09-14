import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createRenderAppNetwork } from "../src/deploy/render-app-network.ts";
import { RenderApiError, type RenderApi } from "../src/deploy/render-api.ts";
import type { StoredRenderDeploy } from "../src/deploy/render-deploy-provider.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

for (const result of ["accepted", "absent", "missing_cursor", "repeated_cursor", "invalid_list"] as const) {
  test(`Render environment recovery completes pagination before a write: ${result}`, async () => {
    const deployment: Deployment = {
      id: randomUUID(),
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      currentVersion: 1,
      status: "stopped",
      endpoint: null,
      versions: [],
    };
    const store = createMemoryMap<StoredRenderDeploy>();
    const initial: StoredRenderDeploy = {
      deploymentId: deployment.id,
      token: "token",
      suspended: false,
    };
    await store.put(deployment.id, initial);
    const environment = {
      id: "env-app",
      name: `qm-app-${deployment.id}`,
      projectId: "prj-test",
      networkIsolationEnabled: true,
    };
    let pages = 0;
    let posts = 0;
    const api: RenderApi = {
      async request<T>(method: string, path: string): Promise<T | null> {
        if (path === "/projects/prj-test") return { owner: { id: "tea-test" } } as T;
        if (method === "POST") {
          assert.equal(path, "/environments");
          assert.equal(pages, 2);
          posts++;
          return environment as T;
        }
        const query = new URL(`https://render.test${path}`).searchParams;
        pages++;
        if (result === "invalid_list") return null;
        if (!query.has("cursor") || result === "repeated_cursor")
          return Array.from({ length: 100 }, (_, i) => ({
            environment: { ...environment, id: `env-${i}`, name: `other-${i}` },
            ...(result === "missing_cursor" ? {} : { cursor: `cursor-${i}` }),
          })) as T;
        assert.equal(query.get("cursor"), "cursor-99");
        return (result === "accepted" ? [{ environment }] : []) as T;
      },
    };
    const network = createRenderAppNetwork({
      api,
      workspaceId: "tea-test",
      projectId: "prj-test",
      environmentId: "env-core",
      postgresId: "dpg-test",
      region: "oregon",
      store,
      locks: createNoopAdvisoryLock(),
      name: (d) => `qm-app-${d.id}`,
    });
    if (result === "accepted" || result === "absent") {
      const record = await network.ensure(deployment, initial);
      assert.equal(record.environmentId, environment.id);
      assert.equal(pages, result === "absent" ? 4 : 2);
      assert.equal(posts, result === "absent" ? 1 : 0);
    } else {
      await assert.rejects(
        network.ensure(deployment, initial),
        /pagination did not advance|invalid app environment list/,
      );
      assert.deepEqual(await store.get(deployment.id), initial);
      assert.equal(posts, 0);
    }
  });
}

test("Render environment recovery adopts the environment when its create is rejected as a duplicate", async () => {
  const deployment: Deployment = {
    id: randomUUID(),
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions: [],
  };
  const store = createMemoryMap<StoredRenderDeploy>();
  const initial: StoredRenderDeploy = { deploymentId: deployment.id, token: "token", suspended: false };
  await store.put(deployment.id, initial);
  const environment = {
    id: "env-app",
    name: `qm-app-${deployment.id}`,
    projectId: "prj-test",
    networkIsolationEnabled: true,
  };
  let lists = 0;
  let posts = 0;
  const api: RenderApi = {
    async request<T>(method: string, path: string): Promise<T | null> {
      if (path === "/projects/prj-test") return { owner: { id: "tea-test" } } as T;
      if (method === "POST") {
        posts++;
        throw new RenderApiError(method, path, 409);
      }
      lists++;
      return (lists === 1 ? [] : [{ environment }]) as T;
    },
  };
  const network = createRenderAppNetwork({
    api,
    workspaceId: "tea-test",
    projectId: "prj-test",
    environmentId: "env-core",
    postgresId: "dpg-test",
    region: "oregon",
    store,
    locks: createNoopAdvisoryLock(),
    name: (d) => `qm-app-${d.id}`,
  });
  const record = await network.ensure(deployment, initial);
  assert.equal(record.environmentId, environment.id);
  assert.equal(posts, 1);
  assert.equal(lists, 2);
  assert.deepEqual(await store.get(deployment.id), record);
});
