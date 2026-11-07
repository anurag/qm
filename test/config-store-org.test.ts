import { test } from "node:test";
import assert from "node:assert/strict";
import { claimDeploymentIdentity, type PersistedDeploymentIdentity } from "../src/resolution/config-store.ts";
import { testConfigStore, testMap } from "./support/test-database.ts";

test("a durable database is pinned to one organization", async () => {
  const deploymentIdentity = testMap<PersistedDeploymentIdentity>();
  await testConfigStore("default-org", { deploymentIdentity }).hydrate!();
  await assert.rejects(
    testConfigStore("other", { deploymentIdentity }).hydrate!(),
    /database belongs to org default-org/,
  );
});

test("a durable database keeps one deployment ID, added once to an identity row that has none", async () => {
  const deploymentIdentity = testMap<PersistedDeploymentIdentity>();
  await deploymentIdentity.put("singleton", { orgId: "default-org" } as PersistedDeploymentIdentity);
  const first = await claimDeploymentIdentity(deploymentIdentity, "default-org");
  assert.ok(first.id);
  await testConfigStore("default-org", { deploymentIdentity }).hydrate!();
  assert.equal((await claimDeploymentIdentity(deploymentIdentity, "default-org")).id, first.id);
  assert.deepEqual(await deploymentIdentity.get("singleton"), { orgId: "default-org", id: first.id });
});

test("purpose runtimes persist independently without manufacturing a conversation default", async () => {
  const baseModels = testMap<import("../src/resolution/config-store.ts").PersistedBaseModel>();
  const store = testConfigStore("default-org", { baseModels });
  const org = "org:default-org";
  const cron = { modelId: "gpt-5.5", fastMode: false };
  const subagent = { modelId: "claude-opus-5", effortLevel: "low" };
  assert.equal(store.getPurposeRuntime("cron"), undefined);
  await store.setPurposeRuntime("cron", cron);
  await store.setPurposeRuntime("subagent", subagent);
  assert.equal(store.getBaseModel(org), null);
  assert.equal(await store.getRuntimeSelectionDurable(org), null);
  const reader = testConfigStore("default-org", { baseModels });
  await reader.hydrate!();
  assert.deepEqual(reader.getPurposeRuntime("cron"), cron);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("subagent"), subagent);
  reader.getPurposeRuntime("cron")!.modelId = "not-persisted";
  assert.deepEqual(reader.getPurposeRuntime("cron"), cron);
  await store.setRuntimeSelection(org, { modelId: "gpt-5.5" });
  await store.setRuntimeSelection(org, null);
  await store.setRuntimeSelection(org, null);
  await store.setRuntimeSelection(org, { modelId: "gpt-5.5" });
  assert.equal(store.getRuntimeSelection(org)?.modelId, "gpt-5.5");
  await store.setBaseModel(org, "gpt-5.5");
  await store.setBaseModel(org, null);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("cron"), cron);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("subagent"), subagent);
  await store.clearPurposeRuntime("cron");
  assert.equal(await reader.getPurposeRuntimeDurable("cron"), undefined);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("subagent"), subagent);
  await store.clearPurposeRuntime("subagent");
  assert.equal(await baseModels.get(org), null);
});
