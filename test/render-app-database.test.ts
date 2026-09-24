import assert from "node:assert/strict";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import pg from "pg";
import {
  createRenderAppDatabase,
  parseRenderAppDatabaseEndpoint,
  type StoredRenderAppDatabase,
} from "../src/deploy/render-app-database.ts";
import { createMemoryMap, createPostgresMapFactory, type DurableMap } from "../src/persistence/durable-map.ts";

const TEST_URL = process.env.DATABASE_URL;
if (TEST_URL && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(TEST_URL).hostname))
  throw new Error("Render app database tests require a local PostgreSQL test server");
const skip = TEST_URL ? false : "set DATABASE_URL to a local test PostgreSQL server";
const keyMaterial = "render-app-database-test-key";

function replaceDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function query(url: string, text: string): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    return await client.query(text);
  } finally {
    await client.end();
  }
}

async function fixture(t: TestContext) {
  const suffix = randomBytes(12).toString("hex");
  const adminRole = `qm_test_admin_${suffix}`;
  const coreDatabase = `qm_test_core_${suffix}`;
  const adminUrl = new URL(TEST_URL!);
  adminUrl.username = adminRole;
  adminUrl.password = randomBytes(32).toString("base64url");
  adminUrl.pathname = `/${coreDatabase}`;
  const root = new pg.Client({ connectionString: TEST_URL });
  await root.connect();
  await root.query(
    `CREATE ROLE ${pg.escapeIdentifier(adminRole)} LOGIN CREATEDB CREATEROLE PASSWORD ${pg.escapeLiteral(adminUrl.password)}`,
  );
  await root.query(`CREATE DATABASE ${pg.escapeIdentifier(coreDatabase)} OWNER ${pg.escapeIdentifier(adminRole)}`);
  const maps = createPostgresMapFactory(adminUrl.toString());
  const store = maps.map<StoredRenderAppDatabase>("render_app_database_test");
  t.after(async () => {
    const records = await store.all();
    await maps.pool.close();
    for (const record of records)
      await root.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(record.database)} WITH (FORCE)`);
    await root.query(`DROP DATABASE ${pg.escapeIdentifier(coreDatabase)} WITH (FORCE)`);
    for (const record of records) {
      await root.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(record.loginRole)}`);
      await root.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(record.ownerRole)}`);
    }
    await root.query(`DROP ROLE ${pg.escapeIdentifier(adminRole)}`);
    await root.end();
  });
  await query(adminUrl.toString(), "CREATE TABLE core_secrets (id integer PRIMARY KEY, value text)");
  await query(adminUrl.toString(), "INSERT INTO core_secrets VALUES (1, 'private')");
  const create = (backing: DurableMap<StoredRenderAppDatabase> = store, appEndpoint?: string) =>
    createRenderAppDatabase({
      adminUrl: adminUrl.toString(),
      store: backing,
      keyMaterial,
      appEndpoint,
      advisoryLock: createPostgresAdvisoryLock(maps.pool),
    });
  return { root, store, maps, create, adminUrl: adminUrl.toString(), adminRole, coreDatabase };
}

test("Render app database rejects unsafe URLs and invalid deployment IDs", async () => {
  for (const adminUrl of [
    "invalid",
    "https://admin:secret@example.com/core",
    "postgres://admin@example.com/core",
    "postgres://admin:secret@example.com/core?user=admin",
    "postgres://admin:secret@example.com/core?password=override",
  ])
    assert.throws(() => createRenderAppDatabase({ adminUrl, store: createMemoryMap(), keyMaterial }), /admin URL/);
  const manager = createRenderAppDatabase({
    adminUrl: "postgres://admin:secret@127.0.0.1/core",
    store: createMemoryMap(),
    keyMaterial,
  });
  await assert.rejects(manager.ensure("app; DROP DATABASE core"), /deployment UUID/);
  assert.throws(
    () =>
      createRenderAppDatabase({
        adminUrl: "postgres://admin:secret@127.0.0.1/core",
        store: createMemoryMap(),
        keyMaterial: "",
      }),
    /encryption key/,
  );
});

test("Render app database endpoints require verified TLS without credentials or a database", () => {
  for (const appEndpoint of [
    "invalid",
    "https://db.example.com/?sslmode=verify-full",
    "postgresql://admin@db.example.com/?sslmode=verify-full",
    "postgresql://:secret@db.example.com/?sslmode=verify-full",
    "postgresql://db.example.com/core?sslmode=verify-full",
    "postgresql://db.example.com/?sslmode=verify-full#fragment",
    "postgresql://db.example.com/?sslmode=require",
    "postgresql://db.example.com/?sslmode=disable",
    "postgresql://db.example.com/",
    "postgresql://db.example.com/?sslmode=verify-full&sslmode=verify-full",
    "postgresql://db.example.com/?sslmode=verify-full&password=secret",
  ])
    assert.throws(
      () =>
        createRenderAppDatabase({
          adminUrl: "postgresql://admin:secret@internal/core",
          appEndpoint,
          store: createMemoryMap(),
          keyMaterial,
        }),
      /RENDER_APP_DATABASE_ENDPOINT/,
    );
  const endpoint = "postgresql://dpg-test-a.oregon-postgres.render.com:5432/?sslmode=verify-full";
  assert.equal(parseRenderAppDatabaseEndpoint(endpoint).toString(), endpoint);
});

test("Render app database returns scoped external credentials and verifies them internally", { skip }, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const endpoint = "postgresql://dpg-test-a.oregon-postgres.render.com:5432/?sslmode=verify-full";
  const result = await f.create(f.store, endpoint).ensure(id);
  const external = new URL(result.DATABASE_URL!);
  const record = (await f.store.get(id))!;
  assert.equal(external.hostname, "dpg-test-a.oregon-postgres.render.com");
  assert.equal(external.port, "5432");
  assert.equal(external.search, "?sslmode=verify-full");
  assert.equal(external.username, record.loginRole);
  assert.equal(external.pathname, `/${record.database}`);
  assert.notEqual(external.password, new URL(f.adminUrl).password);
  assert.ok(external.password.length >= 32);
  assert.equal(result.DATABASE_URL!.includes(f.adminRole), false);
  assert.equal(result.DATABASE_URL!.includes(new URL(f.adminUrl).password), false);
  assert.equal(result.DATABASE_URL!.includes(f.coreDatabase), false);
  assert.equal((await f.create(f.store, endpoint).ensure(id)).DATABASE_URL, result.DATABASE_URL);
  const internal = new URL(f.adminUrl);
  internal.username = external.username;
  internal.password = external.password;
  internal.pathname = external.pathname;
  assert.deepEqual((await query(internal.toString(), "SELECT current_user AS role")).rows, [
    { role: record.loginRole },
  ]);
  assert.equal(JSON.stringify(record).includes(external.password), false);
});

test("Render app databases preserve data and isolate app accounts from core data and peers", { skip }, async (t) => {
  const f = await fixture(t);
  const firstId = randomUUID();
  const first = (await f.create().ensure(firstId)).DATABASE_URL!;
  const second = (await f.create().ensure(randomUUID())).DATABASE_URL!;
  await query(first, "CREATE TABLE items (id integer PRIMARY KEY, value text NOT NULL)");
  await query(first, "INSERT INTO items VALUES (1, 'retained')");
  assert.deepEqual((await query(first, "SELECT * FROM items")).rows, [{ id: 1, value: "retained" }]);
  await assert.rejects(
    query(replaceDatabase(first, new URL(second).pathname.slice(1)), "SELECT 1"),
    /permission denied for database/,
  );
  const appCore = replaceDatabase(first, f.coreDatabase);
  for (const statement of [
    "SELECT * FROM core_secrets",
    "INSERT INTO core_secrets VALUES (2, 'changed')",
    "CREATE TABLE forbidden (id integer)",
    "CREATE SCHEMA forbidden",
  ])
    await assert.rejects(query(appCore, statement), /permission denied/);
  assert.deepEqual((await query(f.adminUrl, "SELECT * FROM core_secrets")).rows, [{ id: 1, value: "private" }]);
  const firstRecord = (await f.store.get(firstId))!;
  for (const statement of [
    "CREATE ROLE forbidden",
    "CREATE DATABASE forbidden",
    `SET ROLE ${pg.escapeIdentifier(firstRecord.ownerRole)}`,
    `SET ROLE ${pg.escapeIdentifier(f.adminRole)}`,
    `ALTER DATABASE ${pg.escapeIdentifier(firstRecord.database)} ALLOW_CONNECTIONS false`,
    "CREATE SCHEMA forbidden",
  ])
    await assert.rejects(query(first, statement), /permission denied|must be owner/);
  const role = await f.root.query("SELECT * FROM pg_roles WHERE rolname = $1", [firstRecord.loginRole]);
  for (const flag of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"])
    assert.equal(role.rows[0][flag], false);
  assert.equal(role.rows[0].rolconnlimit, 25);
  assert.equal(role.rows[0].rolcanlogin, true);
  assert.equal(firstRecord.ready, true);
  assert.equal(firstRecord.passwordEnc.startsWith("v2:"), true);
  assert.equal(JSON.stringify(firstRecord).includes(new URL(first).password), false);
  const independentMaps = createPostgresMapFactory(f.adminUrl);
  try {
    const restored = createRenderAppDatabase({
      adminUrl: f.adminUrl,
      store: independentMaps.map<StoredRenderAppDatabase>("render_app_database_test"),
      keyMaterial,
      advisoryLock: createPostgresAdvisoryLock(independentMaps.pool),
    });
    assert.equal((await restored.ensure(firstId)).DATABASE_URL, first);
    assert.deepEqual((await query(first, "SELECT value FROM items")).rows, [{ value: "retained" }]);
  } finally {
    await independentMaps.pool.close();
  }
});

test("Render app database instances serialize creation and retain one credential", { skip }, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.create().ensure(id)));
  assert.equal(new Set(results.map((result) => result.DATABASE_URL)).size, 1);
  assert.equal((await f.store.all()).length, 1);
});

test(
  "Render app database permits old and new default pools while a deploy checks its credential",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const id = randomUUID();
    const url = (await f.create().ensure(id)).DATABASE_URL!;
    const oldPool = new pg.Pool({ connectionString: url, max: 10 });
    const newPool = new pg.Pool({ connectionString: url, max: 10 });
    const held: pg.PoolClient[] = [];
    try {
      held.push(...(await Promise.all(Array.from({ length: 10 }, () => oldPool.connect()))));
      assert.equal((await f.create().ensure(id)).DATABASE_URL, url);
      held.push(...(await Promise.all(Array.from({ length: 10 }, () => newPool.connect()))));
      assert.equal((await f.create().ensure(id)).DATABASE_URL, url);
      for (const client of held) assert.equal((await client.query("SELECT 1 AS value")).rows[0].value, 1);
    } finally {
      const disconnected = held.map((client) => once(client, "end"));
      for (const client of held) client.release();
      await Promise.all([oldPool.end(), newPool.end(), ...disconnected]);
    }
  },
);

test(
  "Render app database retries a failed durable completion without replacing data or credentials",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const id = randomUUID();
    const failing: DurableMap<StoredRenderAppDatabase> = {
      ...f.store,
      async put() {
        throw new Error("failed completion write");
      },
    };
    await assert.rejects(f.create(failing).ensure(id), /provisioning failed/);
    const pending = (await f.store.get(id))!;
    assert.equal(pending.ready, false);
    const adminAppUrl = replaceDatabase(f.adminUrl, pending.database);
    await query(adminAppUrl, "CREATE TABLE recovery_data (value text)");
    await query(adminAppUrl, "INSERT INTO recovery_data VALUES ('retained')");
    await f.create().ensure(id);
    assert.equal((await f.store.get(id))!.passwordEnc, pending.passwordEnc);
    assert.deepEqual((await query(adminAppUrl, "SELECT * FROM recovery_data")).rows, [{ value: "retained" }]);
  },
);

test(
  "Render app database refuses missing retained data and does not create an empty replacement",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const id = randomUUID();
    await f.create().ensure(id);
    const record = (await f.store.get(id))!;
    await f.root.query(`DROP DATABASE ${pg.escapeIdentifier(record.database)}`);
    await assert.rejects(f.create().ensure(id), /retained Render app database is missing/);
    assert.equal((await f.root.query("SELECT 1 FROM pg_database WHERE datname = $1", [record.database])).rowCount, 0);
    assert.equal((await f.store.get(id))!.passwordEnc, record.passwordEnc);
  },
);

test("Render app database refuses unowned databases and changed role ownership", { skip }, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  await f.create().ensure(id);
  const record = (await f.store.get(id))!;
  await f.root.query(
    `ALTER DATABASE ${pg.escapeIdentifier(record.database)} OWNER TO ${pg.escapeIdentifier(f.adminRole)}`,
  );
  await assert.rejects(f.create().ensure(id), /does not match its saved owner/);
  await f.root.query(
    `ALTER DATABASE ${pg.escapeIdentifier(record.database)} OWNER TO ${pg.escapeIdentifier(record.ownerRole)}`,
  );
  await f.root.query(`COMMENT ON ROLE ${pg.escapeIdentifier(record.loginRole)} IS 'unowned'`);
  await assert.rejects(f.create().ensure(id), /roles do not match their saved ownership/);
  assert.equal((await f.store.get(id))!.passwordEnc, record.passwordEnc);
});

test("Render app database rejects role membership that can reach another account", { skip }, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  await f.create().ensure(id);
  const record = (await f.store.get(id))!;
  await f.root.query(`GRANT ${pg.escapeIdentifier(record.ownerRole)} TO ${pg.escapeIdentifier(record.loginRole)}`);
  await assert.rejects(f.create().ensure(id), /roles do not match their saved ownership/);
});

test("Render app database rejects PUBLIC table access after it blocks core connections", { skip }, async (t) => {
  const f = await fixture(t);
  await query(f.adminUrl, "GRANT SELECT ON core_secrets TO PUBLIC");
  const id = randomUUID();
  await assert.rejects(f.create().ensure(id), /core database grants app roles access/);
  const record = (await f.store.get(id))!;
  const roles = await f.root.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])", [
    [record.ownerRole, record.loginRole],
  ]);
  assert.deepEqual(roles.rows, [{ rolcanlogin: false }, { rolcanlogin: false }]);
  assert.equal((await f.root.query("SELECT 1 FROM pg_database WHERE datname = $1", [record.database])).rowCount, 0);
  assert.equal(
    (await query(f.adminUrl, `SELECT has_table_privilege('${record.loginRole}', 'core_secrets', 'SELECT') AS allowed`))
      .rows[0].allowed,
    true,
  );
});

test("Render app database archive revokes login and restore retains records and credentials", { skip }, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const manager = f.create();
  const first = (await manager.ensure(id)).DATABASE_URL!;
  const peer = (await manager.ensure(randomUUID())).DATABASE_URL!;
  const record = (await f.store.get(id))!;
  await query(first, "CREATE TABLE archive_records (value text)");
  await query(first, "INSERT INTO archive_records VALUES ('retained')");
  const admin = new pg.Client({ connectionString: f.adminUrl });
  const active = new pg.Client({ connectionString: first });
  const other = new pg.Client({ connectionString: peer });
  active.on("error", () => {});
  other.on("error", () => {});
  admin.on("error", () => {});
  try {
    await Promise.all([admin.connect(), active.connect(), other.connect()]);
    const privileges = await admin.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole, pg_has_role(current_user, 'pg_signal_backend', 'USAGE') AS can_signal_all FROM pg_roles WHERE rolname = current_user",
    );
    assert.deepEqual(privileges.rows, [
      { rolsuper: false, rolcreatedb: true, rolcreaterole: true, can_signal_all: false },
    ]);
    const pid = (await active.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await manager.suspend(id);
    assert.equal((await f.root.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rowCount, 0);
    assert.deepEqual((await other.query("SELECT 1 AS alive")).rows, [{ alive: 1 }]);
    assert.deepEqual((await admin.query("SELECT * FROM core_secrets")).rows, [{ id: 1, value: "private" }]);
    assert.deepEqual(
      (await admin.query("SELECT pg_has_role($1, $2, 'MEMBER') AS member", [record.loginRole, f.adminRole])).rows,
      [{ member: false }],
    );
    const membership = await admin.query(
      "SELECT inherit_option, set_option FROM pg_auth_members WHERE member = current_user::regrole AND roleid = $1::regrole AND inherit_option",
      [record.loginRole],
    );
    assert.deepEqual(membership.rows, [{ inherit_option: true, set_option: false }]);
    assert.equal(
      (await admin.query("SELECT pg_has_role(current_user, 'pg_signal_backend', 'USAGE') AS allowed")).rows[0].allowed,
      false,
    );
  } finally {
    await Promise.all([admin.end(), active.end(), other.end()]);
  }
  await assert.rejects(query(first, "SELECT 1"), /not permitted to log in/);
  const restored = (await f.create().ensure(id)).DATABASE_URL!;
  assert.equal(restored, first);
  assert.deepEqual((await query(restored, "SELECT * FROM archive_records")).rows, [{ value: "retained" }]);
});

for (const stillActive of [false, true])
  test(
    `Render archive checks remaining sessions when termination returns false (active=${stillActive})`,
    { skip },
    async (t) => {
      const f = await fixture(t);
      const id = randomUUID();
      const manager = f.create();
      const url = (await manager.ensure(id)).DATABASE_URL!;
      const active = new pg.Client({ connectionString: url });
      active.on("error", () => {});
      await active.connect();
      const original = pg.Client.prototype.query;
      const mocked = t.mock.method(pg.Client.prototype, "query", async function (this: pg.Client, ...args: unknown[]) {
        if (typeof args[0] === "string" && args[0].startsWith("SELECT pg_terminate_backend")) {
          if (!stillActive) await active.end();
          return { rows: [{ terminated: false }], rowCount: 1 };
        }
        return Reflect.apply(original, this, args);
      });
      try {
        if (stillActive) {
          await assert.rejects(manager.suspend(id), /sessions did not stop before the deadline/);
          assert.deepEqual((await active.query("SELECT 1 AS alive")).rows, [{ alive: 1 }]);
        } else await manager.suspend(id);
        await assert.rejects(query(url, "SELECT 1"), /not permitted to log in/);
        mocked.mock.restore();
        await manager.suspend(id);
        const record = (await f.store.get(id))!;
        assert.equal(
          (await f.root.query("SELECT 1 FROM pg_stat_activity WHERE usename = $1", [record.loginRole])).rowCount,
          0,
        );
      } finally {
        mocked.mock.restore();
        await active.end();
      }
    },
  );

test(
  "Render app database rejects unsafe core column, sequence, function, and schema privileges",
  { skip },
  async (t) => {
    for (const [name, statements] of [
      ["column", ["GRANT SELECT (value) ON core_secrets TO PUBLIC"]],
      ["sequence", ["CREATE SEQUENCE core_sequence", "GRANT USAGE ON core_sequence TO PUBLIC"]],
      [
        "function",
        [
          "CREATE FUNCTION read_secret() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT value FROM core_secrets LIMIT 1 $$",
        ],
      ],
      ["schema", ["GRANT CREATE ON SCHEMA public TO PUBLIC"]],
    ] as const) {
      await t.test(name, async (t) => {
        const f = await fixture(t);
        for (const statement of statements) await query(f.adminUrl, statement);
        await assert.rejects(f.create().ensure(randomUUID()), /core database grants app roles access/);
      });
    }
  },
);

test("Render app database recovers when CREATE DATABASE commits before its reply is lost", { skip }, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const original = pg.Client.prototype.query;
  const mocked = t.mock.method(pg.Client.prototype, "query", async function (this: pg.Client, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    if (typeof args[0] === "string" && args[0].startsWith('CREATE DATABASE "qm_app_'))
      throw new Error("lost database creation reply");
    return result;
  });
  await assert.rejects(f.create().ensure(id), /provisioning failed/);
  mocked.mock.restore();
  const pending = (await f.store.get(id))!;
  const before = await f.root.query("SELECT oid, datallowconn FROM pg_database WHERE datname = $1", [pending.database]);
  assert.equal(before.rows[0].datallowconn, false);
  const url = (await f.create().ensure(id)).DATABASE_URL!;
  const after = await f.root.query("SELECT oid, datallowconn FROM pg_database WHERE datname = $1", [pending.database]);
  assert.equal(after.rows[0].oid, before.rows[0].oid);
  assert.equal(after.rows[0].datallowconn, true);
  assert.equal((await f.store.get(id))!.passwordEnc, pending.passwordEnc);
  await query(url, "CREATE TABLE recovered (id integer)");
});

test("Render app database does not rotate an active password after an authentication failure", { skip }, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const url = (await f.create().ensure(id)).DATABASE_URL!;
  const before = (await f.store.get(id))!;
  const changedPassword = randomBytes(32).toString("base64url");
  await query(url, `ALTER ROLE CURRENT_USER PASSWORD ${pg.escapeLiteral(changedPassword)}`);
  await assert.rejects(f.create().ensure(id), /provisioning failed \(28P01\)/);
  const changedUrl = new URL(url);
  changedUrl.password = changedPassword;
  await query(changedUrl.toString(), "SELECT 1");
  assert.equal((await f.store.get(id))!.passwordEnc, before.passwordEnc);
});
