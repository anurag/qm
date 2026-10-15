import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const ORG = "org:default-org";

interface Sources {
  composio: { configured: boolean };
  oauth: { configured: string[] };
  setup: {
    composioCredentialUrl?: string;
    composioVerifierUrl?: string;
    oauthAppsUrl?: string;
    oauthCallbackUrls?: Record<string, string>;
  };
}

function start(urls: { publicUrl?: string; portalUrl?: string } = {}): {
  base: string;
  built: BuiltApp;
  close: () => Promise<void>;
} {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "connector-sources-")) }));
  const server = createInsecureTestServer(built.app, {
    resolveClient: built.resolveClient,
    serviceCreds: built.serviceCreds,
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    ...urls,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const read = (base: string, headers: Record<string, string> = ADMIN) =>
  fetch(`${base}/v1/admin/connector-sources`, { headers });

test("connector sources report nothing configured with admin setup links", async () => {
  const srv = start({ publicUrl: "https://api.example/", portalUrl: "https://qm.example" });
  try {
    const res = await read(srv.base);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Sources;
    assert.deepEqual(body.composio, { configured: false });
    assert.deepEqual(body.oauth, { configured: [] });
    assert.equal(body.setup.composioCredentialUrl, "https://qm.example/admin/credentials");
    assert.equal(body.setup.composioVerifierUrl, "https://qm.example/api/composio/callback");
    assert.equal(body.setup.oauthAppsUrl, "https://qm.example/admin/connectors");
    assert.equal(body.setup.oauthCallbackUrls?.google, "https://api.example/v1/connectors/oauth/google/callback");
    assert.ok((await srv.built.auditLog.events()).some((event) => event.action === "connector-sources.read"));
  } finally {
    await srv.close();
  }
});

test("connector sources detect Composio and OAuth apps without returning secrets", async () => {
  const srv = start({ publicUrl: "https://api.example" });
  try {
    await srv.built.serviceCreds.setServiceCredential(ORG, {
      slug: "composio",
      name: "Composio",
      delivery: "env",
      envKey: "COMPOSIO_API_KEY",
      secret: "COMPOSIO_SECRET_SENTINEL",
      host: "",
    });
    const put = await fetch(`${srv.base}/v1/admin/scopes/${ORG}/connectors`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ provider: "google", clientId: "cid", clientSecret: "OAUTH_SECRET_SENTINEL" }),
    });
    assert.equal(put.status, 200);
    const res = await read(srv.base);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /SECRET_SENTINEL/);
    const body = JSON.parse(text) as Sources;
    assert.deepEqual(body.composio, { configured: true });
    assert.deepEqual(body.oauth, { configured: ["google"] });
    assert.equal(body.setup.oauthAppsUrl, "https://api.example/admin/connectors");
    assert.equal(body.setup.composioVerifierUrl, undefined);
  } finally {
    await srv.close();
  }
});

test("disabled Composio credentials and disabled OAuth apps do not count as sources", async () => {
  const srv = start();
  try {
    await srv.built.serviceCreds.setServiceCredential(ORG, {
      slug: "composio",
      name: "Composio",
      delivery: "env",
      envKey: "COMPOSIO_API_KEY",
      secret: "k",
      host: "",
      enabled: false,
    });
    for (const enabled of [true, false]) {
      await fetch(`${srv.base}/v1/admin/scopes/${ORG}/connectors`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ provider: "google", clientId: "cid", clientSecret: "s", enabled }),
      });
    }
    const [google] = await srv.built.config.listConnectorClients(ORG);
    assert.equal(google?.enabled, false);
    const body = (await (await read(srv.base)).json()) as Sources;
    assert.deepEqual(body.composio, { configured: false });
    assert.deepEqual(body.oauth, { configured: [] });
    assert.deepEqual(body.setup, {});
  } finally {
    await srv.close();
  }
});

test("connector sources are admin-only", async () => {
  const srv = start();
  try {
    assert.equal((await read(srv.base, { "x-admin-actor": "nobody@default-org" })).status, 403);
  } finally {
    await srv.close();
  }
});
