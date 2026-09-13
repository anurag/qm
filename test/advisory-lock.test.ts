import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
  type SandboxResourceRollout,
} from "../src/sandbox/sandbox-resources.ts";
import type { SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresAdvisoryLock, createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the advisory-lock tests";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("no-op mutex: withLock runs fn and returns its value (single-instance dev/test path)", async () => {
  const lock = createNoopAdvisoryLock();
  let ran = 0;
  const out = await lock.withLock("deploy:any", async () => {
    ran++;
    return 42;
  });
  assert.equal(out, 42, "returns fn's result");
  assert.equal(ran, 1, "ran fn exactly once");
});

test(
  "pg mutex: the SAME key serializes — the two fns never overlap (one finishes before the other starts)",
  { skip },
  async () => {
    const pgA = createPgPool(URL!);
    const pgB = createPgPool(URL!);
    try {
      const lockA = createPostgresAdvisoryLock(pgA, { pollMs: 20 });
      const lockB = createPostgresAdvisoryLock(pgB, { pollMs: 20 });
      let active = 0;
      let maxActive = 0;
      const order: string[] = [];
      const body = (tag: string) => async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`${tag}:start`);
        await sleep(80);
        order.push(`${tag}:end`);
        active--;
      };
      await Promise.all([lockA.withLock("deploy:same", body("A")), lockB.withLock("deploy:same", body("B"))]);
      assert.equal(maxActive, 1, "the two fns never overlapped (serialized)");
      assert.equal(order.length, 4, "both fns ran to completion");
      assert.equal(order[1], `${order[0]!.split(":")[0]}:end`, "the first fn ends before the second begins");
      assert.equal(order[3], `${order[2]!.split(":")[0]}:end`, "the second fn ends after it begins");
    } finally {
      await pgA.close();
      await pgB.close();
    }
  },
);

test("pg mutex: DIFFERENT keys run concurrently (independent locks)", { skip }, async () => {
  const pgA = createPgPool(URL!);
  const pgB = createPgPool(URL!);
  try {
    const lockA = createPostgresAdvisoryLock(pgA, { pollMs: 20 });
    const lockB = createPostgresAdvisoryLock(pgB, { pollMs: 20 });
    let active = 0;
    let maxActive = 0;
    const body = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(80);
      active--;
    };
    await Promise.all([lockA.withLock("deploy:one", body), lockB.withLock("deploy:two", body)]);
    assert.equal(maxActive, 2, "different keys did not block each other (ran concurrently)");
  } finally {
    await pgA.close();
    await pgB.close();
  }
});

test("pg mutex: the lock is released after fn THROWS (the next acquire succeeds)", { skip }, async () => {
  const pg = createPgPool(URL!);
  try {
    const lock = createPostgresAdvisoryLock(pg, { pollMs: 20 });
    await assert.rejects(
      () =>
        lock.withLock("deploy:boom", async () => {
          throw new Error("boom");
        }),
      /boom/,
      "fn's error bubbles (not swallowed)",
    );
    let ran = 0;
    await lock.withLock("deploy:boom", async () => {
      ran++;
    });
    assert.equal(ran, 1, "the key is free again after a thrown fn");
  } finally {
    await pg.close();
  }
});

test("pg mutex: waiting beyond timeoutMs throws a clear error", { skip }, async () => {
  const pgHolder = createPgPool(URL!);
  const pgWaiter = createPgPool(URL!);
  try {
    const holder = createPostgresAdvisoryLock(pgHolder, { pollMs: 20 });
    const waiter = createPostgresAdvisoryLock(pgWaiter, { pollMs: 20, timeoutMs: 100 });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holding = holder.withLock("deploy:slow", async () => {
      await held;
    });
    await sleep(30);
    await assert.rejects(
      () => waiter.withLock("deploy:slow", async () => "never"),
      /timeout acquiring advisory lock for deploy:slow/,
      "waiting past timeoutMs throws a clear error",
    );
    release();
    await holding;
  } finally {
    await pgHolder.close();
    await pgWaiter.close();
  }
});

test("pg sandbox activation fences publication from a separate compatible reader", { skip }, async () => {
  const pgA = createPgPool(URL!);
  const pgB = createPgPool(URL!);
  const release = Promise.withResolvers<string[]>();
  try {
    const options = {
      enabled: false,
      rollout: createMemoryMap<SandboxResourceRollout>(),
      records: createMemoryMap<SandboxResource>(),
      defaults: createMemoryMap<SandboxDefault>(),
      routes: createMemoryMap<SandboxRoute>(),
      backends: {},
      defaultBackend: "local" as const,
      canUseScope: async () => true,
    };
    const entered = Promise.withResolvers<void>();
    const reader = createSandboxResources({ ...options, lock: createPostgresAdvisoryLock(pgB, { pollMs: 10 }) });
    const active = createSandboxResources({
      ...options,
      enabled: true,
      lock: createPostgresAdvisoryLock(pgA, { pollMs: 10 }),
      legacyScopes: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const activation = active.initialize();
    await entered.promise;
    const publication = reader.recordLegacy("personal:late", "local", { id: "late", rootDir: "/workspace" });
    release.resolve([]);
    await activation;
    const id = await publication;
    assert.equal((await reader.resolve("personal:late"))?.id, id);
    assert.deepEqual(await options.defaults.get("personal:late"), { sandboxId: id });
    let changed = false;
    await assert.rejects(
      reader.withLegacyMutation("personal:late", async () => {
        changed = true;
      }),
      /retired/,
    );
    assert.equal(changed, false);
  } finally {
    release.resolve([]);
    await pgA.close();
    await pgB.close();
  }
});

function sessionFixture(beforeQuery?: (sql: string, key: string) => Promise<void>) {
  const clients: { released: boolean; discarded: boolean; held: Set<string> }[] = [];
  const owners = new Map<string, object>();
  const pg = {
    sessionPool: async () => ({
      connect: async () => {
        const state = { released: false, discarded: false, held: new Set<string>() };
        clients.push(state);
        return {
          async query(sql: string, [key]: [string]) {
            assert.equal(state.released, false, "A released session must not receive queries");
            await beforeQuery?.(sql, key);
            if (sql.includes("pg_try_advisory_lock")) {
              const locked = !owners.has(key) || owners.get(key) === state;
              if (locked) {
                owners.set(key, state);
                state.held.add(key);
              }
              return { rows: [{ locked }] };
            }
            assert.equal(owners.get(key), state);
            owners.delete(key);
            state.held.delete(key);
            return { rows: [{ unlocked: true }] };
          },
          release(discarded: boolean) {
            assert.equal(state.released, false, "Each session must be released once");
            state.released = true;
            state.discarded = discarded;
            if (!discarded) assert.equal(state.held.size, 0, "A healthy released session must hold no locks");
            for (const key of state.held) owners.delete(key);
            state.held.clear();
          },
        };
      },
    }),
  } as unknown as import("../src/persistence/pg-pool.ts").PgPool;
  const lock = createPostgresAdvisoryLock(pg, { pollMs: 1, timeoutMs: 1_000 });
  return { lock, clients, owners };
}

test("pg mutex: nested calls reject active ancestor keys and serialize sibling keys on one session", async () => {
  const { lock, clients, owners } = sessionFixture();
  let active = 0;
  let maximum = 0;
  await lock.withLock("outer", async () => {
    assert.equal(await lock.tryWithLock!("outer", async () => "must not run"), null);
    await assert.rejects(
      lock.withLock("outer", async () => "must not run"),
      /already held by this callback/,
    );
    await Promise.all(
      Array.from({ length: 4 }, () =>
        lock.withLock("inner", async () => {
          active++;
          maximum = Math.max(maximum, active);
          assert.equal(await lock.tryWithLock!("inner", async () => "must not run"), null);
          assert.equal(owners.has("outer"), true);
          await sleep(5);
          active--;
        }),
      ),
    );
  });
  assert.equal(maximum, 1);
  assert.equal(clients.length, 1);
  assert.equal(clients[0]!.released, true);
  assert.equal(clients[0]!.discarded, false);
});

test("pg mutex: a detached call after its callback ends opens a new session", async () => {
  const { lock, clients } = sessionFixture();
  const start = Promise.withResolvers<void>();
  let detached!: Promise<string | null>;
  await lock.withLock("outer", async () => {
    detached = (async () => {
      await start.promise;
      return lock.tryWithLock!("outer", async () => "detached");
    })();
  });
  assert.equal(clients[0]!.released, true);
  start.resolve();
  assert.equal(await detached, "detached");
  assert.equal(clients.length, 2);
  assert.ok(clients.every((client) => client.released && !client.discarded));
});

test("pg mutex: a nested call retains its session while its acquire query is pending after the parent ends", async () => {
  const entered = Promise.withResolvers<void>();
  const continueQuery = Promise.withResolvers<void>();
  const { lock, clients, owners } = sessionFixture(async (sql, key) => {
    if (key === "inner" && sql.includes("pg_try_advisory_lock")) {
      entered.resolve();
      await continueQuery.promise;
    }
  });
  let detached!: Promise<string>;
  await lock.withLock("outer", async () => {
    detached = lock.withLock("inner", async () => {
      assert.equal(clients[0]!.released, false);
      assert.equal(owners.has("outer"), false);
      return "retained";
    });
    await entered.promise;
  });
  assert.equal(clients[0]!.released, false);
  continueQuery.resolve();
  assert.equal(await detached, "retained");
  assert.equal(clients.length, 1);
  assert.equal(clients[0]!.released, true);
});

test("pg mutex: active detached children keep the lease but inactive sibling scopes cannot reuse it", async () => {
  const { lock, clients } = sessionFixture();
  const childEntered = Promise.withResolvers<void>();
  const finishChild = Promise.withResolvers<void>();
  const startSibling = Promise.withResolvers<void>();
  let child!: Promise<void>;
  let sibling!: Promise<void>;
  await lock.withLock("outer", async () => {
    child = lock.withLock("child", async () => {
      childEntered.resolve();
      await finishChild.promise;
    });
    sibling = (async () => {
      await startSibling.promise;
      await lock.withLock("sibling", async () => undefined);
    })();
    await childEntered.promise;
  });
  assert.equal(clients[0]!.released, false);
  startSibling.resolve();
  await sibling;
  assert.equal(clients.length, 2);
  assert.equal(clients[0]!.released, false);
  assert.equal(clients[1]!.released, true);
  finishChild.resolve();
  await child;
  assert.equal(clients[0]!.released, true);
});

test("pg mutex: failed acquire and unlock queries discard the session after all borrowers exit", async () => {
  for (const failedStatement of ["pg_try_advisory_lock", "pg_advisory_unlock"]) {
    const { lock, clients, owners } = sessionFixture(async (sql, key) => {
      if (key === "inner" && sql.includes(failedStatement)) throw new Error("query failed");
    });
    await lock.withLock("outer", async () => {
      await assert.rejects(
        lock.withLock("inner", async () => undefined),
        /query failed/,
      );
      assert.equal(owners.has("outer"), true);
      assert.equal(clients[0]!.released, false);
      await assert.rejects(
        lock.withLock("another", async () => undefined),
        /session failed/,
      );
    });
    assert.equal(clients.length, 1);
    assert.equal(clients[0]!.released, true);
    assert.equal(clients[0]!.discarded, true);
    assert.equal(owners.size, 0);
  }
});

test(
  "pg mutex: nested distinct keys and concurrent publishes use a session pool with one connection",
  { skip, timeout: 10_000 },
  async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: URL!, max: 1, connectionTimeoutMillis: 1_000 });
    const observer = new Pool({ connectionString: URL!, max: 1, connectionTimeoutMillis: 1_000 });
    const pg = { sessionPool: async () => pool } as unknown as import("../src/persistence/pg-pool.ts").PgPool;
    const lock = createPostgresAdvisoryLock(pg, { pollMs: 5, timeoutMs: 1_000 });
    const prefix = `nested-${Date.now()}-${Math.random()}`;
    let active = 0;
    let maximum = 0;
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          lock.withLock(`${prefix}:app:${index}`, async () => {
            await lock.withLock(`${prefix}:owner`, async () => {
              active++;
              maximum = Math.max(maximum, active);
              assert.equal(await lock.tryWithLock!(`${prefix}:app:${index}`, async () => "must not run"), null);
              await assert.rejects(
                lock.withLock(`${prefix}:failure`, async () => {
                  throw new Error("callback failed");
                }),
                /callback failed/,
              );
              const held = await observer.query<{ locked: boolean }>(
                "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
                [`${prefix}:app:${index}`],
              );
              assert.equal(held.rows[0]!.locked, false, "The outer lock remains held after the inner callback throws");
              await sleep(5);
              active--;
            });
          }),
        ),
      );
      assert.equal(maximum, 1);
      await lock.withLock(`${prefix}:siblings`, async () => {
        await Promise.all(
          Array.from({ length: 4 }, () =>
            lock.withLock(`${prefix}:shared`, async () => {
              active++;
              maximum = Math.max(maximum, active);
              await sleep(5);
              active--;
            }),
          ),
        );
      });
      assert.equal(maximum, 1, "Nested sibling callbacks do not overlap on a shared PostgreSQL session");
      const bothEntered = Promise.withResolvers<void>();
      await lock.withLock(`${prefix}:parallel`, async () => {
        await Promise.all(
          ["first", "second"].map((key) =>
            lock.withLock(`${prefix}:${key}`, async () => {
              active++;
              maximum = Math.max(maximum, active);
              if (active === 2) bothEntered.resolve();
              await bothEntered.promise;
              active--;
            }),
          ),
        );
      });
      assert.equal(maximum, 2, "Nested distinct keys can run at the same time on one session");
      assert.equal(pool.totalCount, 1);
      const remaining = await pool.query<{ count: string }>(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
      );
      assert.equal(remaining.rows[0]!.count, "0");
    } finally {
      await pool.end();
      await observer.end();
    }
  },
);
