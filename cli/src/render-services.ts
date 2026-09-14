import { securityScreenEnv, type QmConfig } from "./config.ts";
import { CliError } from "./log.ts";
import { discoverPlugins, type ResolvedPlugin } from "./plugins.ts";
import { computedSecrets, runtimeSecretNames } from "./secrets.ts";
import {
  brandEnvOf,
  brokerWiring,
  hostedServiceEnv,
  ordered,
  orgEnv,
  runnableServices,
  virtualServiceEnv,
} from "./services.ts";

export function renderWorkloads(
  config: QmConfig,
  configDir: string,
): Array<RenderBuild & { name: string; plugin?: ResolvedPlugin }> {
  const discovered = discoverPlugins(configDir, config);
  if (discovered.errors.length) throw new CliError(discovered.errors.join("\n"));
  const source = config.render?.source;
  if (!source) throw new CliError("Render requires a render config block");
  const build = (dockerfile: string): RenderBuild => ({ source, dockerfile });
  return [
    ...ordered(runnableServices(config.services)).flatMap((service) =>
      [service.name, ...(service.name === "core" ? ["worker"] : [])].map((name) => ({
        name,
        ...build(`deploy/${service.name}/Dockerfile`),
      })),
    ),
    ...discovered.plugins.map((plugin) => ({
      name: plugin.name,
      ...build(`plugins/${plugin.name}/Dockerfile`),
      plugin,
    })),
  ];
}

export interface RenderBuild {
  source: NonNullable<QmConfig["render"]>["source"];
  dockerfile: string;
}

export function renderEnvService(workload: string): string {
  return workload === "worker" ? "core" : workload;
}

export function renderServiceEnv(
  config: QmConfig,
  workload: string,
  values: ReadonlyMap<string, string>,
  connections: {
    databaseUrl: string;
    coreUrl: string;
    webUiUrl?: string;
    projectId?: string;
    environmentId?: string;
    postgresId?: string;
    appDatabaseEndpoint?: string;
    minioServiceId?: string;
    sourceCommit?: string;
  },
  plugin?: ResolvedPlugin,
): Record<string, string> {
  const render = config.render;
  if (!render) throw new CliError("Render requires a render config block");
  const service = renderEnvService(workload);
  const coreAccess = (plugin ?? config.plugins.find((item) => item.name === service))?.coreAccess !== false;
  const out: Record<string, string> = {
    ...hostedServiceEnv(config.services, config.env, service),
    ...(service === "core" ? virtualServiceEnv(config.services, config.env) : {}),
    ...plugin?.env,
    ...orgEnv(service, config.orgId, config.publicUrl, config.services.includes("portal"), brandEnvOf(config)),
    PORT: "8080",
    ...(coreAccess ? { CORE_API_URL: connections.coreUrl } : {}),
  };
  if (config.services.includes("auth"))
    Object.assign(
      out,
      brokerWiring(service, {
        publicUrl: config.publicUrl,
        authBaseUrl: "http://127.0.0.1:8099",
        ...(config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN
          ? { allowedEmailDomain: config.env.auth.AUTH_ALLOWED_EMAIL_DOMAIN }
          : {}),
      }),
    );
  const managedValues: Record<string, string> = {
    ...(coreAccess ? { DATABASE_URL: connections.databaseUrl } : {}),
    PUBLIC_API_URL: config.apiUrl ?? config.publicUrl,
  };
  for (const secret of computedSecrets(config)) {
    let value: string | undefined;
    if (secret.managedBy === "render")
      value = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].includes(secret.name)
        ? values.get(secret.name)
        : managedValues[secret.name];
    else if (secret.managedBy === "operator") value = values.get(secret.name);
    if (value === undefined) continue;
    for (const name of runtimeSecretNames(
      service,
      secret,
      config.plugins.filter((item) => item.coreAccess !== false).map((item) => item.name),
    ))
      out[name] = value;
  }
  if (service === "core")
    Object.assign(out, {
      HARNESS: config.env.core?.HARNESS ?? "pi",
      ...securityScreenEnv(config),
      DATA_DIR: "/data",
      SESSION_STORE: "postgres",
      RUN_STORE: "postgres",
      WORKSPACE_STORE: "s3",
      SNAPSHOT_STORE: "s3",
      TRANSFER_STORE: "s3",
      DATABASE_URL: connections.databaseUrl,
      PUBLIC_API_URL: config.apiUrl,
      SANDBOX_BACKEND: "render",
      DEPLOY_PROVIDER: "render",
      RENDER_WORKSPACE_ID: render.workspaceId,
      RENDER_REGION: render.region,
      RENDER_APP_REGION: render.appRegion ?? render.region,
      ...(connections.projectId ? { RENDER_PROJECT_ID: connections.projectId } : {}),
      ...(connections.minioServiceId ? { RENDER_MINIO_SERVICE_ID: connections.minioServiceId } : {}),
      ...(connections.postgresId ? { RENDER_POSTGRES_ID: connections.postgresId } : {}),
      ...(connections.appDatabaseEndpoint ? { RENDER_APP_DATABASE_ENDPOINT: connections.appDatabaseEndpoint } : {}),
      ...(connections.environmentId ? { RENDER_ENVIRONMENT_ID: connections.environmentId } : {}),
      RENDER_DEPLOY_REPO: render.source.repo,
      RENDER_DEPLOY_BRANCH: render.source.branch,
      ...(connections.sourceCommit
        ? { RENDER_DEPLOY_COMMIT: connections.sourceCommit, GIT_SHA: connections.sourceCommit }
        : {}),
      ...(config.model ? { PI_MODEL: config.model } : {}),
      ...(config.modelProvider ? { MODEL_PROVIDER: config.modelProvider } : {}),
      ...(workload === "core" ? { WORKERS: "0" } : {}),
    });
  if (service === "core") {
    out.AUTH_ALLOWED_EMAIL_DOMAIN =
      (config.services.includes("auth") ? config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN : undefined) ??
      config.env.core?.AUTH_ALLOWED_EMAIL_DOMAIN ??
      "";
    if (!config.services.includes("slack")) {
      for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET"]) out[key] = "";
    }
    Object.assign(out, {
      S3_BUCKET: "qm-storage",
      S3_REGION: "us-east-1",
      S3_FORCE_PATH_STYLE: "true",
      AWS_ENDPOINT_URL_S3: values.get("AWS_ENDPOINT_URL_S3") ?? "",
      AWS_ACCESS_KEY_ID: "qm-storage",
      AWS_SESSION_TOKEN: "",
    });
  }
  if (service === "portal") {
    Object.assign(out, {
      ...(connections.webUiUrl ? { WEB_UI_UPSTREAM: connections.webUiUrl } : {}),
      ADMIN_UPSTREAM: connections.webUiUrl && config.services.includes("admin") ? `${connections.webUiUrl}/admin` : "",
    });
    if (config.services.includes("auth")) {
      for (const key of ["AUTH_ALLOWED_EMAIL_DOMAIN", "OIDC_ALLOWED_EMAIL_DOMAIN"])
        out[key] = config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN ?? "";
    } else {
      out.AUTH_EMBEDDED = "0";
      for (const [key, value] of Object.entries({
        AUTH_BROKER_UPSTREAM: "",
        OIDC_AUTH_ENDPOINT: "https://slack.com/openid/connect/authorize",
        OIDC_TOKEN_ENDPOINT: "https://slack.com/api/openid.connect.token",
        OIDC_USERINFO_ENDPOINT: "https://slack.com/api/openid.connect.userInfo",
        OIDC_ISSUER: "https://slack.com",
        OIDC_JWKS_URI: "https://slack.com/openid/connect/keys",
        OIDC_SCOPES: "openid profile email",
        OIDC_PRINCIPAL_CLAIM: "email",
        OIDC_ALLOWED_EMAIL_DOMAIN: "",
      }))
        out[key] = config.env.portal?.[key] ?? value;
    }
  }
  return out;
}
