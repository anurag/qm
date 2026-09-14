import { sleep } from "../util/async.ts";

export class RenderApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`Render ${method} ${path.split("?")[0]}: HTTP ${status}`);
    this.status = status;
  }

  get rejected(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408;
  }
}

export interface RenderApi {
  request<T>(method: string, path: string, body?: unknown, allowMissing?: boolean): Promise<T | null>;
}

export async function list<T>(
  api: RenderApi,
  path: string,
  key: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const rows: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ ...query, limit: "100", ...(cursor ? { cursor } : {}) });
    const page = await api.request<Array<Record<string, unknown> & { cursor?: string }>>("GET", `${path}?${params}`);
    if (!Array.isArray(page)) throw new Error(`Render returned an invalid ${key} list`);
    rows.push(...page.map((row) => row[key] as T));
    if (page.length < 100) return rows;
    cursor = page.at(-1)?.cursor;
    if (!cursor || cursors.has(cursor)) throw new Error(`Render ${key} pagination did not advance`);
    cursors.add(cursor);
  }
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
