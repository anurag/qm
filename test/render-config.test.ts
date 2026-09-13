import assert from "node:assert/strict";
import test from "node:test";
import { enabledSandboxBackends, loadConfig } from "../src/config.ts";
import { validateCoreSecretEnv } from "../src/deployment/secret-schema.ts";

const credentials = { RENDER_API_KEY: "rnd-test", RENDER_WORKSPACE_ID: "tea-test" };
const database = {
  RENDER_POSTGRES_ID: "dpg-acme-a",
  RENDER_APP_DATABASE_ENDPOINT: "postgresql://dpg-acme-a.oregon-postgres.render.com:5432/?sslmode=verify-full",
};

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

test("Render app deployment requires a project without requiring one for sandboxes", () => {
  for (const projectId of [undefined, "", " "])
    assert.throws(
      () => loadConfig({ ...credentials, DEPLOY_PROVIDER: "render", RENDER_PROJECT_ID: projectId }),
      /DEPLOY_PROVIDER=render requires RENDER_PROJECT_ID/,
    );
  for (const projectId of ["wrong", "prj-", "evm-production", "prj-acme/other"])
    assert.throws(
      () => loadConfig({ ...credentials, DEPLOY_PROVIDER: "render", RENDER_PROJECT_ID: projectId }),
      /RENDER_PROJECT_ID must be a project ID \(prj-\.\.\.\)/,
    );
  assert.equal(loadConfig({ ...credentials, SANDBOX_BACKEND: "render" }).renderDeploy.projectId, "");
});

test("Render app deployment requires a database ID and a verified external endpoint", () => {
  const selection = { ...credentials, DEPLOY_PROVIDER: "render", RENDER_PROJECT_ID: "prj-acme" };
  for (const postgresId of [undefined, "", " "])
    assert.throws(
      () => loadConfig({ ...selection, RENDER_POSTGRES_ID: postgresId }),
      /DEPLOY_PROVIDER=render requires RENDER_POSTGRES_ID/,
    );
  for (const postgresId of ["wrong", "dpg-", "prj-acme", "dpg-acme-a/other"])
    assert.throws(
      () => loadConfig({ ...selection, RENDER_POSTGRES_ID: postgresId }),
      /RENDER_POSTGRES_ID must be a PostgreSQL ID/,
    );
  for (const endpoint of [undefined, "", " "])
    assert.throws(
      () => loadConfig({ ...selection, ...database, RENDER_APP_DATABASE_ENDPOINT: endpoint }),
      /DEPLOY_PROVIDER=render requires RENDER_APP_DATABASE_ENDPOINT/,
    );
  for (const endpoint of [
    "postgresql://admin:secret@db.example.com/?sslmode=verify-full",
    "postgresql://db.example.com/core?sslmode=verify-full",
    "postgresql://db.example.com/?sslmode=require",
    "postgresql://db.example.com/?sslmode=disable",
    "postgresql://db.example.com/",
    "postgresql://db.example.com/?sslmode=verify-full&sslmode=disable",
    "postgresql://db.example.com/?sslmode=verify-full&user=admin",
  ])
    assert.throws(
      () => loadConfig({ ...selection, ...database, RENDER_APP_DATABASE_ENDPOINT: endpoint }),
      /RENDER_APP_DATABASE_ENDPOINT/,
    );
  const config = loadConfig({ ...selection, ...database });
  assert.equal(config.renderDeploy.postgresId, database.RENDER_POSTGRES_ID);
  assert.equal(config.renderDeploy.appDatabaseEndpoint, database.RENDER_APP_DATABASE_ENDPOINT);
  assert.equal(loadConfig({ ...credentials, SANDBOX_BACKEND: "render" }).renderDeploy.postgresId, "");
  assert.equal(loadConfig({ ...credentials, SANDBOX_BACKEND: "render" }).renderDeploy.appDatabaseEndpoint, "");
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

test("Render deployed apps use the configured project", () => {
  const config = loadConfig({
    ...credentials,
    ...database,
    DEPLOY_PROVIDER: "render",
    RENDER_PROJECT_ID: " prj-acme ",
    RENDER_ENVIRONMENT_ID: "evm-production",
  });
  assert.equal(config.renderDeploy.projectId, "prj-acme");
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
    ...database,
    DEPLOY_PROVIDER: "render",
    RENDER_PROJECT_ID: "prj-acme",
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
