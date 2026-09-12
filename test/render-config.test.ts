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

test("Render sandbox selection requires a workspace and one API key", () => {
  assert.throws(() => loadConfig({ SANDBOX_BACKEND: "render" }), /RENDER_API_KEY/);
  assert.throws(() => loadConfig({ SANDBOX_BACKEND: "render", RENDER_API_KEY: "rnd-test" }), /RENDER_WORKSPACE_ID/);
  assert.deepEqual(validateCoreSecretEnv({ SANDBOX_BACKEND: "render" }), ["RENDER_API_KEY"]);
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
