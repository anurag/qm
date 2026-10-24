import { CliError } from "./log.ts";

import { sleep } from "./util.ts";

type RenderRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

class RenderApiError extends CliError {
  readonly status: number;
  constructor(status: number, path: string, method: string, detail: string, requestId: string | null) {
    super(
      `Render ${method} ${path.split("?")[0]} failed (HTTP ${status})${detail ? `: ${detail}` : ""}${requestId ? ` [request id ${requestId}]` : ""}`,
    );
    this.status = status;
  }
  get rejected(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

const RENDER_ATTEMPTS = 4;

const RENDER_TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

function retryDelayMs(attempt: number, response?: Response): number {
  const raw = response?.headers.get("retry-after")?.trim();
  if (raw) {
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(raw) - Date.now());
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, 30_000);
  }
  return Math.round(Math.min(8_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
}

export function renderClient(apiKey: string): RenderRequest {
  return async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const idempotent = method !== "POST";
    let attempt = 1;
    let response: Response;
    for (; ; attempt++) {
      try {
        response = await fetch(`https://api.render.com/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000),
          redirect: "error",
        });
      } catch (error) {
        if (!idempotent || attempt >= RENDER_ATTEMPTS) throw error;
        await sleep(retryDelayMs(attempt));
        continue;
      }
      const transient = response.status === 429 || (idempotent && RENDER_TRANSIENT_STATUSES.has(response.status));
      if (!transient || attempt >= RENDER_ATTEMPTS) break;
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(attempt, response));
    }
    if (method === "DELETE" && attempt > 1 && response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return undefined as T;
    }
    if (!response.ok)
      throw new RenderApiError(
        response.status,
        path,
        method,
        (await response.text().catch(() => "")).slice(0, 200),
        response.headers.get("render-request-id"),
      );
    const text = await response.text();
    if (!text) return undefined as T;
    return (response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
  };
}
