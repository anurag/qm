import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  createLocalDurableByteStore,
  createMemoryDurableByteStore,
  type DurableByteStore,
} from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { carriedFileHandles } from "../src/resolution/sharing-access.ts";
import { readContextFile } from "../src/resolution/context-files.ts";
import { materializeRoLayers } from "../src/sandbox/ro-layers.ts";
import { parseTar } from "../src/sandbox/tar.ts";
import { createPostgresWorkspaceStore } from "../src/workspace/postgres-workspace-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createScratchPromote, logPath } from "../src/memory/strategies/scratch-promote.ts";

const url = process.env.DATABASE_URL;
const pg = { skip: !url };
const scope = (): string => `personal:workspace-test-${randomUUID()}`;
const invalidPaths = [
  "../secret",
  "a/../../secret",
  "/secret",
  "\\secret",
  "C:\\secret",
  "a\\..\\secret",
  "",
  ".",
  "a\0b",
  "a\ud800b",
];

test("local workspaces list relative paths and keep scope names separate", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qm-local-workspace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = createLocalWorkspaceStore(dir);
  const second = createLocalWorkspaceStore(dir);
  await first.write("channel:a/b", "folder/report.txt", "first");
  await second.write("channel:a?b", "folder/report.txt", "second");
  assert.deepEqual(await second.list("channel:a/b"), ["folder/report.txt"]);
  assert.equal(await second.read("channel:a/b", "folder/report.txt"), "first");
  assert.equal(await first.read("channel:a?b", "folder/report.txt"), "second");
  for (const path of invalidPaths) {
    await assert.rejects(first.write("channel:a/b", path, "escape"), /invalid workspace path/);
    await assert.rejects(first.read("channel:a/b", path), /invalid workspace path/);
    await assert.rejects(first.readBytes("channel:a/b", path), /invalid workspace path/);
    await assert.rejects(first.remove("channel:a/b", path), /invalid workspace path/);
  }
  assert.deepEqual(await first.list("channel:a/b", { limit: 0 }), []);
  await assert.rejects(first.list("channel:a/b", { limit: NaN }), /limit must be finite/);
});

test("local workspace updates serialize across instances and path aliases", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qm-local-workspace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = createLocalWorkspaceStore(dir);
  const second = createLocalWorkspaceStore(dir);
  const owner = scope();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? first : second).update(owner, i % 2 ? "count.txt" : "./count.txt", (value) => String(Number(value) + 1)),
    ),
  );
  assert.equal(await first.read(owner, "count.txt"), "20");
  await first.update(owner, "count.txt", () => null);
  assert.equal(await second.read(owner, "count.txt"), "20");
});

test("workspace bytes and relative paths survive store recreation", pg, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qm-workspace-bytes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = scope();
  const other = `${owner}/other`;
  const first = createPostgresWorkspaceStore(url!, createLocalDurableByteStore(dir));
  await first.write(owner, "folder/report.txt", "persisted");
  await first.write(owner, "binary.dat", Uint8Array.from([0, 255, 1]));
  await first.write(other, "folder/report.txt", "other");
  const restarted = createPostgresWorkspaceStore(url!, createLocalDurableByteStore(dir));
  assert.equal(await restarted.read(owner, "./folder//report.txt"), "persisted");
  assert.deepEqual(await restarted.readBytes(owner, "binary.dat"), Buffer.from([0, 255, 1]));
  assert.equal(await restarted.read(other, "folder/report.txt"), "other");
  assert.equal(await restarted.read(`${owner}?other`, "folder/report.txt"), null);
  assert.deepEqual(await restarted.list(owner), ["binary.dat", "folder/report.txt"]);
  assert.deepEqual(await restarted.list(owner, { limit: 1 }), ["binary.dat"]);
  assert.deepEqual(await restarted.list(owner, { limit: 0 }), []);
  await restarted.remove(owner, "folder/report.txt");
  assert.equal(await first.read(owner, "folder/report.txt"), null);
  assert.equal(await first.read(other, "folder/report.txt"), "other");
});

test("durable workspace paths cannot cross scopes or escape their namespace", pg, async () => {
  const store = createPostgresWorkspaceStore(url!, createMemoryDurableByteStore());
  const owner = scope();
  for (const path of [...invalidPaths, "x".repeat(2049)]) {
    await assert.rejects(store.write(owner, path, "escape"), /invalid workspace path/);
    await assert.rejects(store.read(owner, path), /invalid workspace path/);
    await assert.rejects(store.readBytes(owner, path), /invalid workspace path/);
    await assert.rejects(store.remove(owner, path), /invalid workspace path/);
    await assert.rejects(
      store.update(owner, path, () => "escape"),
      /invalid workspace path/,
    );
  }
  await store.write(owner, "folder\\report.txt", "normalized");
  assert.equal(await store.read(owner, "folder/report.txt"), "normalized");
  assert.deepEqual(await store.list(owner), ["folder/report.txt"]);
  await assert.rejects(store.list(owner, { limit: Infinity }), /limit must be finite/);
});

test("durable workspace updates serialize across cores", pg, async () => {
  const bytes = createMemoryDurableByteStore();
  const first = createPostgresWorkspaceStore(url!, bytes);
  const second = createPostgresWorkspaceStore(url!, bytes);
  const owner = scope();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? first : second).update(owner, "count.txt", (value) => String(Number(value) + 1)),
    ),
  );
  assert.equal(await second.read(owner, "count.txt"), "20");
  await first.update(owner, "count.txt", () => null);
  assert.equal(await second.read(owner, "count.txt"), "20");
  await first.remove(owner, "count.txt");
  await second.update(owner, "count.txt", (value) => String(Number(value) + 1));
  assert.equal(await first.read(owner, "count.txt"), "1");
});

test("failed byte and metadata writes leave the prior workspace version intact", pg, async () => {
  const backing = createMemoryDurableByteStore();
  let failure: "bytes" | "metadata" | undefined;
  let deletes = 0;
  const bytes: DurableByteStore = {
    ...backing,
    async put(value, opts) {
      if (failure === "bytes") throw new Error("object upload failed");
      const result = await backing.put(value, opts);
      return failure === "metadata" ? { ...result, sizeBytes: NaN } : result;
    },
    async delete() {
      deletes++;
    },
  };
  const store = createPostgresWorkspaceStore(url!, bytes);
  const owner = scope();
  await store.write(owner, "file.txt", "original");
  failure = "bytes";
  await assert.rejects(store.write(owner, "file.txt", "new"), /object upload failed/);
  assert.equal(await store.read(owner, "file.txt"), "original");
  failure = "metadata";
  await assert.rejects(store.write(owner, "file.txt", "new"), /bigint/);
  assert.equal(await store.read(owner, "file.txt"), "original");
  assert.equal(deletes, 0);
  failure = undefined;
  await store.update(owner, "file.txt", (current) => `${current} updated`);
  assert.equal(await store.read(owner, "file.txt"), "original updated");
});

test("workspace deletion retains bytes used by other files and pending readers", pg, async () => {
  const bytes = createMemoryDurableByteStore();
  const owner = scope();
  const first = createPostgresWorkspaceStore(url!, bytes);
  const second = createPostgresWorkspaceStore(url!, bytes);
  await first.write(owner, "one.txt", "shared");
  await second.write(owner, "two.txt", "shared");
  const ref = await bytes.put(Buffer.from("shared"));
  await first.write(owner, "one.txt", "changed");
  await first.remove(owner, "two.txt");
  assert.ok(await bytes.open(ref.blobKey));
  assert.equal(await first.read(owner, "one.txt"), "changed");
});

test("missing and corrupt workspace bytes fail without returning an absent file", pg, async () => {
  const backing = createMemoryDurableByteStore();
  let mode: "missing" | "corrupt" | undefined;
  const bytes: DurableByteStore = {
    ...backing,
    async open(key) {
      if (mode === "missing") return null;
      if (mode === "corrupt") return { sizeBytes: 4, stream: Readable.from(Buffer.from("oops")) };
      return backing.open(key);
    },
  };
  const owner = scope();
  const store = createPostgresWorkspaceStore(url!, bytes);
  await store.write(owner, "file.txt", "data");
  mode = "missing";
  await assert.rejects(store.read(owner, "file.txt"), /bytes are missing/);
  mode = "corrupt";
  await assert.rejects(store.readBytes(owner, "file.txt"), /do not match metadata/);
  assert.equal(await store.read(owner, "absent.txt"), null);
});

test("shared handles and read-only scope layers use durable workspace bytes", pg, async () => {
  const bytes = createMemoryDurableByteStore();
  const owner = scope();
  await createPostgresWorkspaceStore(url!, bytes).write(owner, "docs/report.txt", "shared report");
  const restarted = createPostgresWorkspaceStore(url!, bytes);
  const files = createMemoryFileArtifactStore(bytes);
  const handles = await carriedFileHandles([owner], restarted, files);
  assert.equal(handles.length, 1);
  const opened = await readContextFile(handles[0]!.handlePath, handles, restarted, files);
  assert.ok(opened && "bytes" in opened);
  assert.equal(Buffer.from(opened.bytes!).toString(), "shared report");
  let archive: Uint8Array | undefined;
  await materializeRoLayers(
    restarted,
    [{ scopeId: owner, mode: "ro", mountPath: "team" }],
    { id: "sandbox", rootDir: "/workspace" },
    {
      readFile: async () => null,
      writeFileBytes: async (_handle, _path, data) => {
        archive = data;
      },
      exec: async () => ({ code: 0, stderr: "" }),
    },
    { manifest: "manifest", tar: "layers.tar", label: "test" },
  );
  assert.ok(archive);
  const entries = await parseTar(archive);
  assert.equal(entries.find((entry) => entry.path === "team/docs/report.txt")?.data.toString(), "shared report");
});

test("scratch captures from separate cores retain both facts and deduplicate repeats", pg, async () => {
  const bytes = createMemoryDurableByteStore();
  const owner = scope();
  const first = createPostgresWorkspaceStore(url!, bytes);
  const second = createPostgresWorkspaceStore(url!, bytes);
  const build = (workspace: typeof first) =>
    createScratchPromote({
      harness: {},
      memory: createPostgresMemoryService(url!),
      workspace,
      consolidateAfter: 0,
    }).memory;
  const firstMemory = build(first);
  const secondMemory = build(second);
  const now = Date.now();
  const captured = await Promise.all([
    firstMemory.capture(owner, ["Owns billing", "Prefers short replies"], now),
    secondMemory.capture(owner, ["Owns billing", "Uses Postgres"], now),
  ]);
  assert.equal(
    captured.reduce((total, count) => total + count, 0),
    3,
  );
  const log = await createPostgresWorkspaceStore(url!, bytes).read(owner, logPath(now));
  assert.equal(log?.match(/Owns billing/g)?.length, 1);
  assert.match(log ?? "", /Prefers short replies/);
  assert.match(log ?? "", /Uses Postgres/);
});

test("workspace cleanup retains identical content in another scope and reclaims the last reference", pg, async () => {
  const bytes = createMemoryDurableByteStore();
  const first = createPostgresWorkspaceStore(url!, bytes);
  const second = createPostgresWorkspaceStore(url!, bytes);
  const owner = scope();
  const other = scope();
  const content = Buffer.from(owner);
  const ref = await bytes.put(content);
  await first.write(owner, "file.txt", content);
  await second.write(other, "copy.txt", content);
  await first.write(owner, "file.txt", `${owner} replacement`);
  await first.sweep!();
  assert.equal(await second.read(other, "copy.txt"), owner);
  assert.ok(await bytes.open(ref.blobKey));
  await second.remove(other, "copy.txt");
  await createPostgresWorkspaceStore(url!, bytes).sweep!();
  assert.equal(await bytes.open(ref.blobKey), null);
  assert.equal(await first.read(owner, "file.txt"), `${owner} replacement`);
});

test("workspace cleanup waits for a reader of a replaced version", pg, async () => {
  const backing = createMemoryDurableByteStore();
  const owner = scope();
  const prior = await backing.put(Buffer.from(owner));
  const opened = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let pause = true;
  const bytes: DurableByteStore = {
    ...backing,
    async open(key) {
      if (pause && key === prior.blobKey) {
        pause = false;
        opened.resolve();
        await resume.promise;
      }
      return backing.open(key);
    },
  };
  const first = createPostgresWorkspaceStore(url!, bytes);
  const second = createPostgresWorkspaceStore(url!, bytes);
  await first.write(owner, "file.txt", owner);
  const reading = first.read(owner, "file.txt");
  await opened.promise;
  try {
    await second.write(owner, "file.txt", `${owner} replacement`);
    await second.sweep!();
    assert.ok(await backing.open(prior.blobKey));
  } finally {
    resume.resolve();
  }
  assert.equal(await reading, owner);
  await second.sweep!(Date.now() + 60_001);
  assert.equal(await backing.open(prior.blobKey), null);
  assert.equal(await first.read(owner, "file.txt"), `${owner} replacement`);
});

test("workspace cleanup cannot remove bytes before an active upload publishes its file record", pg, async () => {
  const backing = createMemoryDurableByteStore();
  const owner = scope();
  const ref = await backing.put(Buffer.from(owner));
  const uploaded = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const bytes: DurableByteStore = {
    ...backing,
    async put(source, opts) {
      const result = await backing.put(source, opts);
      uploaded.resolve();
      await resume.promise;
      return result;
    },
  };
  const writer = createPostgresWorkspaceStore(url!, bytes);
  const other = createPostgresWorkspaceStore(url!, backing);
  const writing = writer.write(owner, "file.txt", owner);
  await uploaded.promise;
  try {
    await other.sweep!();
    assert.ok(await backing.open(ref.blobKey));
  } finally {
    resume.resolve();
  }
  await writing;
  await other.sweep!(Date.now() + 60_001);
  assert.equal(await other.read(owner, "file.txt"), owner);
});

test("failed workspace metadata writes leave durable cleanup work", pg, async () => {
  const bytes = createMemoryDurableByteStore();
  const owner = scope();
  const ref = await bytes.put(Buffer.from(owner));
  const broken = createPostgresWorkspaceStore(url!, {
    ...bytes,
    async put(source, opts) {
      return { ...(await bytes.put(source, opts)), sizeBytes: NaN };
    },
  });
  await assert.rejects(broken.write(owner, "file.txt", owner), /bigint/);
  assert.ok(await bytes.open(ref.blobKey));
  const restarted = createPostgresWorkspaceStore(url!, bytes);
  assert.equal(await restarted.read(owner, "file.txt"), null);
  await restarted.sweep!(Date.now() + 60_001);
  assert.equal(await bytes.open(ref.blobKey), null);
});

test("workspace cleanup recovers an upload after the writer process exits before metadata commit", pg, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qm-workspace-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = scope();
  const source = `
    import { createLocalDurableByteStore } from ${JSON.stringify(new URL("../src/files/durable-byte-store.ts", import.meta.url).href)};
    import { createPostgresWorkspaceStore } from ${JSON.stringify(new URL("../src/workspace/postgres-workspace-store.ts", import.meta.url).href)};
    const bytes = createLocalDurableByteStore(process.env.WORKSPACE_TEST_DIR);
    const interrupted = { ...bytes, put: async (value) => { await bytes.put(value); process.exit(0); } };
    await createPostgresWorkspaceStore(process.env.DATABASE_URL, interrupted).write(process.env.WORKSPACE_TEST_SCOPE, "file.txt", process.env.WORKSPACE_TEST_SCOPE);
  `;
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, WORKSPACE_TEST_DIR: dir, WORKSPACE_TEST_SCOPE: owner },
  });
  const bytes = createLocalDurableByteStore(dir);
  const ref = await createMemoryDurableByteStore().put(Buffer.from(owner));
  assert.ok(await bytes.open(ref.blobKey));
  const restarted = createPostgresWorkspaceStore(url!, bytes);
  assert.equal(await restarted.read(owner, "file.txt"), null);
  await restarted.sweep!(Date.now() + 60_001);
  assert.equal(await bytes.open(ref.blobKey), null);
});

test("workspace cleanup retries failed deletion after a restart", pg, async () => {
  const bytes = createMemoryDurableByteStore();
  const owner = scope();
  const ref = await bytes.put(Buffer.from(owner));
  const broken = createPostgresWorkspaceStore(url!, {
    ...bytes,
    async delete(key) {
      if (key === ref.blobKey) throw new Error("object deletion failed");
      await bytes.delete(key);
    },
  });
  await broken.write(owner, "file.txt", owner);
  await broken.remove(owner, "file.txt");
  await broken.sweep!(Date.now() + 60_001);
  assert.ok(await bytes.open(ref.blobKey));
  await createPostgresWorkspaceStore(url!, bytes).sweep!(Date.now() + 120_002);
  assert.equal(await bytes.open(ref.blobKey), null);
});

test("workspace operations complete with one database session slot", pg, async () => {
  const source = `
    import assert from "node:assert/strict";
    import { createMemoryDurableByteStore } from ${JSON.stringify(new URL("../src/files/durable-byte-store.ts", import.meta.url).href)};
    import { createPostgresWorkspaceStore } from ${JSON.stringify(new URL("../src/workspace/postgres-workspace-store.ts", import.meta.url).href)};
    import { configurePgPooling } from ${JSON.stringify(new URL("../src/persistence/pg-pool.ts", import.meta.url).href)};
    const url = process.env.DATABASE_URL;
    configurePgPooling({ databaseUrl: url, sessionMax: 1, queryMax: 1 });
    const bytes = createMemoryDurableByteStore();
    const first = createPostgresWorkspaceStore(url, bytes);
    const second = createPostgresWorkspaceStore(url, bytes);
    const owner = process.env.WORKSPACE_TEST_SCOPE;
    await first.write(owner, "count.txt", "0");
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).update(owner, "count.txt", (value) => String(Number(value) + 1))),
      ...Array.from({ length: 12 }, (_, i) => first.write(owner, "file-" + i, owner + i)),
    ]);
    assert.equal(await second.read(owner, "count.txt"), "8");
    assert.equal((await second.list(owner)).length, 13);
    await second.remove(owner, "file-0");
    await first.sweep();
    assert.equal(await second.read(owner, "file-0"), null);
    process.exit(0);
  `;
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, WORKSPACE_TEST_SCOPE: scope() },
    timeout: 20_000,
  });
});
