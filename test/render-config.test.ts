import assert from "node:assert/strict";
import test from "node:test";
import { enabledSandboxBackends, loadConfig } from "../src/config.ts";
import { validateCoreSecretEnv } from "../src/deployment/secret-schema.ts";

const credentials = { RENDER_API_KEY: "rnd-test", RENDER_WORKSPACE_ID: "tea-test" };

test("Render sandbox configuration uses the SDK defaults", () => {
  const config = loadConfig({ ...credentials, SANDBOX_BACKEND: "render" });
  assert.equal(config.sandboxBackend, "render");
  assert.deepEqual(config.renderSandbox, {
    apiKey: "rnd-test",
    workspaceId: "tea-test",
    region: "oregon",
    plan: "starter",
    ttlSec: 7200,
  });
  assert.ok(enabledSandboxBackends(config).includes("render"));
});

test("Render provider selection requires a workspace and one API key", () => {
  for (const selection of [{ SANDBOX_BACKEND: "render" }, { DEPLOY_PROVIDER: "render" }]) {
    assert.throws(() => loadConfig(selection), /RENDER_API_KEY/);
    assert.throws(() => loadConfig({ ...selection, RENDER_API_KEY: "rnd-test" }), /RENDER_WORKSPACE_ID/);
  }
  assert.deepEqual(validateCoreSecretEnv({ SANDBOX_BACKEND: "render", DEPLOY_PROVIDER: "render" }), ["RENDER_API_KEY"]);
});

test("Render sandbox requires both account fields before automatic registration", () => {
  assert.ok(!enabledSandboxBackends(loadConfig({ RENDER_API_KEY: "rnd-test" })).includes("render"));
  assert.ok(!enabledSandboxBackends(loadConfig({ RENDER_WORKSPACE_ID: "tea-test" })).includes("render"));
  assert.ok(enabledSandboxBackends(loadConfig(credentials)).includes("render"));
});

test("Render sandbox settings accept supported plans and reject invalid lifetimes", () => {
  const config = loadConfig({
    ...credentials,
    SANDBOX_BACKEND: "render",
    RENDER_REGION: "frankfurt",
    RENDER_SANDBOX_PLAN: "pro",
    RENDER_SANDBOX_TTL_SEC: "3600",
    SANDBOX_TIMEOUT_SEC: "45",
  });
  assert.equal(config.renderSandbox.region, "frankfurt");
  assert.equal(config.renderSandbox.plan, "pro");
  assert.equal(config.renderSandbox.ttlSec, 3600);
  assert.equal(config.renderSandbox.defaultTimeoutSec, 45);
  assert.throws(() => loadConfig({ RENDER_SANDBOX_PLAN: "free" }), /RENDER_SANDBOX_PLAN/);
  for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"]) {
    assert.throws(() => loadConfig({ RENDER_SANDBOX_TTL_SEC: value }), /RENDER_SANDBOX_TTL_SEC/);
  }
  assert.throws(() => loadConfig({ ...credentials, RENDER_SANDBOX_TTL_SEC: "660" }), /more than 60 seconds/);
  assert.equal(
    loadConfig({ ...credentials, RENDER_SANDBOX_TTL_SEC: "120", SANDBOX_TIMEOUT_SEC: "30" }).renderSandbox.ttlSec,
    120,
  );
  assert.doesNotThrow(() => loadConfig({ SANDBOX_TIMEOUT_SEC: "86400" }));
});

test("Render deployed apps use the core environment", () => {
  const config = loadConfig({
    ...credentials,
    DEPLOY_PROVIDER: "render",
    RENDER_ENVIRONMENT_ID: "evm-production",
  });
  assert.equal(config.renderDeploy.environmentId, "evm-production");
  for (const environmentId of ["wrong", "env-production", "evm-", "evm-production/other"])
    assert.throws(
      () => loadConfig({ ...credentials, RENDER_ENVIRONMENT_ID: environmentId }),
      /RENDER_ENVIRONMENT_ID must be an environment ID \(evm-\.\.\.\)/,
    );
});

test("Render app runners accept Git builds without a published image", () => {
  const config = loadConfig({
    ...credentials,
    DEPLOY_PROVIDER: "render",
    RENDER_DEPLOY_REPO: " https://github.com/example/qm.git/ ",
    RENDER_DEPLOY_BRANCH: " feature/render ",
    RENDER_DEPLOY_IMAGE: " ",
  });
  assert.deepEqual(config.renderDeploy.source, {
    repo: "https://github.com/example/qm",
    branch: "feature/render",
  });
  assert.equal(config.renderDeploy.baseImage, "");
  assert.equal(loadConfig(credentials).renderDeploy.source, undefined);
});

test("Render app runner source fields must select one complete build source", () => {
  const source = { RENDER_DEPLOY_REPO: "https://github.com/example/qm", RENDER_DEPLOY_BRANCH: "main" };
  for (const env of [
    { RENDER_DEPLOY_REPO: source.RENDER_DEPLOY_REPO },
    { RENDER_DEPLOY_BRANCH: source.RENDER_DEPLOY_BRANCH },
    { ...source, RENDER_DEPLOY_BRANCH: " " },
    { ...source, RENDER_DEPLOY_REPO: " " },
  ])
    assert.throws(() => loadConfig({ ...credentials, ...env }), /must be set together/);
  assert.throws(
    () => loadConfig({ ...credentials, ...source, RENDER_DEPLOY_IMAGE: "example/runner:latest" }),
    /not both/,
  );
});

test("Render app runner sources reject credentials, other hosts, and invalid branch names", () => {
  const source = { RENDER_DEPLOY_REPO: "https://github.com/example/qm", RENDER_DEPLOY_BRANCH: "main" };
  for (const repo of [
    "http://github.com/example/qm",
    "https://token@github.com/example/qm",
    "https://github.com.example.com/example/qm",
    "git@github.com:example/qm.git",
    "https://github.com/example/qm?token=secret",
    "https://github.com/example/qm#main",
    "https://github.com/example/..",
    "https://github.com/./qm",
    "https://github.com/example/qm/tree/main",
  ])
    assert.throws(
      () => loadConfig({ ...credentials, ...source, RENDER_DEPLOY_REPO: repo }),
      /RENDER_DEPLOY_REPO must be an HTTPS GitHub repository URL/,
    );
  for (const branch of [
    "bad\nbranch",
    "bad branch",
    "bad~branch",
    "bad^branch",
    "bad:branch",
    "bad?branch",
    "bad*branch",
    "bad[branch",
    "bad\\branch",
    "bad..branch",
    "bad@{branch",
    "@",
    "-main",
    ".main",
    "main.",
    "feature/.main",
    "main.lock",
    "main.lock/feature",
    "/main",
    "main/",
    "feature//main",
  ])
    assert.throws(
      () => loadConfig({ ...credentials, ...source, RENDER_DEPLOY_BRANCH: branch }),
      /RENDER_DEPLOY_BRANCH must be a valid Git branch name/,
    );
});
