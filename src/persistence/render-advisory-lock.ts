import { AsyncLocalStorage } from "node:async_hooks";
import type { AdvisoryLock } from "./advisory-lock.ts";
import type { PgPool, PoolClient } from "./pg-pool.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";

interface RenderLockSession {
  client: PoolClient;
  active: boolean;
  error?: Error;
  queue: ReturnType<typeof createKeyedQueue<string>>;
  busy: Set<string>;
}

export function createRenderAdvisoryLock(pg: PgPool, opts: { timeoutMs?: number; pollMs?: number } = {}): AdvisoryLock {
  const context = new AsyncLocalStorage<{ session: RenderLockSession; held: ReadonlySet<string> }>();
  async function acquire<T>(key: string, fn: () => Promise<T>, once: boolean): Promise<T | null> {
    const current = context.getStore();
    if (!current?.session.active) {
      const client = await (await pg.sessionPool()).connect();
      const session: RenderLockSession = { client, active: true, queue: createKeyedQueue(), busy: new Set() };
      try {
        return await context.run({ session, held: new Set() }, () => acquire(key, fn, once));
      } finally {
        session.active = false;
        client.release(session.error);
      }
    }
    if (current.held.has(key)) return fn();
    const { session } = current;
    if (once && session.busy.has(key)) return null;
    return session.queue(key, async () => {
      if (!session.active) return acquire(key, fn, once);
      session.busy.add(key);
      try {
        const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
        for (;;) {
          const result = await session.client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
            [key],
          );
          if (result.rows[0]?.locked) break;
          if (once) return null;
          if (Date.now() >= deadline) throw new Error(`timeout acquiring Render advisory lock for ${key}`);
          await sleep(opts.pollMs ?? 300);
        }
        try {
          return await context.run({ session, held: new Set([...current.held, key]) }, fn);
        } finally {
          await session.client
            .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
            .catch((error: unknown) => {
              session.error = error instanceof Error ? error : new Error(String(error));
              throw error;
            });
        }
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
