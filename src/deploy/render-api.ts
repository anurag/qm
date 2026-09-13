import { sleep } from "../util/async.ts";

export class RenderApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`Render ${method} ${path.split("?")[0]}: HTTP ${status}`);
    this.status = status;
  }
}

export interface RenderApi {
  request<T>(method: string, path: string, body?: unknown, allowMissing?: boolean): Promise<T | null>;
}

export function createRenderApi(opts: { apiKey: string; fetchImpl?: typeof fetch }): RenderApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async request<T>(method: string, path: string, body?: unknown, allowMissing = false): Promise<T | null> {
      for (let attempt = 0; ; attempt++) {
        const response = await fetchImpl(`https://api.render.com/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (allowMissing && response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (method === "GET" && attempt < 3 && (response.status === 429 || response.status >= 500)) {
            const delay = Number(response.headers.get("retry-after"));
            await sleep(Math.min(30_000, Math.max(1_000 * 2 ** attempt, Number.isFinite(delay) ? delay * 1_000 : 0)));
            continue;
          }
          throw new RenderApiError(method, path, response.status);
        }
        const text = await response.text();
        return text ? (JSON.parse(text) as T) : null;
      }
    },
  };
}
