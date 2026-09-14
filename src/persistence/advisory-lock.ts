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
  active: boolean;
  error?: Error;
  queue: ReturnType<typeof createKeyedQueue<string>>;
  busy: Set<string>;
}

export function createPostgresAdvisoryLock(
  pg: PgPool,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): AdvisoryLock {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADVISORY_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ADVISORY_LOCK_POLL_MS;
  const context = new AsyncLocalStorage<{ session: LockSession; held: ReadonlySet<string> }>();
  const timeout = (key: string) => new Error(`timeout acquiring advisory lock for ${key}`);
  async function tryLock(client: PoolClient, key: string): Promise<boolean> {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [key],
    );
    return result.rows[0]?.locked === true;
  }
  async function hold<T>(
    session: LockSession,
    held: ReadonlySet<string>,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await context.run({ session, held: new Set([...held, key]) }, fn);
    } finally {
      await session.client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
        .catch((error: unknown) => {
          session.error = error instanceof Error ? error : new Error(String(error));
          throw error;
        });
    }
  }
  async function open<T>(key: string, fn: () => Promise<T>, once: boolean): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    const pool = await pg.sessionPool();
    for (;;) {
      const client = await pool.connect();
      const session: LockSession = { client, active: true, queue: createKeyedQueue(), busy: new Set() };
      try {
        if (await tryLock(client, key)) return await hold(session, new Set(), key, fn);
      } finally {
        session.active = false;
        client.release(session.error);
      }
      if (once) return null;
      if (Date.now() >= deadline) throw timeout(key);
      await sleep(pollMs);
    }
  }
  async function acquire<T>(key: string, fn: () => Promise<T>, once: boolean): Promise<T | null> {
    const current = context.getStore();
    if (!current?.session.active) return open(key, fn, once);
    if (current.held.has(key)) return fn();
    const { session } = current;
    if (once && session.busy.has(key)) return null;
    return session.queue(key, async () => {
      if (!session.active) return acquire(key, fn, once);
      session.busy.add(key);
      try {
        const deadline = Date.now() + timeoutMs;
        while (!(await tryLock(session.client, key))) {
          if (once) return null;
          if (Date.now() >= deadline) throw timeout(key);
          await sleep(pollMs);
        }
        return await hold(session, current.held, key, fn);
      } finally {
        session.busy.delete(key);
      }
    });
  }
  return {
    withLock: <T>(key: string, fn: () => Promise<T>) => acquire(key, fn, false) as Promise<T>,
    tryWithLock: <T>(key: string, fn: () => Promise<T>) => acquire(key, fn, true),
  };
}
