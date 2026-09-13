import { RENDER_GATEWAY_AUTH_HEADER, RENDER_GATEWAY_APP_HEADER } from "../../src/deploy/render-caddy.ts";

export interface GatewayCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

interface FakeGatewayEnvironment {
  id: string;
  name: string;
  projectId: string;
  networkIsolationEnabled: boolean;
  protectedStatus: string;
}

interface FakeGatewayService {
  id: string;
  name: string;
  ownerId: string;
  type: string;
  environmentId: string;
  imagePath: string;
  suspended: string;
  registryCredential?: unknown;
  serviceDetails: {
    url: string;
    region: string;
    runtime: string;
    numInstances: number;
    envSpecificDetails: { dockerCommand: string };
    disk?: unknown;
  };
}

interface FakeGatewayDeploy {
  id: string;
  status: string;
  configHash: string;
}

export function createFakeRenderGateways(
  opts: {
    workspaceId?: string;
    projectId?: string;
    moveResource?: (resourceId: string, environmentId: string) => void;
  } = {},
) {
  const workspaceId = opts.workspaceId ?? "tea-qm";
  const projectId = opts.projectId ?? "prj-qm";
  const project = { id: projectId, owner: { id: workspaceId } };
  const calls: GatewayCall[] = [];
  const environments = new Map<string, FakeGatewayEnvironment>();
  const services = new Map<string, FakeGatewayService>();
  const markers = new Map<string, string>();
  const configs = new Map<string, string>();
  const liveHashes = new Map<string, string>();
  const deploys = new Map<string, FakeGatewayDeploy[]>();
  const controls: {
    deployStatus: string;
    healthy: boolean;
    healthHash?: string;
    before?: (call: GatewayCall) => Response | undefined;
    after?: (call: GatewayCall, response: Response) => Response;
  } = { deployStatus: "live", healthy: true };
  let deploySequence = 0;
  const json = (body: unknown, status = 200): Response => Response.json(body, { status });

  function configHash(serviceId: string): string {
    const config = JSON.parse(configs.get(serviceId)!);
    const routes = config.apps.http.servers.gateway.routes;
    return routes.find((route: { match?: Array<{ path?: string[] }> }) =>
      route.match?.[0]?.path?.includes("/__qm_gateway_config"),
    ).handle[0].body;
  }

  function trigger(serviceId: string): FakeGatewayDeploy {
    const deploy = {
      id: `dep-gw-${++deploySequence}`,
      status: controls.deployStatus,
      configHash: configHash(serviceId),
    };
    const previous = deploys.get(serviceId) ?? [];
    if (deploy.status === "live") {
      for (const old of previous) if (old.status === "live") old.status = "deactivated";
      liveHashes.set(serviceId, deploy.configHash);
    }
    deploys.set(serviceId, [deploy, ...previous]);
    return deploy;
  }

  function respond(call: GatewayCall): Response | undefined {
    const { method, path, query } = call;
    const body = call.body as Record<string, unknown>;
    if (path === `/projects/${projectId}` && method === "GET") return json(project);
    if (path === "/environments") {
      if (method === "GET")
        return json(
          [...environments.values()]
            .filter((env) => !query.has("name") || env.name === query.get("name"))
            .map((environment) => ({ environment, cursor: environment.id })),
        );
      if (method === "POST") {
        const environment = { ...body, id: `env-gw-${environments.size + 1}` } as unknown as FakeGatewayEnvironment;
        environments.set(environment.id, environment);
        return json(environment, 201);
      }
    }
    const environmentMatch = /^\/environments\/([^/]+)(\/resources)?$/.exec(path);
    if (environmentMatch) {
      const environment = environments.get(environmentMatch[1]!);
      if (!environment) return json({}, 404);
      if (method === "GET" && !environmentMatch[2]) return json(environment);
      if (method === "POST" && environmentMatch[2]) {
        for (const resourceId of body.resourceIds as string[]) opts.moveResource?.(resourceId, environment.id);
        return new Response(null, { status: 204 });
      }
    }
    if (path === "/services" && method === "GET" && query.get("name")?.includes("-gw-"))
      return json(
        [...services.values()]
          .filter((service) => service.name === query.get("name"))
          .map((service) => ({ service, cursor: service.id })),
      );
    if (path === "/services" && method === "POST" && body.type === "web_service") {
      const id = `srv-gw-${services.size + 1}`;
      const service = {
        ...body,
        id,
        imagePath: (body.image as { imagePath: string }).imagePath,
        suspended: "not_suspended",
        serviceDetails: { ...(body.serviceDetails as object), url: `https://${id}.onrender.com` },
      } as FakeGatewayService;
      services.set(id, service);
      markers.set(
        id,
        (body.envVars as Array<{ key: string; value: string }>).find(({ key }) => key === "QM_GATEWAY_OWNER")!.value,
      );
      configs.set(id, (body.secretFiles as Array<{ content: string }>)[0]!.content);
      return json({ service, deployId: trigger(id).id }, 201);
    }
    const serviceMatch = /^\/services\/(srv-gw-[^/]+)(.*)$/.exec(path);
    if (!serviceMatch) return undefined;
    const id = serviceMatch[1]!;
    const suffix = serviceMatch[2]!;
    const service = services.get(id);
    if (!service) return json({}, 404);
    if (method === "GET" && !suffix) return json(service);
    if (suffix === "/env-vars/QM_GATEWAY_OWNER" && method === "GET") return json({ value: markers.get(id) });
    if (suffix === "/secret-files" && method === "PUT") {
      configs.set(id, (call.body as Array<{ content: string }>)[0]!.content);
      return json([]);
    }
    if (suffix === "/deploys" && method === "GET")
      return json((deploys.get(id) ?? []).map((deploy) => ({ deploy, cursor: deploy.id })));
    if (suffix === "/deploys" && method === "POST") return json(trigger(id), 201);
    if (suffix.startsWith("/deploys/") && method === "GET") {
      const deploy = deploys.get(id)?.find((candidate) => candidate.id === suffix.slice("/deploys/".length));
      if (deploy?.status === "live") liveHashes.set(id, deploy.configHash);
      return deploy ? json(deploy) : json({}, 404);
    }
    if (suffix === "/suspend" && method === "POST") {
      service.suspended = "suspended";
      return new Response(null, { status: 202 });
    }
    if (suffix === "/resume" && method === "POST") {
      service.suspended = "not_suspended";
      trigger(id);
      return new Response(null, { status: 202 });
    }
    return undefined;
  }

  function intercept(method: string, rawPath: string, body?: unknown): Response | undefined {
    const url = new URL(rawPath, "https://api.render.com/v1/");
    const call = { method, path: url.pathname.replace(/^\/v1(?=\/)/, ""), query: url.searchParams, body };
    const path = call.path;
    const isGateway =
      path.startsWith("/environments") ||
      path.startsWith("/projects") ||
      path.includes("/srv-gw-") ||
      (path === "/services" &&
        (url.searchParams.get("name")?.includes("-gw-") ||
          (body as { type?: string } | undefined)?.type === "web_service"));
    if (!isGateway) return undefined;
    calls.push(call);
    const response = controls.before?.(call) ?? respond(call);
    return response ? (controls.after?.(call, response) ?? response) : undefined;
  }

  async function request<T>(method: string, path: string, body?: unknown, allowMissing = false): Promise<T | null> {
    const response = intercept(method, path, body);
    if (!response) throw new Error(`Unexpected gateway request: ${method} ${path}`);
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok)
      throw Object.assign(new Error(`Render ${method} ${path}: HTTP ${response.status}`), { status: response.status });
    const value = await response.text();
    return value ? (JSON.parse(value) as T) : null;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.render.com") {
      const response = intercept(
        init?.method ?? "GET",
        url.toString(),
        init?.body ? JSON.parse(String(init.body)) : undefined,
      );
      if (!response) throw new Error(`Unexpected gateway fetch: ${url.pathname}`);
      return response;
    }
    const service = [...services.values()].find(
      (candidate) => new URL(candidate.serviceDetails.url).hostname === url.hostname,
    );
    if (!service || service.suspended === "suspended" || !controls.healthy)
      return new Response("Unavailable", { status: 503 });
    const config = JSON.parse(configs.get(service.id)!);
    const token = Object.values(config.apps.http.servers.gateway.routes[1].match[0].not[0].vars)[0] as string[];
    const headers = new Headers(init?.headers);
    if (headers.get(RENDER_GATEWAY_AUTH_HEADER) !== token[0]) return new Response("Forbidden", { status: 403 });
    if (url.pathname === "/__qm_gateway_config" && !headers.has(RENDER_GATEWAY_APP_HEADER))
      return new Response(controls.healthHash ?? liveHashes.get(service.id));
    return new Response("OK");
  };

  return {
    project,
    workspaceId,
    projectId,
    calls,
    environments,
    services,
    markers,
    configs,
    liveHashes,
    deploys,
    controls,
    intercept,
    request,
    fetchImpl,
  };
}
