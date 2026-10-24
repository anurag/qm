import assert from "node:assert/strict";

import { test } from "node:test";

import { renderClient } from "../src/render-api.ts";

test("Render requests wait for an HTTP-date Retry-After before retrying", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 17) });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? new Response(null, { status: 429, headers: { "retry-after": new Date(Date.now() + 20_000).toUTCString() } })
      : Response.json({ ok: true });
  });
  const pending = renderClient("test-key")<{ ok: boolean }>("/owners/test");
  await new Promise(setImmediate);
  t.mock.timers.tick(19_999);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(calls, 2);
});
