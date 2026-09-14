import { randomBytes } from "node:crypto";
import pg from "pg";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface StoredRenderAppDatabase {
  deploymentId: string;
  database: string;
  ownerRole: string;
  loginRole: string;
  ownershipToken: string;
  passwordEnc: string;
  ready: boolean;
}

interface Role {
  rolname: string;
  marker: string | null;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolinherit: boolean;
  rolcanlogin: boolean;
  member: boolean;
}

class ProvisioningError extends Error {}

function provisioningFailure(error: unknown): Error {
  if (error instanceof ProvisioningError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return new Error(`Render app database provisioning failed${/^[A-Z0-9]{5}$/.test(code) ? ` (${code})` : ""}`);
}

export function parseRenderAppDatabaseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("RENDER_APP_DATABASE_ENDPOINT must be a valid PostgreSQL endpoint");
  }
  if (
    !["postgres:", "postgresql:"].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.pathname && endpoint.pathname !== "/") ||
    endpoint.hash ||
    endpoint.searchParams.size !== 1 ||
    endpoint.searchParams.get("sslmode") !== "verify-full"
  )
    throw new Error("RENDER_APP_DATABASE_ENDPOINT must omit credentials and a database and use sslmode=verify-full");
  return endpoint;
}

export function createRenderAppDatabase(opts: {
  adminUrl: string;
  appEndpoint?: string;
  store: DurableMap<StoredRenderAppDatabase>;
  keyMaterial: string | Buffer;
}): { ensure(deploymentId: string): Promise<Record<string, string>>; suspend(deploymentId: string): Promise<void> } {
  let adminUrl: URL;
  try {
    adminUrl = new URL(opts.adminUrl);
  } catch {
    throw new Error("Render app databases require a valid PostgreSQL admin URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(adminUrl.protocol) ||
    !adminUrl.hostname ||
    !adminUrl.username ||
    !adminUrl.password ||
    !adminUrl.pathname.slice(1) ||
    adminUrl.hash ||
    [...adminUrl.searchParams.keys()].some((name) => name !== "sslmode")
  )
    throw new Error("Render app databases require a PostgreSQL admin URL for the core database");
  const appEndpoint = opts.appEndpoint ? parseRenderAppDatabaseEndpoint(opts.appEndpoint) : adminUrl;
  if (!opts.keyMaterial.length) throw new Error("Render app databases require an encryption key");
  const key = deriveConnectorKey(opts.keyMaterial, "render-app-database");
  const identifier = pg.escapeIdentifier;
  const literal = pg.escapeLiteral;
  const marker = (record: StoredRenderAppDatabase) => `qm:render-app:${record.deploymentId}:${record.ownershipToken}`;
  const connectionUrl = (endpoint: URL, database: string, login?: { role: string; password: string }): string => {
    const url = new URL(endpoint);
    url.pathname = `/${database}`;
    if (login) {
      url.username = login.role;
      url.password = login.password;
    }
    return url.toString();
  };

  async function transaction(client: pg.Client, run: () => Promise<void>): Promise<void> {
    await client.query("BEGIN");
    try {
      await run();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  async function roles(client: pg.Client, record: StoredRenderAppDatabase, password: string, admin: string) {
    const found = await client.query<Role>(
      `SELECT r.*, shobj_description(r.oid, 'pg_authid') AS marker,
         EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS member
       FROM pg_roles r WHERE rolname = ANY($1::text[])`,
      [[record.ownerRole, record.loginRole]],
    );
    if (found.rows.length) {
      if (
        found.rows.length !== 2 ||
        found.rows.some(
          (role) =>
            role.marker !== marker(record) ||
            role.rolsuper ||
            role.rolcreatedb ||
            role.rolcreaterole ||
            role.rolreplication ||
            role.rolbypassrls ||
            role.rolinherit ||
            role.member ||
            (role.rolname === record.ownerRole && role.rolcanlogin),
        )
      )
        throw new ProvisioningError("Render app database roles do not match their saved ownership");
      return;
    }
    if (record.ready) throw new ProvisioningError("The retained Render app database roles are missing");
    await transaction(client, async () => {
      const flags = "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT NOLOGIN";
      await client.query(`CREATE ROLE ${identifier(record.ownerRole)} WITH ${flags}`);
      await client.query(
        `CREATE ROLE ${identifier(record.loginRole)} WITH ${flags} CONNECTION LIMIT 25 PASSWORD ${literal(password)}`,
      );
      for (const role of [record.ownerRole, record.loginRole])
        await client.query(`COMMENT ON ROLE ${identifier(role)} IS ${literal(marker(record))}`);
      await client.query(`GRANT ${identifier(record.ownerRole)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
    });
  }

  return {
    async suspend(deploymentId) {
      const client = new pg.Client({ connectionString: opts.adminUrl, connectionTimeoutMillis: 10_000 });
      client.on("error", () => {});
      try {
        await client.connect();
        await client.query("SET statement_timeout = '30s'");
        await client.query("SELECT pg_advisory_lock(hashtextextended('qm:render-app-databases', 0))");
        const record = await opts.store.get(deploymentId);
        if (!record) return;
        const found = await client.query<{ marker: string }>(
          "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1",
          [record.loginRole],
        );
        if (found.rows[0]?.marker !== marker(record))
          throw new ProvisioningError("The retained Render app database role is missing or has a different owner");
        await client.query(`GRANT ${identifier(record.loginRole)} TO CURRENT_USER WITH INHERIT TRUE, SET FALSE`);
        await client.query(`ALTER ROLE ${identifier(record.loginRole)} NOLOGIN`);
        await client.query(
          "SELECT pg_terminate_backend(pid, 10000) AS terminated FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
          [record.loginRole],
        );
        const remaining = await client.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid() LIMIT 1",
          [record.loginRole],
        );
        if (remaining.rowCount)
          throw new ProvisioningError("The Render app database sessions did not stop before the deadline");
      } catch (error) {
        throw provisioningFailure(error);
      } finally {
        await client.end();
      }
    },
    async ensure(deploymentId) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(deploymentId))
        throw new Error("Render app databases require a deployment UUID");
      const client = new pg.Client({ connectionString: opts.adminUrl, connectionTimeoutMillis: 10_000 });
      client.on("error", () => {});
      try {
        await client.connect();
        await client.query("SET statement_timeout = '30s'");
        await client.query("SELECT pg_advisory_lock(hashtextextended('qm:render-app-databases', 0))");
        const identity = await client.query<{ database: string; admin: string }>(
          "SELECT current_database() AS database, current_user AS admin",
        );
        const { database: coreDatabase, admin } = identity.rows[0]!;
        await client.query(`REVOKE CONNECT ON DATABASE ${identifier(coreDatabase)} FROM PUBLIC`);
        await client.query(`GRANT CONNECT ON DATABASE ${identifier(coreDatabase)} TO ${identifier(admin)}`);
        let record = await opts.store.get(deploymentId);
        if (!record) {
          const suffix = randomBytes(16).toString("hex");
          record = await opts.store.putIfAbsent(deploymentId, {
            deploymentId,
            database: `qm_app_${suffix}`,
            ownerRole: `qm_app_owner_${suffix}`,
            loginRole: `qm_app_user_${suffix}`,
            ownershipToken: randomBytes(32).toString("hex"),
            passwordEnc: encryptSecret(randomBytes(32).toString("base64url"), key),
            ready: false,
          });
        }
        if (
          record.deploymentId !== deploymentId ||
          !/^qm_app_[a-f0-9]{32}$/.test(record.database) ||
          record.ownerRole !== record.database.replace("qm_app_", "qm_app_owner_") ||
          record.loginRole !== record.database.replace("qm_app_", "qm_app_user_") ||
          !/^[a-f0-9]{64}$/.test(record.ownershipToken)
        )
          throw new ProvisioningError("The saved Render app database identity is invalid");
        const password = decryptSecret(record.passwordEnc, key);
        await roles(client, record, password, admin);
        const coreAccess = await client.query<{ allowed: boolean }>(
          `SELECT has_database_privilege($1, $2, 'CONNECT,CREATE')
             OR EXISTS (
               SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
               AND has_schema_privilege($1, n.oid, 'CREATE')
             )
             OR EXISTS (
               SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
               AND CASE WHEN c.relkind IN ('r', 'p', 'v', 'm', 'f') THEN
                 has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 OR has_any_column_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END
             )
             OR EXISTS (
               SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
               AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1, c.oid, 'USAGE,SELECT,UPDATE') ELSE false END
             )
             OR EXISTS (
               SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND p.prosecdef
               AND has_function_privilege($1, p.oid, 'EXECUTE')
             ) AS allowed`,
          [record.loginRole, coreDatabase],
        );
        if (coreAccess.rows[0]!.allowed)
          throw new ProvisioningError("The core database grants app roles access to protected data or schema changes");
        const existing = await client.query<{ owner: string }>(
          "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
          [record.database],
        );
        if (existing.rows.length && existing.rows[0]!.owner !== record.ownerRole)
          throw new ProvisioningError("The Render app database does not match its saved owner");
        if (!existing.rows.length) {
          if (record.ready) throw new ProvisioningError("The retained Render app database is missing");
          await client.query(
            `CREATE DATABASE ${identifier(record.database)} OWNER ${identifier(record.ownerRole)} TEMPLATE template0 ALLOW_CONNECTIONS false`,
          );
        }
        await transaction(client, async () => {
          await client.query(`REVOKE ALL ON DATABASE ${identifier(record.database)} FROM PUBLIC`);
          await client.query(
            `GRANT CONNECT, TEMPORARY ON DATABASE ${identifier(record.database)} TO ${identifier(record.loginRole)}`,
          );
          await client.query(`ALTER DATABASE ${identifier(record.database)} ALLOW_CONNECTIONS true`);
        });
        const appAdmin = new pg.Client({
          connectionString: connectionUrl(adminUrl, record.database),
          connectionTimeoutMillis: 10_000,
        });
        appAdmin.on("error", () => {});
        try {
          await appAdmin.connect();
          await appAdmin.query("SET statement_timeout = '30s'");
          await transaction(appAdmin, async () => {
            await appAdmin.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
            await appAdmin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(record.loginRole)}`);
          });
        } finally {
          await appAdmin.end();
        }
        await client.query(`ALTER ROLE ${identifier(record.loginRole)} LOGIN`);
        const login = { role: record.loginRole, password };
        const app = new pg.Client({
          connectionString: connectionUrl(adminUrl, record.database, login),
          connectionTimeoutMillis: 10_000,
        });
        app.on("error", () => {});
        try {
          await app.connect();
          await app.query("SELECT 1");
        } finally {
          await app.end();
        }
        if (!record.ready) await opts.store.put(deploymentId, { ...record, ready: true });
        return { DATABASE_URL: connectionUrl(appEndpoint, record.database, login) };
      } catch (error) {
        throw provisioningFailure(error);
      } finally {
        await client.end();
      }
    },
  };
}
