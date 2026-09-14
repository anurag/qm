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
import { randomUUID } from "node:crypto";
import { createPgPool, type PgPool, type PoolClient } from "../src/persistence/pg-pool.ts";
import {
  createMemoryAdvisoryLock,
  createNoopAdvisoryLock,
  createPostgresAdvisoryLock,
} from "../src/persistence/advisory-lock.ts";

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

function fakePool(locked: (connection: number, attempt: number) => boolean = () => true) {
  const calls: Array<{ connection: number; sql: string; key: string }> = [];
  const open = new Set<number>();
  let connections = 0;
  let releases = 0;
  const pg = {
    async sessionPool() {
      return {
        async connect() {
          assert.equal(open.size, 0, "a new connection is checked out only after the previous one was released");
          const connection = ++connections;
          open.add(connection);
          let attempt = 0;
          return {
            async query(sql: string, params: string[]) {
              calls.push({ connection, sql, key: params[0]! });
              return {
                rows: [{ locked: sql.includes("pg_try_advisory_lock") ? locked(connection, ++attempt) : true }],
              };
            },
            release() {
              open.delete(connection);
              releases++;
            },
          } as unknown as PoolClient;
        },
      };
    },
  } as PgPool;
  return { pg, calls, connections: () => connections, releases: () => releases };
}

test("pg mutex: nested locks reuse one session and re-enter a held key", async () => {
  const fake = fakePool();
  const lock = createPostgresAdvisoryLock(fake.pg);
  await assert.rejects(
    lock.withLock("scope", () =>
      lock.withLock("map", () =>
        lock.withLock("scope", async () => {
          throw new Error("operation failed");
        }),
      ),
    ),
    /operation failed/,
  );
  assert.equal(fake.connections(), 1);
  assert.equal(fake.releases(), 1);
  assert.deepEqual(
    fake.calls.map(({ key }) => key),
    ["scope", "map", "map", "scope"],
  );
  await lock.withLock("a", async () => 1);
  await lock.withLock("b", async () => 2);
  assert.equal(fake.connections(), 3);
  assert.equal(fake.releases(), 3);
});

test("pg mutex: a waiting outer acquisition releases its connection between polls", async () => {
  const fake = fakePool((connection) => connection >= 3);
  const lock = createPostgresAdvisoryLock(fake.pg, { pollMs: 1 });
  assert.equal(await lock.withLock("busy", async () => "entered"), "entered");
  assert.equal(fake.connections(), 3);
  assert.equal(fake.releases(), 3);
  assert.equal(await lock.tryWithLock!("busy", async () => "entered"), "entered");
  const refused = fakePool(() => false);
  assert.equal(await createPostgresAdvisoryLock(refused.pg).tryWithLock!("busy", async () => "entered"), null);
  assert.equal(refused.releases(), 1);
});

test("pg mutex: a released session is not reused by a detached continuation", async () => {
  const fake = fakePool();
  const lock = createPostgresAdvisoryLock(fake.pg);
  const next = Promise.withResolvers<void>();
  let detached: Promise<unknown>;
  await lock.withLock("scope", async () => {
    detached = next.promise.then(() => lock.withLock("scope", async () => true));
  });
  next.resolve();
  await detached!;
  assert.equal(fake.connections(), 2);
  assert.equal(fake.releases(), 2);
});

test("pg mutex: sibling acquisitions within one outer session are serialized", async () => {
  const fake = fakePool();
  const lock = createPostgresAdvisoryLock(fake.pg);
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const events: string[] = [];
  await lock.withLock("outer", async () => {
    const first = lock.withLock("inner", async () => {
      events.push("first");
      entered.resolve();
      await release.promise;
      events.push("released");
    });
    await entered.promise;
    const second = lock.withLock("inner", async () => {
      events.push("second");
    });
    assert.equal(await lock.tryWithLock!("inner", async () => "entered"), null);
    release.resolve();
    await Promise.all([first, second]);
  });
  assert.deepEqual(events, ["first", "released", "second"]);
  assert.equal(fake.connections(), 1);
});

test("memory mutex: nested locks re-enter a held key and tryWithLock skips a busy key", async () => {
  const lock = createMemoryAdvisoryLock();
  const nested = await lock.withLock("a", () => lock.withLock("a", () => lock.tryWithLock!("a", async () => "inner")));
  assert.equal(nested, "inner");
  let release!: () => void;
  const holding = lock.withLock("b", () => new Promise<void>((resolve) => (release = resolve)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await lock.tryWithLock!("b", async () => "skipped"), null);
  release();
  await holding;
  assert.equal(await lock.tryWithLock!("b", async () => "free"), "free");
});

test("pg mutex: a failing body's error survives a failing unlock", async () => {
  let released: Error | undefined;
  const pg = {
    async sessionPool() {
      return {
        async connect() {
          return {
            async query(sql: string) {
              if (sql.includes("pg_advisory_unlock")) throw new Error("unlock failed");
              return { rows: [{ locked: true }] };
            },
            release(error?: Error) {
              released = error;
            },
          } as unknown as PoolClient;
        },
      };
    },
  } as PgPool;
  await assert.rejects(
    createPostgresAdvisoryLock(pg).withLock("scope", async () => {
      throw new Error("body failed");
    }),
    /body failed/,
  );
  assert.equal(released?.message, "unlock failed");
});

test("pg mutex: a session whose unlock fails is discarded instead of returned to the pool", async () => {
  const failed = new Error("unlock failed");
  let released: Error | undefined;
  const pg = {
    async sessionPool() {
      return {
        async connect() {
          return {
            async query(sql: string) {
              if (sql.includes("pg_advisory_unlock")) throw failed;
              return { rows: [{ locked: true }] };
            },
            release(error?: Error) {
              released = error;
            },
          } as unknown as PoolClient;
        },
      };
    },
  } as PgPool;
  await assert.rejects(
    createPostgresAdvisoryLock(pg).withLock("scope", async () => true),
    /unlock failed/,
  );
  assert.equal(released, failed);
});

test("pg mutex: another pool is excluded while nested operations share the holder's session", { skip }, async () => {
  const a = createPgPool(URL!);
  const b = createPgPool(URL!);
  const scope = randomUUID();
  const first = createPostgresAdvisoryLock(a, { pollMs: 10 });
  const second = createPostgresAdvisoryLock(b, { pollMs: 10 });
  try {
    await first.withLock(scope, async () => {
      assert.equal(await first.withLock(`${scope}:nested`, () => first.withLock(scope, async () => 42)), 42);
      assert.equal(await second.tryWithLock!(scope, async () => "entered"), null);
    });
    assert.equal(await second.withLock(scope, async () => "entered"), "entered");
  } finally {
    await a.close();
    await b.close();
  }
});
