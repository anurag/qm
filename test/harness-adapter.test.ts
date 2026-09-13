import test from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createOpenCodeHarness, openCodeHarnessConfigOptions } from "../src/harness/opencode-harness.ts";
import { createCodexHarness, codexHarnessConfigOptions } from "../src/harness/codex-harness.ts";
import { createClaudeHarness, claudeHarnessConfigOptions } from "../src/harness/claude-harness.ts";
import { createPiHarness, piHarnessConfigOptions } from "../src/harness/pi-harness.ts";
import { loadConfig } from "../src/config.ts";
import { bridgedTools, harnessToolOptions } from "../src/harness/harness-shared.ts";

test("each harness carries the deployment provider to its publish tool", () => {
  const config = { ...loadConfig({}), deployProvider: "render" as const };
  for (const optionsOf of [
    openCodeHarnessConfigOptions,
    codexHarnessConfigOptions,
    claudeHarnessConfigOptions,
    piHarnessConfigOptions,
  ]) {
    const options = optionsOf(config);
    assert.equal(options.deployProvider, "render");
    const publish = bridgedTools({ current: null }, harnessToolOptions(options)).find(
      (tool) => tool.name === "publish",
    )!;
    assert.match(publish.description, /runtime DATABASE_URL/);
    assert.doesNotMatch(publish.description, /SQLite at exactly \$DATA_DIR\/app.db/);
  }
});

test("harness adapters declare their native control and tool transports", async (t) => {
  const mock = createMockHarness();
  const pi = createPiHarness();
  const opencode = createOpenCodeHarness();
  const codex = createCodexHarness();
  const claude = createClaudeHarness();
  t.after(async () => {
    await pi.turns.close?.();
    await opencode.turns.close?.();
  });

  assert.deepEqual(
    [
      mock.profile.controlTransport,
      pi.profile.controlTransport,
      opencode.profile.controlTransport,
      codex.profile.controlTransport,
      claude.profile.controlTransport,
    ],
    ["mock", "in-process", "http", "json-rpc", "sdk"],
  );
  assert.deepEqual(
    [
      mock.profile.toolTransport,
      pi.profile.toolTransport,
      opencode.profile.toolTransport,
      codex.profile.toolTransport,
      claude.profile.toolTransport,
    ],
    ["mock", "in-process", "plugin", "dynamic", "in-process-mcp"],
  );
  assert.equal(pi.profile.capabilities.has("fast-mode"), true);
  assert.equal(opencode.profile.capabilities.has("fast-mode"), false);
  assert.equal(opencode.profile.capabilities.has("thinking-level"), false);
});

test("tool presentation belongs to the adapter", () => {
  const pi = createPiHarness();
  const opencode = createOpenCodeHarness();

  assert.equal(pi.tools.name("read"), "read");
  assert.equal(opencode.tools.name("read"), "workspace_read");
  assert.equal(opencode.tools.name("execute"), "workspace_execute");
  assert.equal(opencode.tools.name("write"), "workspace_write");
});

test("model utilities are independent from turn control", async () => {
  const harness = createMockHarness();

  assert.equal(typeof harness.turns.runTurn, "function");
  assert.equal(await harness.models.oneShot?.("system", "hello"), "mock one-shot reply to: hello");
  assert.equal("oneShot" in harness.turns, false);
  assert.equal("runTurn" in harness.models, false);
});
