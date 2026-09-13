import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRenderWorkspaceStore } from "../src/workspace/render-workspace-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { materializeRoLayers } from "../src/sandbox/ro-layers.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL to test Render workspace storage";

test(
  "Render workspace retains bytes across cores and rebuilds the file cache for shared consumers",
  { skip },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "qm-render-workspace-"));
    const scope = scopeId("personal", randomUUID());
    const other = scopeId("personal", randomUUID());
    const db = createPgPool(databaseUrl!);
    t.after(async () => {
      await db.query("DELETE FROM render_workspace_files WHERE scope_id IN ($1,$2)", [scope, other]);
      await db.close();
      await rm(root, { recursive: true, force: true });
    });
    const a = createRenderWorkspaceStore(join(root, "first"), databaseUrl!);
    const b = createRenderWorkspaceStore(join(root, "second"), databaseUrl!);
    await a.write(scope, "memory/note.md", "retained");
    await a.write(scope, "binary", new Uint8Array([0, 255, 42]));
    assert.equal(await b.read(scope, "memory/note.md"), "retained");
    assert.equal(await b.read(other, "memory/note.md"), null);
    assert.deepEqual(await b.readBytes(scope, "binary"), Buffer.from([0, 255, 42]));
    assert.deepEqual(await b.list(scope), [
      join(b.scopeDir(scope), "binary"),
      join(b.scopeDir(scope), "memory/note.md"),
    ]);
    assert.equal(await readFile(join(b.scopeDir(scope), "memory/note.md"), "utf8"), "retained");
    await rm(b.scopeDir(scope), { recursive: true });
    await b.ensureScope(scope);
    assert.equal(await readFile(join(b.scopeDir(scope), "memory/note.md"), "utf8"), "retained");
    let tar: Uint8Array | undefined;
    await materializeRoLayers(
      b,
      [{ scopeId: scope, mode: "ro", mountPath: "shared" }],
      { id: "render", rootDir: "/root/workspace" },
      {
        readFile: async () => null,
        writeFileBytes: async (_handle, _path, bytes) => {
          tar = bytes;
        },
        exec: async () => ({ code: 0, stderr: "" }),
      },
      { label: "render", manifest: ".manifest", tar: ".layers.tar" },
    );
    assert.ok(tar?.byteLength);
    await a.write(scope, "memory/note.md", "updated");
    assert.equal(await b.read(scope, "memory/note.md"), "updated");
    await assert.rejects(a.write(scope, "memory", "conflicting file"), /conflicts with a directory/);
    await assert.rejects(a.write(scope, "binary/nested", "conflicting directory"), /conflicts with a directory/);
    assert.equal(await b.read(scope, "memory/note.md"), "updated");
    await a.remove(scope, "memory/note.md");
    assert.equal(await b.read(scope, "memory/note.md"), null);
    assert.deepEqual(await b.list(scope, { limit: 0 }), []);
    assert.equal((await b.list(scope, { limit: 1 })).length, 1);
    await assert.rejects(b.write(scope, "../escape", "bad"), /escapes workspace/);
    await assert.rejects(b.read(scope, "/etc/passwd"), /escapes workspace/);
  },
);
