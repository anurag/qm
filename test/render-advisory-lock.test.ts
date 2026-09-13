import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPgPool, type PgPool, type PoolClient } from "../src/persistence/pg-pool.ts";
import { createRenderAdvisoryLock } from "../src/persistence/render-advisory-lock.ts";

function fakePool() {
  const calls: Array<{ connection: number; sql: string; key: string }> = [];
  let connections = 0;
  let releases = 0;
  const pg = {
    async sessionPool() {
      return {
        async connect() {
          const connection = ++connections;
          return {
            async query(sql: string, params: string[]) {
              calls.push({ connection, sql, key: params[0]! });
              return { rows: [{ locked: true }] };
            },
            release() {
              releases++;
            },
          } as unknown as PoolClient;
        },
      };
    },
  } as PgPool;
  return { pg, calls, connections: () => connections, releases: () => releases };
}

test("Render locks reuse one session through nested provider and durable map locks", async () => {
  const fake = fakePool();
  const lock = createRenderAdvisoryLock(fake.pg);
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
  await Promise.all([lock.withLock("a", async () => 1), lock.withLock("b", async () => 2)]);
  assert.equal(fake.connections(), 3);
  assert.equal(fake.releases(), 3);
});

test("Render locks do not reuse a released session in a detached continuation", async () => {
  const fake = fakePool();
  const lock = createRenderAdvisoryLock(fake.pg);
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

const databaseUrl = process.env.DATABASE_URL;
test(
  "Render Postgres locks exclude another core while nested operations use the same session",
  {
    skip: databaseUrl ? false : "set DATABASE_URL to test Render Postgres locks",
  },
  async () => {
    const a = createPgPool(databaseUrl!);
    const b = createPgPool(databaseUrl!);
    const scope = randomUUID();
    const first = createRenderAdvisoryLock(a, { pollMs: 10 });
    const second = createRenderAdvisoryLock(b, { pollMs: 10 });
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
  },
);

test("Render serializes sibling acquisitions within one outer session", async () => {
  const fake = fakePool();
  const lock = createRenderAdvisoryLock(fake.pg);
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

test("Render discards a session when an unlock fails", async () => {
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
    createRenderAdvisoryLock(pg).withLock("scope", async () => true),
    /unlock failed/,
  );
  assert.equal(released, failed);
});
