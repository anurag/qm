import { task } from "@renderinc/sdk/workflows";
import { loadConfig } from "../config.ts";
import { buildApp } from "../wiring.ts";
import { migrateRegisteredPgSchemas } from "../persistence/pg-pool.ts";

task(
  { name: "qm_run", retry: { maxRetries: 0, waitDurationMs: 1_000 }, timeoutSeconds: 7_200 },
  async (_context, runId: string) => {
    if (typeof runId !== "string" || !runId || runId.length > 200) throw new Error("A QM run ID is required");
    const config = loadConfig();
    const built = buildApp(config);
    try {
      await migrateRegisteredPgSchemas(config.databaseUrl);
      await built.sandboxResources.initialize();
      await built.config.hydrate?.();
      await built.identity.hydrate();
      await built.refreshCustomProviders();
      await built.deploymentLayerReady;
      await built.processRenderRun(runId);
      return { runId };
    } finally {
      await built.runtime.stop();
    }
  },
);
