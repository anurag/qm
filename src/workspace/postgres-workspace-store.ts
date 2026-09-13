import { createHash } from "node:crypto";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import { createPostgresAdvisoryLock } from "../persistence/advisory-lock.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import { collectBytes } from "../util/bytes.ts";
import { swallowAs } from "../util/errors.ts";
import { normalizeWorkspacePath, workspaceListLimit, type WorkspaceStore } from "./workspace-store.ts";

export function createPostgresWorkspaceStore(connectionString: string, bytes: DurableByteStore): WorkspaceStore {
  const db = createPgPool(connectionString, [
    {
      id: "workspace/files/0001",
      statements: [
        `CREATE TABLE IF NOT EXISTS workspace_files (
          scope_id TEXT NOT NULL,
          path TEXT NOT NULL,
          blob_key TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          sha256 TEXT NOT NULL,
          PRIMARY KEY (scope_id, path)
        )`,
      ],
    },
    {
      id: "workspace/files/0002",
      statements: [
        `CREATE TABLE IF NOT EXISTS workspace_blobs (
          blob_key TEXT PRIMARY KEY,
          next_cleanup_at BIGINT NOT NULL DEFAULT 0
        )`,
        "CREATE INDEX IF NOT EXISTS workspace_files_blob ON workspace_files(blob_key)",
        "CREATE INDEX IF NOT EXISTS workspace_blobs_cleanup ON workspace_blobs(next_cleanup_at, blob_key)",
        "INSERT INTO workspace_blobs(blob_key) SELECT DISTINCT blob_key FROM workspace_files ON CONFLICT DO NOTHING",
      ],
    },
  ]);
  const lock = createPostgresAdvisoryLock(db);
  const blobLockKey = (key: string): string => `workspace-blob:${key}`;

  async function fileRow(scope: ScopeId, path: string) {
    const rows = await db.q("SELECT blob_key, size_bytes, sha256 FROM workspace_files WHERE scope_id=$1 AND path=$2", [
      scope,
      path,
    ]);
    return rows[0] ?? null;
  }

  async function readVersion(scope: ScopeId, path: string): Promise<{ data: Uint8Array; blobKey: string } | null> {
    for (;;) {
      const row = await fileRow(scope, path);
      if (!row) return null;
      const data = await lock.withLock(blobLockKey(row.blob_key as string), async () => {
        const current = await fileRow(scope, path);
        if (!current) return null;
        if (current.blob_key !== row.blob_key) return undefined;
        const blob = await bytes.open(row.blob_key as string);
        if (!blob) throw new Error(`workspace file bytes are missing: ${path}`);
        const collected = await collectBytes(blob.stream, { maxBytes: Number(current.size_bytes) });
        if (collected.sizeBytes !== Number(current.size_bytes) || collected.sha256 !== current.sha256)
          throw new Error(`workspace file bytes do not match metadata: ${path}`);
        return { data: collected.data, blobKey: row.blob_key as string };
      });
      if (data !== undefined) return data;
    }
  }

  async function write(
    scope: ScopeId,
    path: string,
    data: string | Uint8Array,
    expected?: string | null,
  ): Promise<boolean> {
    const source = Buffer.from(data);
    const key = `files/${createHash("sha256").update(source).digest("hex")}`;
    return lock.withLock(blobLockKey(key), async () => {
      await db.query("INSERT INTO workspace_blobs(blob_key) VALUES($1) ON CONFLICT DO NOTHING", [key]);
      const blob = await bytes.put(source);
      if (blob.blobKey !== key) throw new Error("workspace byte store must use content-addressed keys");
      const params = [scope, path, blob.blobKey, blob.sizeBytes, blob.sha256];
      const result =
        typeof expected === "string"
          ? await db.query(
              `UPDATE workspace_files SET blob_key=$3, size_bytes=$4, sha256=$5
             WHERE scope_id=$1 AND path=$2 AND blob_key=$6`,
              [...params, expected],
            )
          : await db.query(
              `INSERT INTO workspace_files(scope_id, path, blob_key, size_bytes, sha256) VALUES($1, $2, $3, $4, $5)
             ON CONFLICT (scope_id, path) ${expected === null ? "DO NOTHING" : "DO UPDATE SET blob_key=EXCLUDED.blob_key, size_bytes=EXCLUDED.size_bytes, sha256=EXCLUDED.sha256"}`,
              params,
            );
      return result.rowCount === 1;
    });
  }

  return {
    async ensureScope() {
      await db.pool();
    },
    async read(scope, relPath) {
      const version = await readVersion(scope, normalizeWorkspacePath(relPath));
      return version === null ? null : Buffer.from(version.data).toString("utf8");
    },
    readBytes: async (scope, relPath) => (await readVersion(scope, normalizeWorkspacePath(relPath)))?.data ?? null,
    async write(scope, relPath, data) {
      const path = normalizeWorkspacePath(relPath);
      await write(scope, path, data);
    },
    async update(scope, relPath, edit) {
      const path = normalizeWorkspacePath(relPath);
      for (;;) {
        const current = await readVersion(scope, path);
        const next = edit(current === null ? null : Buffer.from(current.data).toString("utf8"));
        if (next === null || (await write(scope, path, next, current?.blobKey ?? null))) return;
      }
    },
    async remove(scope, relPath) {
      const path = normalizeWorkspacePath(relPath);
      await db.query("DELETE FROM workspace_files WHERE scope_id=$1 AND path=$2", [scope, path]);
    },
    async list(scope, opts) {
      const limit = opts ? workspaceListLimit(opts.limit) : null;
      if (limit === 0) return [];
      return (
        await db.q("SELECT path FROM workspace_files WHERE scope_id=$1 ORDER BY path LIMIT $2", [scope, limit])
      ).map((row) => row.path as string);
    },
    async sweep(now = Date.now()) {
      const candidates = await db.q(
        `WITH candidates AS (
          SELECT blob_key FROM workspace_blobs b WHERE next_cleanup_at <= $1
            AND NOT EXISTS (SELECT 1 FROM workspace_files f WHERE f.blob_key=b.blob_key)
          ORDER BY next_cleanup_at, blob_key FOR UPDATE SKIP LOCKED LIMIT 100
        ) UPDATE workspace_blobs b SET next_cleanup_at=$1+60000 FROM candidates c
          WHERE b.blob_key=c.blob_key RETURNING b.blob_key`,
        [now],
      );
      let removed = 0;
      for (const row of candidates) {
        const key = row.blob_key as string;
        const deleted = await lock.tryWithLock!(blobLockKey(key), async () => {
          if ((await db.q("SELECT 1 FROM workspace_files WHERE blob_key=$1 LIMIT 1", [key])).length) return false;
          await bytes.delete(key);
          await db.query("DELETE FROM workspace_blobs WHERE blob_key=$1", [key]);
          return true;
        }).catch(swallowAs("workspace: blob cleanup", false));
        if (deleted) removed++;
      }
      return removed;
    },
  };
}
