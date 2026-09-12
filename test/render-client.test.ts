import { test } from "node:test";
import assert from "node:assert/strict";
import { createSdkRenderClient } from "../src/sandbox/render-client.ts";

const sandbox = {
  id: "sbx-test",
  status: "running",
  plan: "standard",
  networkPolicy: { default: "allow" },
  region: "oregon",
  timeoutSeconds: 7200,
  createdAt: "2026-09-12T00:00:00Z",
};
const snapshot = {
  id: "snp-test",
  sandboxGroupId: "sbg-test",
  sourceSandboxId: "sbx-test",
  kind: "filesystem",
  status: "available",
  plan: "standard",
  requestedAt: "2026-09-12T00:00:00Z",
  capturedAt: "2026-09-12T00:00:01Z",
  expiresAt: "2026-10-12T00:00:00Z",
};

test("Render SDK adapter uses the published create and snapshot contracts", async (t) => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    requests.push({ method: request.method, path: url.pathname, ...(body ? { body: JSON.parse(body) } : {}) });
    assert.equal(request.headers.get("authorization"), "Bearer secret");
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(url.pathname.endsWith("/sandboxes") ? sandbox : snapshot);
  });
  const client = createSdkRenderClient({
    apiKey: "secret",
    workspaceId: "tea-test",
    region: "oregon",
    plan: "standard",
    ttlSec: 7200,
  });
  const info = await client.create("snp-base");
  assert.equal(info.expiresAtMs, Date.parse(sandbox.createdAt) + 7200_000);
  const saved = await client.createSnapshot(info.id);
  assert.equal(saved.capturedAtMs, Date.parse(snapshot.capturedAt));
  await client.getSnapshot(saved);
  await client.deleteSnapshot(saved);
  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/v1/sandboxes",
      body: { ownerId: "tea-test", plan: "standard", timeoutSeconds: 7200, region: "oregon", snapshotId: "snp-base" },
    },
    { method: "POST", path: "/v1/sandboxes/sbx-test/snapshots", body: { kind: "filesystem" } },
    { method: "GET", path: "/v1/sandbox-groups/sbg-test/snapshots/snp-test" },
    { method: "DELETE", path: "/v1/sandbox-groups/sbg-test/snapshots/snp-test" },
  ]);
});

test("Render SDK adapter keeps stdout, stderr, and nonzero exit status", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "api.render.com") {
      return Response.json({
        uri: "https://sandbox.example/stream",
        method: "POST",
        token: "stream-secret",
        executionId: "exe-test",
      });
    }
    assert.deepEqual(await request.json(), { command: "example command" });
    return new Response(
      'event: output\ndata: {"stream":"stdout","data":"hello\\n"}\n\nevent: output\ndata: {"stream":"stderr","data":"problem\\n"}\n\nevent: exit\ndata: {"exit_code":7}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  assert.deepEqual(await client.runCommand("sbx-test", "example command", 10_000), {
    stdout: "hello\n",
    stderr: "problem\n",
    exitCode: 7,
  });
});

test("Render SDK adapter treats only HTTP 404 as a missing sandbox", async (t) => {
  let status = 404;
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "unavailable" }, { status }));
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  assert.equal(await client.get("sbx-test"), null);
  await client.terminate("sbx-test");
  status = 401;
  await assert.rejects(client.get("sbx-test"), /unavailable/);
  await assert.rejects(client.terminate("sbx-test"), /unavailable/);
});

test("Render SDK adapter rejects truncated streams", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "api.render.com")
      return Response.json({
        uri: "https://sandbox.example/stream",
        method: "POST",
        token: "token",
        executionId: "exe-test",
      });
    return new Response('event: output\ndata: {"stream":"stdout","data":"partial"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  await assert.rejects(client.runCommand("sbx-test", "side effect", 10_000), /terminal event/);
});

test("Render SDK adapter accepts an already deleted native checkpoint", async (t) => {
  let status = 404;
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "unavailable" }, { status }));
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  const checkpoint = {
    id: "snp-gone",
    sandboxGroupId: "sbg-test",
    status: "available" as const,
    expiresAtMs: Date.now(),
  };
  await client.deleteSnapshot(checkpoint);
  status = 403;
  await assert.rejects(client.deleteSnapshot(checkpoint), /unavailable/);
});
