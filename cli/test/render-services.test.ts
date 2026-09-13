import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfigAt, renderSource } from "../src/config.ts";
import { renderMinioImage } from "../src/render-minio.ts";
import { renderScaffold } from "../src/provider-scaffold.ts";
import { renderBuild, renderServiceEnv, renderWorkloads } from "../src/render-services.ts";
import { computedSecrets } from "../src/secrets.ts";

interface ScaffoldConfig {
  render: Record<string, unknown>;
  env: { core: Record<string, string> };
  plugins?: Record<string, unknown>[];
}

function deployment(t: TestContext, change?: (raw: ScaffoldConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), "qm-render-services-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = JSON.parse(renderScaffold.renderConfig("acme", "anthropic", "resend")) as ScaffoldConfig;
  change?.(raw);
  const path = join(dir, "qm.config.jsonc");
  writeFileSync(path, JSON.stringify(raw));
  return { dir, path, raw, config: loadConfigAt(path).config };
}

const connections = {
  databaseUrl: "postgres://qm:password@postgres/qm",
  coreUrl: "http://core-assigned:8080",
  webUiUrl: "http://web-ui:8080",
  projectId: "prj-acme",
  environmentId: "evm-production",
  postgresId: "dpg-acme",
  appDatabaseEndpoint: "postgresql://pg.oregon-postgres.render.com:5432/?sslmode=verify-full",
};

test("Render Git source accepts GitHub repositories and branch names without credentials", () => {
  assert.deepEqual(renderSource({ repo: "https://github.com/acme/qm.git/", branch: "feature/render" }, "config"), {
    repo: "https://github.com/acme/qm",
    branch: "feature/render",
  });
  for (const source of [
    {},
    { repo: "https://github.com/acme/qm" },
    { repo: "https://github.com/acme/qm", branch: "main", commit: "a" },
    ...[
      "http://github.com/acme/qm",
      "git@github.com:acme/qm.git",
      "https://token@github.com/acme/qm",
      "https://github.com/acme/qm?token=secret",
      "https://github.com/acme/..",
      "https://github.com/acme/qm/tree/main",
      "https://other.test/acme/qm",
    ].map((repo) => ({ repo, branch: "main" })),
    ...[
      "",
      "@",
      "bad branch",
      "-main",
      "../main",
      "main..next",
      "feature//name",
      "main.lock",
      "feature/.hidden",
      "main@{1}",
      "main\nnext",
      "main*",
      "main\\next",
      "main/",
      "main.",
    ].map((branch) => ({ repo: "https://github.com/acme/qm", branch })),
  ])
    assert.throws(() => renderSource(source, "config"), /render.source/);
});

test("Render Git builds bypass image lookup and retain explicit image overrides", (t) => {
  const { config, dir } = deployment(t, (raw) => {
    raw.render.source = { repo: "https://github.com/acme/qm", branch: "feature/render" };
  });
  assert.deepEqual(
    renderBuild(config, "deploy/core/Dockerfile", () => {
      throw new Error("image lookup must not run");
    }),
    {
      source: config.render!.source,
      dockerfile: "deploy/core/Dockerfile",
    },
  );
  assert.ok(renderWorkloads(config, dir).every((workload) => workload.source));
  const core = renderServiceEnv(config, "core", new Map(), connections);
  assert.equal(core.RENDER_DEPLOY_REPO, "https://github.com/acme/qm");
  assert.equal(core.RENDER_DEPLOY_BRANCH, "feature/render");
  assert.equal(core.RENDER_DEPLOY_IMAGE, "");
  config.imageOverrides.core = "example.test/core:custom";
  config.env.core!.RENDER_DEPLOY_IMAGE = "example.test/runner:custom";
  assert.equal(
    renderWorkloads(config, dir).find((workload) => workload.name === "core")!.image,
    "example.test/core:custom",
  );
  const overridden = renderServiceEnv(config, "core", new Map(), connections);
  assert.equal(overridden.RENDER_DEPLOY_IMAGE, "example.test/runner:custom");
  assert.equal(overridden.RENDER_DEPLOY_REPO, "");
  assert.equal(overridden.RENDER_DEPLOY_BRANCH, "");
});

test("Render init selects managed MinIO without generated infrastructure files or storage inputs", (t) => {
  const { config } = deployment(t);
  assert.deepEqual(config.render?.storage, { type: "minio", plan: "0.5c-512mb", diskSizeGB: 10 });
  assert.deepEqual(renderScaffold.files(config), []);
  const secrets = computedSecrets(config);
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])
    assert.equal(secrets.find((secret) => secret.name === key)?.managedBy, "render");
  assert.equal(
    secrets.some((secret) => secret.name === "AWS_SESSION_TOKEN"),
    false,
  );
  assert.match(renderMinioImage, /@sha256:[a-f0-9]{64}$/);
});

test("Render core receives scoped storage credentials and assigned URLs", (t) => {
  const { config } = deployment(t);
  config.apiUrl = "https://core-assigned.onrender.com";
  config.publicUrl = "https://portal-assigned.onrender.com";
  const values = new Map([
    ["AWS_ACCESS_KEY_ID", "qm-storage"],
    ["AWS_SECRET_ACCESS_KEY", "scoped-secret"],
    ["AWS_ENDPOINT_URL_S3", "https://minio-assigned.onrender.com"],
    ["MINIO_ROOT_USER", "root-user"],
    ["MINIO_ROOT_PASSWORD", "root-secret"],
    ["AWS_SESSION_TOKEN", "old-token"],
    ["CORE_SIGNING_SECRET", "qm-signing-key"],
  ]);
  const core = renderServiceEnv(config, "core", values, connections);
  assert.equal(core.AWS_ACCESS_KEY_ID, "qm-storage");
  assert.equal(core.AWS_SECRET_ACCESS_KEY, "scoped-secret");
  assert.equal(core.AWS_ENDPOINT_URL_S3, "https://minio-assigned.onrender.com");
  assert.equal(core.AWS_SESSION_TOKEN, "");
  assert.equal(core.S3_BUCKET, "qm-storage");
  assert.equal(core.S3_FORCE_PATH_STYLE, "true");
  assert.equal(core.RENDER_QM_MINIO, "true");
  assert.equal(core.RENDER_PROJECT_ID, connections.projectId);
  assert.equal(core.RENDER_POSTGRES_ID, connections.postgresId);
  assert.equal(core.RENDER_APP_DATABASE_ENDPOINT, connections.appDatabaseEndpoint);
  assert.equal(core.RENDER_ENVIRONMENT_ID, connections.environmentId);
  assert.equal(core.PUBLIC_API_URL, config.apiUrl);
  assert.equal(core.PUBLIC_WEB_URL, config.publicUrl);
  assert.equal(core.DATABASE_URL, connections.databaseUrl);
  assert.equal(core.CORE_SIGNING_SECRET, "qm-signing-key");
  for (const service of ["core", "web-ui", "portal"]) {
    const env = renderServiceEnv(config, service, values, connections);
    assert.equal(env.CORE_API_URL, connections.coreUrl);
    assert.equal(env.MINIO_ROOT_USER, undefined);
    assert.equal(env.MINIO_ROOT_PASSWORD, undefined);
    if (service !== "core") {
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(env.RENDER_POSTGRES_ID, undefined);
      assert.equal(env.RENDER_APP_DATABASE_ENDPOINT, undefined);
    }
  }
  const portal = renderServiceEnv(config, "portal", values, connections);
  assert.equal(portal.OIDC_ISSUER, `${config.publicUrl}/idp`);
  assert.equal(portal.AUTH_REDIRECT_URI, `${config.publicUrl}/auth/callback`);
  assert.equal(portal.ADMIN_UPSTREAM, "http://web-ui:8080/admin");
  assert.equal(renderServiceEnv(config, "slack", values, connections).PUBLIC_API_URL, config.apiUrl);
});

test("Render plugins keep their published commands and receive only declared secrets", (t) => {
  const { config, dir } = deployment(t, (raw) => {
    raw.plugins = [
      { name: "reports", image: "example.test/reports:1", secrets: [{ name: "REPORT_TOKEN" }] },
      {
        name: "isolated",
        image: "example.test/isolated:1",
        coreAccess: false,
        env: { PUBLIC_API_URL: "https://own.example.test", PUBLIC_WEB_URL: "https://web.example.test" },
      },
    ];
  });
  const values = new Map([
    ["REPORT_TOKEN", "report-token"],
    ["AWS_SECRET_ACCESS_KEY", "scoped-secret"],
    ["CORE_SIGNING_SECRET", "signing-secret"],
  ]);
  const workloads = renderWorkloads(config, dir);
  const reports = workloads.find((workload) => workload.name === "reports")!;
  assert.equal(reports.image, "example.test/reports:1");
  const reportEnv = renderServiceEnv(config, reports.name, values, connections, reports.plugin);
  assert.equal(reportEnv.REPORT_TOKEN, "report-token");
  assert.equal(reportEnv.CORE_SIGNING_SECRET, "signing-secret");
  assert.equal(reportEnv.AWS_SECRET_ACCESS_KEY, undefined);
  const isolated = workloads.find((workload) => workload.name === "isolated")!;
  const env = renderServiceEnv(config, isolated.name, values, connections, isolated.plugin);
  assert.equal(env.PUBLIC_API_URL, "https://own.example.test");
  assert.equal(env.PUBLIC_WEB_URL, "https://web.example.test");
  assert.equal(env.CORE_API_URL, undefined);
  assert.equal(env.CORE_SIGNING_SECRET, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test("external storage retains operator secrets and can clear an old temporary token", (t) => {
  const { config } = deployment(t, (raw) => {
    delete raw.render.storage;
    raw.env.core.S3_BUCKET = "existing-bucket";
  });
  assert.deepEqual(config.render?.storage, { type: "external" });
  const secrets = computedSecrets(config);
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"])
    assert.equal(secrets.find((secret) => secret.name === key)?.managedBy, "operator");
  const env = renderServiceEnv(
    config,
    "core",
    new Map([
      ["AWS_ACCESS_KEY_ID", "external-key"],
      ["AWS_SECRET_ACCESS_KEY", "external-secret"],
      ["AWS_SESSION_TOKEN", ""],
    ]),
    connections,
  );
  assert.equal(env.AWS_SECRET_ACCESS_KEY, "external-secret");
  assert.equal(env.AWS_SESSION_TOKEN, "");
  assert.equal(env.AWS_ENDPOINT_URL_S3, "");
  assert.equal(env.S3_FORCE_PATH_STYLE, "false");
  assert.equal(env.RENDER_QM_MINIO, "false");
  assert.equal(env.S3_BUCKET, "existing-bucket");
});

test("removing hosted auth, admin, and Slack resets their managed settings", (t) => {
  const { config } = deployment(t);
  config.services = config.services.filter((service) => !["auth", "admin", "slack"].includes(service));
  config.env.portal = { OIDC_ISSUER: "https://idp.example.test" };
  const core = renderServiceEnv(config, "core", new Map(), connections);
  for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET", "AUTH_ALLOWED_EMAIL_DOMAIN"])
    assert.equal(core[key], "");
  const portal = renderServiceEnv(config, "portal", new Map(), connections);
  assert.equal(portal.AUTH_EMBEDDED, "0");
  assert.equal(portal.AUTH_BROKER_UPSTREAM, "");
  assert.equal(portal.ADMIN_UPSTREAM, "");
  assert.equal(portal.OIDC_ISSUER, "https://idp.example.test");
  assert.equal(portal.OIDC_ALLOWED_EMAIL_DOMAIN, "");
});

test("removing an embedded auth domain clears the core and broker allowlists", (t) => {
  const { config } = deployment(t);
  config.env.auth = { AUTH_ALLOWED_EMAIL_DOMAIN: "example.test" };
  assert.equal(renderServiceEnv(config, "core", new Map(), connections).AUTH_ALLOWED_EMAIL_DOMAIN, "example.test");
  delete config.env.auth.AUTH_ALLOWED_EMAIL_DOMAIN;
  const core = renderServiceEnv(config, "core", new Map(), connections);
  const portal = renderServiceEnv(config, "portal", new Map(), connections);
  assert.equal(core.AUTH_ALLOWED_EMAIL_DOMAIN, "");
  assert.equal(portal.AUTH_ALLOWED_EMAIL_DOMAIN, "");
  assert.equal(portal.OIDC_ALLOWED_EMAIL_DOMAIN, "");
});

test("Render storage validates settings and reserves bundled resource names", (t) => {
  const { path, raw } = deployment(t);
  for (const storage of [
    { type: "other" },
    { type: "external", diskSizeGB: 10 },
    { type: "minio", plan: "free" },
    { type: "minio", diskSizeGB: 0 },
    { type: "minio", diskSizeGB: 1.5 },
  ]) {
    writeFileSync(path, JSON.stringify({ ...raw, render: { ...raw.render, storage } }));
    assert.throws(() => loadConfigAt(path), /render.storage/);
  }
  const source = { ...raw, plugins: [{ name: "minio", image: "example.test/plugin:1" }] };
  writeFileSync(path, JSON.stringify(source));
  assert.throws(() => loadConfigAt(path), /conflicts with bundled Render storage/);
  source.render = { ...source.render, storage: { type: "external" } };
  writeFileSync(path, JSON.stringify(source));
  assert.equal(loadConfigAt(path).config.plugins[0]!.name, "minio");
});
