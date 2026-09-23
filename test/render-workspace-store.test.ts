import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRenderWorkspaceStore } from "../src/workspace/render-workspace-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { materializeRoLayers } from "../src/sandbox/ro-layers.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL to test Render workspace storage";

async function workspaces(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "qm-render-workspace-"));
  const scope = scopeId("personal", randomUUID());
  const other = scopeId("personal", randomUUID());
  const db = createPgPool(databaseUrl!);
  t.after(async () => {
    await db.query("DELETE FROM render_workspace_files WHERE scope_id IN ($1,$2)", [scope, other]);
    await db.query("DELETE FROM render_workspace_scopes WHERE scope_id IN ($1,$2)", [scope, other]);
    await db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    scope,
    other,
    db,
    core: (name: string) => createRenderWorkspaceStore(join(root, name), databaseUrl!),
  };
}

test(
  "Render workspace retains bytes across cores and rebuilds the file cache for shared consumers",
  { skip },
  async (t) => {
    const { scope, other, core } = await workspaces(t);
    const a = core("first");
    const b = core("second");
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

test("Render workspace imports files a local workspace store left in its directory", { skip }, async (t) => {
  const { root, scope, core } = await workspaces(t);
  const legacy = createLocalWorkspaceStore(join(root, "first"));
  await legacy.write(scope, "memory/MEMORY.md", "kept");
  await legacy.write(scope, "notes/old.md", "kept too");
  const first = core("first");
  await first.ensureScope(scope);
  assert.equal(await first.read(scope, "memory/MEMORY.md"), "kept");
  const second = core("second");
  assert.equal(await second.read(scope, "notes/old.md"), "kept too");
  await second.remove(scope, "notes/old.md");
  const restarted = core("first");
  await restarted.ensureScope(scope);
  assert.equal(existsSync(join(restarted.scopeDir(scope), "notes/old.md")), false);
  assert.equal(await restarted.read(scope, "notes/old.md"), null);
  assert.equal(await restarted.read(scope, "memory/MEMORY.md"), "kept");
});

test(
  "Render workspace keeps its file cache while a scope is unchanged and refreshes it after another core writes",
  { skip },
  async (t) => {
    const { scope, core } = await workspaces(t);
    const first = core("first");
    const second = core("second");
    await first.write(scope, "notes/a.md", "one");
    await second.ensureScope(scope);
    const cached = join(second.scopeDir(scope), "notes/a.md");
    const loaded = (await stat(cached)).mtimeMs;
    await second.ensureScope(scope);
    await second.write(scope, "notes/b.md", "own write");
    await second.ensureScope(scope);
    assert.equal((await stat(cached)).mtimeMs, loaded);
    await first.write(scope, "notes/a.md", "two");
    await second.ensureScope(scope);
    assert.equal(await readFile(cached, "utf8"), "two");
    await first.remove(scope, "notes/b.md");
    await second.ensureScope(scope);
    assert.equal(existsSync(join(second.scopeDir(scope), "notes/b.md")), false);
  },
);

test(
  "Render workspace keeps legacy files it cannot read and imports them once they are readable",
  { skip: skip || (process.getuid?.() === 0 ? "file modes do not stop root" : false) },
  async (t) => {
    const { root, scope, core } = await workspaces(t);
    const legacy = createLocalWorkspaceStore(join(root, "first"));
    await legacy.write(scope, "notes/kept.md", "readable");
    await legacy.write(scope, "notes/locked.md", "unreadable");
    const locked = join(legacy.scopeDir(scope), "notes/locked.md");
    await chmod(locked, 0o000);
    t.after(() => chmod(locked, 0o644).catch(() => undefined));
    await assert.rejects(core("first").ensureScope(scope), { code: "EACCES" });
    assert.equal(existsSync(join(legacy.scopeDir(scope), "notes/kept.md")), true);
    assert.equal(await core("second").read(scope, "notes/kept.md"), null);
    await chmod(locked, 0o644);
    const first = core("first");
    await first.ensureScope(scope);
    assert.equal(await core("second").read(scope, "notes/locked.md"), "unreadable");
    assert.equal(await first.read(scope, "notes/kept.md"), "readable");
  },
);

test("Render workspace refreshes a core's file cache after a writer that bypasses the store", { skip }, async (t) => {
  const { scope, other, db, core } = await workspaces(t);
  const first = core("first");
  await first.write(scope, "shared/report.md", "one");
  await first.ensureScope(scope);
  await db.query("UPDATE render_workspace_files SET data=$3 WHERE scope_id=$1 AND path=$2", [
    scope,
    "shared/report.md",
    Buffer.from("two"),
  ]);
  await first.ensureScope(scope);
  assert.equal(await readFile(join(first.scopeDir(scope), "shared/report.md"), "utf8"), "two");
  await first.ensureScope(other);
  await db.query("UPDATE render_workspace_files SET scope_id=$2 WHERE scope_id=$1", [scope, other]);
  await first.ensureScope(scope);
  await first.ensureScope(other);
  assert.equal(existsSync(join(first.scopeDir(scope), "shared/report.md")), false);
  assert.equal(await readFile(join(first.scopeDir(other), "shared/report.md"), "utf8"), "two");
});

test("Render workspace gives its file cache the shape that Postgres has for a path", { skip }, async (t) => {
  const { root, scope, core } = await workspaces(t);
  const first = core("first");
  const second = core("second");
  await first.write(scope, "report/part.md", "part");
  await second.ensureScope(scope);
  await first.remove(scope, "report/part.md");
  await first.write(scope, "report", "whole");
  assert.equal(await first.read(scope, "report"), "whole");
  await second.ensureScope(scope);
  assert.equal(await readFile(join(second.scopeDir(scope), "report"), "utf8"), "whole");
  await second.remove(scope, "report");
  await second.write(scope, "report/part.md", "again");
  await first.ensureScope(scope);
  assert.equal(await readFile(join(first.scopeDir(scope), "report/part.md"), "utf8"), "again");
  assert.equal(await first.read(scope, "report"), null);
  const legacy = createLocalWorkspaceStore(join(root, "third"));
  await legacy.write(scope, "report/part.md/old.md", "conflicting legacy file");
  const third = core("third");
  await third.ensureScope(scope);
  assert.equal(await readFile(join(third.scopeDir(scope), "report/part.md"), "utf8"), "again");
  assert.equal(await third.read(scope, "report/part.md/old.md"), null);
});
