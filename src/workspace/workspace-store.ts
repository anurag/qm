import { mkdir, readFile, writeFile, readdir, opendir, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname, sep } from "node:path";
import type { ScopeId } from "../types.ts";
import { scopeStorageKey } from "../util/scope-storage-key.ts";
import { createKeyedQueue } from "../util/async.ts";

export interface WorkspaceStore {
  ensureScope(scopeId: ScopeId): Promise<void>;
  read(scopeId: ScopeId, relPath: string): Promise<string | null>;
  readBytes(scopeId: ScopeId, relPath: string): Promise<Uint8Array | null>;
  write(scopeId: ScopeId, relPath: string, data: string | Uint8Array): Promise<void>;
  update(scopeId: ScopeId, relPath: string, edit: (current: string | null) => string | null): Promise<void>;
  remove(scopeId: ScopeId, relPath: string): Promise<void>;
  list(scopeId: ScopeId, opts?: { limit: number }): Promise<string[]>;
  sweep?(now?: number): Promise<number>;
}

export function normalizeWorkspacePath(path: string): string {
  const portable = path.replaceAll("\\", "/");
  const parts = portable.split("/").filter((part) => part && part !== ".");
  if (
    !parts.length ||
    portable.startsWith("/") ||
    /^[A-Za-z]:/.test(portable) ||
    parts.includes("..") ||
    path.includes("\0") ||
    !path.isWellFormed() ||
    Buffer.byteLength(parts.join("/")) > 2048
  ) {
    throw new Error(`invalid workspace path: ${path}`);
  }
  return parts.join("/");
}

export function workspaceListLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new Error("workspace list limit must be finite");
  return Math.max(0, Math.min(2147483647, Math.floor(limit)));
}

function safeJoin(baseDir: string, relPath: string): string {
  const target = resolve(baseDir, normalizeWorkspacePath(relPath));
  const rel = relative(baseDir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${relPath}`);
  }
  return target;
}

const localWrites = createKeyedQueue<string>();

export function createLocalWorkspaceStore(rootDir: string): WorkspaceStore {
  const base = resolve(rootDir, "workspaces");

  function scopeDir(scopeId: ScopeId): string {
    return join(base, scopeStorageKey(scopeId));
  }

  const store: WorkspaceStore = {
    async ensureScope(scopeId) {
      await mkdir(scopeDir(scopeId), { recursive: true });
    },
    async read(scopeId, relPath) {
      const path = safeJoin(scopeDir(scopeId), relPath);
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async readBytes(scopeId, relPath) {
      const path = safeJoin(scopeDir(scopeId), relPath);
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    },
    async write(scopeId, relPath, data) {
      const path = safeJoin(scopeDir(scopeId), relPath);
      await localWrites(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
      });
    },
    async update(scopeId, relPath, edit) {
      const path = safeJoin(scopeDir(scopeId), relPath);
      await localWrites(path, async () => {
        const next = edit(await store.read(scopeId, relPath));
        if (next === null) return;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, next);
      });
    },
    async remove(scopeId, relPath) {
      const path = safeJoin(scopeDir(scopeId), relPath);
      await localWrites(path, () => rm(path, { force: true }));
    },
    async list(scopeId, opts) {
      const limit = opts ? workspaceListLimit(opts.limit) : undefined;
      try {
        if (limit !== undefined) {
          const paths: string[] = [];
          const dirs = [scopeDir(scopeId)];
          let inspected = 0;
          while (dirs.length && paths.length < limit && inspected < limit * 8) {
            const dir = dirs.shift()!;
            for await (const entry of await opendir(dir)) {
              if (++inspected > limit * 8 || paths.length >= limit) break;
              const path = join(dir, entry.name);
              if (entry.isFile()) paths.push(relative(scopeDir(scopeId), path).split(sep).join("/"));
              else if (entry.isDirectory()) dirs.push(path);
            }
          }
          return paths;
        }
        const entries = await readdir(scopeDir(scopeId), { recursive: true, withFileTypes: true });
        return entries
          .filter((e) => e.isFile())
          .map((e) => relative(scopeDir(scopeId), join(e.parentPath, e.name)).split(sep).join("/"));
      } catch {
        return [];
      }
    },
  };
  return store;
}
