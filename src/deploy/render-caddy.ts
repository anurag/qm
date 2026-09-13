import { createHash } from "node:crypto";

export const RENDER_GATEWAY_IMAGE =
  "docker.io/library/caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648";
export const RENDER_GATEWAY_COMMAND =
  "/bin/sh -c cp /usr/bin/caddy /tmp/qm-caddy && exec /tmp/qm-caddy run --config /etc/secrets/qm-render-gateway.json";
export const RENDER_GATEWAY_AUTH_HEADER = "X-Qm-Gateway-Token";
export const RENDER_GATEWAY_APP_HEADER = "X-Qm-App-Id";

export function renderGatewayConfigHash(token: string, routes: Record<string, { host: string; port: number }>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        token,
        Object.entries(routes)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, { host, port }]) => [id, host, port]),
      ]),
    )
    .digest("hex");
}

export function renderGatewayConfig(token: string, routes: Record<string, { host: string; port: number }>): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").toString("base64url") !== token) {
    throw new Error("Render gateway token must contain 32 bytes encoded as base64url");
  }
  const appRoutes = Object.entries(routes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([appId, { host, port }]) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(appId)) {
        throw new Error("Render gateway app ID must be a UUID");
      }
      if (
        host.length > 253 ||
        !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        /^[0-9.]+$/.test(host)
      ) {
        throw new Error("Render gateway upstream host must be a DNS name");
      }
      if (port !== 8080) throw new Error("Render gateway upstream port must be 8080");
      return {
        match: [{ vars: { [`{http.request.header.${RENDER_GATEWAY_APP_HEADER}}`]: [appId] } }],
        handle: [
          { handler: "log_append", key: "app_id", value: appId },
          {
            handler: "headers",
            request: { delete: [RENDER_GATEWAY_AUTH_HEADER, RENDER_GATEWAY_APP_HEADER] },
          },
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: `${host}:${port}` }],
            transport: { protocol: "http", keep_alive: { enabled: false } },
          },
        ],
        terminal: true,
      };
    });
  const forbidden = { handler: "static_response", status_code: 403, body: "Forbidden\n" };
  return JSON.stringify({
    admin: { disabled: true, config: { persist: false } },
    logging: {
      logs: {
        default: {
          writer: { output: "stdout" },
          encoder: {
            format: "filter",
            wrap: { format: "json", message_key: "" },
            fields: {
              request: { filter: "delete" },
              resp_headers: { filter: "delete" },
              error: { filter: "delete" },
            },
          },
        },
      },
    },
    apps: {
      http: {
        servers: {
          gateway: {
            listen: [":8080"],
            automatic_https: { disable: true },
            logs: {},
            routes: [
              {
                match: [{ path: ["/__qm_gateway_health"], header: { [RENDER_GATEWAY_APP_HEADER]: null } }],
                handle: [{ handler: "static_response", status_code: 200, body: "OK\n" }],
                terminal: true,
              },
              {
                match: [{ not: [{ vars: { [`{http.request.header.${RENDER_GATEWAY_AUTH_HEADER}}`]: [token] } }] }],
                handle: [forbidden],
                terminal: true,
              },
              {
                match: [{ path: ["/__qm_gateway_config"], header: { [RENDER_GATEWAY_APP_HEADER]: null } }],
                handle: [
                  { handler: "static_response", status_code: 200, body: renderGatewayConfigHash(token, routes) },
                ],
                terminal: true,
              },
              ...appRoutes,
              { handle: [forbidden], terminal: true },
            ],
          },
        },
      },
    },
  });
}
