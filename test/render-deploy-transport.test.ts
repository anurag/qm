import assert from "node:assert/strict";
import { createServer as createHttpServer, request } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";
import type { App } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "render-transport-secret".repeat(3);

for (const surface of ["proxy", "fetch"]) {
  test(`Render ${surface} avoids an old pooled connection after restore`, async () => {
    let restored = false;
    const connections = new Map<Socket, boolean>();
    const headers: Array<string | undefined> = [];
    const upstream = createHttpServer((req, res) => {
      headers.push(req.headers.connection);
      const revoked = restored && !connections.get(req.socket);
      res.writeHead(revoked ? 500 : 200, { "content-type": "text/plain" });
      res.end(revoked ? "revoked storage credential" : "restored storage available");
    });
    upstream.on("connection", (socket) => connections.set(socket, restored));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as AddressInfo).port;
    const app = {
      authorizesCapabilityScope: async () => true,
      reachDeployment: async () => ({
        status: "ok",
        id: "app",
        endpoint: { host: "127.0.0.1", port, proxyHeaders: { connection: "close" } },
      }),
    } as unknown as App;
    const server = createInsecureTestServer(app, { capabilitySecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const warm = request({ hostname: "127.0.0.1", port, path: "/verify" }, (response) => {
          response.resume();
          response.on("end", resolve);
        });
        warm.on("error", reject);
        warm.end();
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(connections.size, 1);
      assert.equal(headers[0], "keep-alive");
      restored = true;
      const token = await mintCapabilityToken(
        { actorId: "U1", scopeId: scopeId("personal", "U1"), aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 },
        SECRET,
      );
      for (let index = 0; index < 3; index++) {
        const path = surface === "proxy" ? "/d/app/verify" : "/v1/deployments/app/fetch?path=%2Fverify";
        const response = await fetch(base + path, {
          headers: surface === "fetch" ? { "x-agent-capability": token } : {},
        });
        assert.equal(response.status, 200);
        if (surface === "proxy") assert.equal(await response.text(), "restored storage available");
        else {
          const result = (await response.json()) as { status: number; body: string };
          assert.equal(result.status, 200);
          assert.equal(result.body, "restored storage available");
        }
      }
      assert.equal(connections.size, 4);
      assert.deepEqual(headers.slice(1), ["close", "close", "close"]);
    } finally {
      server.closeAllConnections();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
}
