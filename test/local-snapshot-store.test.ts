import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalSnapshotStore, type HomeSnapshotStore } from "../src/sandbox/home-snapshot.ts";

async function read(store: HomeSnapshotStore, scope: string): Promise<string | null> {
  const snapshot = await store.open(scope);
  if (!snapshot) return null;
  const parts: Uint8Array[] = [];
  for await (const part of snapshot.parts) parts.push(part);
  const bytes = Buffer.concat(parts);
  assert.equal(bytes.length, snapshot.size);
  return bytes.toString();
}

test("local snapshots survive a new store instance and keep incomplete writes hidden", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qm-render-home-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createLocalSnapshotStore(dir);
  assert.equal(await read(store, "scope"), null);
  await store.put("scope", Buffer.from("old"));
  const upload = await store.createUpload("scope");
  await upload.addPart(Buffer.from("new"));
  await upload.addPart(Buffer.from(" data"));
  assert.equal(await read(store, "scope"), "old");
  await upload.complete();
  assert.equal(await read(createLocalSnapshotStore(dir), "scope"), "new data");
  assert.equal((await readdir(dir)).length, 1);
});

test("aborting a snapshot keeps the previous file and removes the partial upload", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qm-render-home-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createLocalSnapshotStore(dir);
  await store.put("scope", Buffer.from("saved"));
  const upload = await store.createUpload("scope");
  await upload.addPart(Buffer.from("partial"));
  await upload.abort();
  await upload.abort();
  await assert.rejects(upload.addPart(Buffer.from("late")), /closed/);
  assert.equal(await read(store, "scope"), "saved");
  assert.equal((await readdir(dir)).length, 1);
});

test("snapshot scopes cannot change file paths or collide after path normalization", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qm-render-home-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createLocalSnapshotStore(dir);
  await store.put("../scope", Buffer.from("parent"));
  await store.put("scope", Buffer.from("normal"));
  await store.put("", Buffer.alloc(0));
  assert.equal(await read(store, "../scope"), "parent");
  assert.equal(await read(store, "scope"), "normal");
  assert.equal(await read(store, ""), "");
  assert.ok((await readdir(dir)).every((name) => /^[a-f0-9]{64}\.tar$/.test(name)));
  await store.delete!("scope");
  await store.delete!("scope");
  assert.equal(await read(store, "scope"), null);
  assert.equal(await read(store, "../scope"), "parent");
});

test("snapshot deletion removes an incomplete upload left by an earlier store instance", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qm-render-home-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createLocalSnapshotStore(dir);
  await store.put("keep", Buffer.from("other scope"));
  const upload = await store.createUpload("discard");
  await upload.addPart(Buffer.from("partial"));
  await createLocalSnapshotStore(dir).delete!("discard");
  assert.equal((await readdir(dir)).length, 1);
  assert.equal(await read(store, "keep"), "other scope");
  await assert.rejects(upload.complete(), { code: "ENOENT" });
  await upload.abort();
});
