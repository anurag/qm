import assert from "node:assert/strict";
import test from "node:test";
import { resolveSandbox } from "../scripts/dev/lib/sandbox.ts";

const options = {
  worktree: "/tmp/qm",
  requested: "render" as const,
  corePort: 8080,
  lock: "/tmp/qm-test-lock",
  log: () => {},
};

test("Render dev sandbox validates credentials before starting a tunnel", async () => {
  const environments: Array<Record<string, string>> = [
    {},
    { RENDER_API_KEY: "rnd-test" },
    { RENDER_WORKSPACE_ID: "tea-test" },
  ];
  for (const baseEnv of environments) {
    await assert.rejects(resolveSandbox({ ...options, baseEnv }), /RENDER_API_KEY and RENDER_WORKSPACE_ID/);
  }
});

test("Render dev sandbox forwards its region and uses the configured public core URL", async () => {
  const result = await resolveSandbox({
    ...options,
    baseEnv: {
      RENDER_API_KEY: "rnd-test",
      RENDER_WORKSPACE_ID: "tea-test",
      RENDER_REGION: "frankfurt",
      RENDER_SANDBOX_PLAN: "pro",
      PUBLIC_API_URL: "https://core.example.com",
      UNRELATED_SECRET: "not-forwarded",
    },
  });
  assert.equal(result.backend, "render");
  assert.equal(result.publicApiUrl, "https://core.example.com");
  assert.deepEqual(result.env, {
    SANDBOX_BACKEND: "render",
    RENDER_API_KEY: "rnd-test",
    RENDER_WORKSPACE_ID: "tea-test",
    RENDER_REGION: "frankfurt",
    RENDER_SANDBOX_PLAN: "pro",
    PUBLIC_API_URL: "https://core.example.com",
  });
});
