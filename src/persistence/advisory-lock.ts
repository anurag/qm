import { AsyncLocalStorage } from "node:async_hooks";
import type { PgPool, PoolClient } from "./pg-pool.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";

export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  tryWithLock?<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ADVISORY_LOCK_POLL_MS = 300;

export function createNoopAdvisoryLock(): AdvisoryLock {
  return {
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async tryWithLock<T>(_key: string, fn: () => Promise<T>): Promise<T | null> {
      return fn();
    },
  };
}

export function createMemoryAdvisoryLock(): AdvisoryLock {
  const queue = createKeyedQueue<string>();
  const held = new Set<string>();
  const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
    queue(key, async () => {
      held.add(key);
      try {
        return await fn();
      } finally {
        held.delete(key);
      }
    });
  return {
    withLock,
    async tryWithLock(key, fn) {
      if (held.has(key)) return null;
      return withLock(key, fn);
    },
  };
}

interface LockSession {
  client: PoolClient;
  borrowers: number;
  reserved: Set<string>;
  failed: boolean;
}

interface LockScope {
  session: LockSession;
  key: string;
  parent?: LockScope;
  active: boolean;
}

export function createPostgresAdvisoryLock(
  pg: PgPool,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): AdvisoryLock {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADVISORY_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ADVISORY_LOCK_POLL_MS;
  const scopes = new AsyncLocalStorage<LockScope>();
  const release = (session: LockSession) => {
    if (--session.borrowers === 0) session.client.release(session.failed);
  };
  const query = async (session: LockSession, sql: string, key: string) => {
    try {
      return await session.client.query<{ locked: boolean }>(sql, [key]);
    } catch (error) {
      session.failed = true;
      throw error;
    }
  };
  const run = async <T>(key: string, fn: () => Promise<T>, wait: boolean): Promise<T | null> => {
    const inherited = scopes.getStore();
    const parent = inherited?.active ? inherited : undefined;
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.active && ancestor.key === key) {
        if (!wait) return null;
        throw new Error(`advisory lock is already held by this callback for ${key}`);
      }
    }
    const borrowed = parent?.session;
    if (borrowed?.failed) throw new Error("advisory lock session failed");
    if (borrowed) borrowed.borrowers++;
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        const session = borrowed ?? {
          client: await (await pg.sessionPool()).connect(),
          borrowers: 1,
          reserved: new Set<string>(),
          failed: false,
        };
        try {
          if (session.failed) throw new Error("advisory lock session failed");
          if (!session.reserved.has(key)) {
            session.reserved.add(key);
            try {
              const result = await query(
                session,
                "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
                key,
              );
              if (result.rows[0]?.locked === true) {
                const scope: LockScope = { session, key, parent, active: true };
                try {
                  if (session.failed) throw new Error("advisory lock session failed");
                  return await scopes.run(scope, fn);
                } finally {
                  scope.active = false;
                  await query(session, "SELECT pg_advisory_unlock(hashtextextended($1, 0))", key);
                }
              }
            } finally {
              session.reserved.delete(key);
            }
          }
        } finally {
          if (!borrowed) release(session);
        }
        if (!wait) return null;
        if (Date.now() >= deadline) throw new Error(`timeout acquiring advisory lock for ${key}`);
        await sleep(pollMs);
      }
    } finally {
      if (borrowed) release(borrowed);
    }
  };
  return {
    withLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, true) as Promise<T>,
    tryWithLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, false),
  };
}
