import { join, relative, resolve, isAbsolute } from "node:path";
import { createPgPool, type PoolClient } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import { createKeyedQueue } from "../util/async.ts";
import { createLocalWorkspaceStore, type WorkspaceStore } from "./workspace-store.ts";

export function createRenderWorkspaceStore(rootDir: string, connectionString: string): WorkspaceStore {
  const local = createLocalWorkspaceStore(rootDir);
  const queue = createKeyedQueue<string>();
  const db = createPgPool(connectionString, [
    {
      id: "render/workspace/0001",
      statements: [
        `CREATE TABLE IF NOT EXISTS render_workspace_files (
          scope_id TEXT NOT NULL,
          path TEXT NOT NULL,
          data BYTEA NOT NULL,
          PRIMARY KEY (scope_id, path)
        )`,
      ],
    },
  ]);
  const pathFor = (scope: ScopeId, input: string): string => {
    const base = local.scopeDir(scope);
    const path = relative(base, resolve(base, input));
    if (!path || path === ".." || path.startsWith("../") || isAbsolute(path) || input.includes("\0"))
      throw new Error(`path escapes workspace: ${input}`);
    return path;
  };
  async function mutate(scope: ScopeId, fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await (await db.pool()).connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`render-workspace:${scope}`]);
      await fn(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      });
      throw error;
    } finally {
      client.release(releaseError);
    }
  }
  async function readBytes(scope: ScopeId, relPath: string): Promise<Uint8Array | null> {
    const path = pathFor(scope, relPath);
    return queue(scope, async () => {
      const rows = await db.q("SELECT data FROM render_workspace_files WHERE scope_id=$1 AND path=$2", [scope, path]);
      if (!rows[0]) {
        await local.remove(scope, path);
        return null;
      }
      const data = rows[0].data as Buffer;
      await local.write(scope, path, data);
      return data;
    });
  }
  async function list(scope: ScopeId, opts?: { limit: number }): Promise<string[]> {
    return queue(scope, async () => {
      const limit = opts ? Math.max(0, Math.floor(opts.limit)) : null;
      if (limit !== null && !Number.isFinite(limit)) throw new Error("workspace list limit must be finite");
      const rows = await db.q(
        "SELECT path, data FROM render_workspace_files WHERE scope_id=$1 ORDER BY path LIMIT $2",
        [scope, limit],
      );
      await local.ensureScope(scope);
      const paths: string[] = [];
      for (const row of rows) {
        const path = pathFor(scope, row.path as string);
        await local.write(scope, path, row.data as Buffer);
        paths.push(join(local.scopeDir(scope), path));
      }
      if (!opts) {
        const retained = new Set(paths);
        for (const abs of await local.list(scope)) {
          if (!retained.has(abs)) await local.remove(scope, relative(local.scopeDir(scope), abs));
        }
      }
      return paths;
    });
  }
  return {
    scopeDir: local.scopeDir,
    async ensureScope(scope) {
      await list(scope);
    },
    async read(scope, path) {
      const bytes = await readBytes(scope, path);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },
    readBytes,
    async write(scope, input, data) {
      const path = pathFor(scope, input);
      await queue(scope, async () => {
        await mutate(scope, async (client) => {
          const conflict = await client.query(
            "SELECT 1 FROM render_workspace_files WHERE scope_id=$1 AND (starts_with(path, $2 || '/') OR starts_with($2, path || '/')) LIMIT 1",
            [scope, path],
          );
          if (conflict.rowCount) throw new Error(`workspace file conflicts with a directory: ${path}`);
          await client.query(
            `INSERT INTO render_workspace_files(scope_id, path, data) VALUES($1, $2, $3)
             ON CONFLICT (scope_id, path) DO UPDATE SET data=EXCLUDED.data`,
            [scope, path, Buffer.from(data)],
          );
        });
        await local.write(scope, path, data);
      });
    },
    async remove(scope, input) {
      const path = pathFor(scope, input);
      await queue(scope, async () => {
        await mutate(scope, async (client) => {
          await client.query("DELETE FROM render_workspace_files WHERE scope_id=$1 AND path=$2", [scope, path]);
        });
        await local.remove(scope, path);
      });
    },
    list,
  };
}
