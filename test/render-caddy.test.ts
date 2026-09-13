import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  RENDER_GATEWAY_APP_HEADER,
  RENDER_GATEWAY_AUTH_HEADER,
  RENDER_GATEWAY_COMMAND,
  RENDER_GATEWAY_IMAGE,
  renderGatewayAppToken,
  renderGatewayConfig,
  renderGatewayConfigHash,
} from "../src/deploy/render-caddy.ts";

const token = Buffer.alloc(32, 7).toString("base64url");
const appId = "11111111-1111-4111-8111-111111111111";
const secondAppId = "22222222-2222-4222-8222-222222222222";
const routes = { [appId]: { host: "qm-upstream", port: 8080 } };
const appToken = renderGatewayAppToken(token, appId);
const secondAppToken = renderGatewayAppToken(token, secondAppId);

test("Render app tokens are stable and specific to the owner secret and app ID", () => {
  assert.equal(appToken, "TxY3GNRL3mOGDRvMLGazoJCwICJpqvNImTZzsukJn6U");
  assert.equal(Buffer.from(appToken, "base64url").length, 32);
  assert.equal(renderGatewayAppToken(token, appId), appToken);
  assert.notEqual(appToken, secondAppToken);
  assert.notEqual(appToken, token);
  assert.notEqual(renderGatewayAppToken(Buffer.alloc(32, 8).toString("base64url"), appId), appToken);
});

test("Render gateway validates secrets and fixed route addresses before it creates Caddy config", () => {
  for (const invalid of ["", "short", `${token}=`, "a".repeat(43), `${token}\n`, `{env.SECRET}${token}`]) {
    assert.throws(() => renderGatewayConfig(invalid, routes), /token must contain 32 bytes/);
    assert.throws(() => renderGatewayAppToken(invalid, appId), /token must contain 32 bytes/);
  }
  for (const id of ["", "app", `${appId}*`, `{env.APP_ID}`, `${appId}\n`, `other"${appId}`]) {
    assert.throws(() => renderGatewayConfig(token, { [id]: routes[appId]! }), /app ID must be a UUID/);
    assert.throws(() => renderGatewayAppToken(token, id), /app ID must be a UUID/);
  }
  for (const host of [
    "",
    "http://qm-upstream",
    "qm-upstream:8080",
    "qm-upstream/path",
    "qm-upstream\nlocalhost",
    "{http.request.host}",
    "$(env)",
    "localhost;env",
    "user@qm-upstream",
    "127.0.0.1",
    "[::1]",
    "-upstream",
    "upstream-",
    "a..b",
    "a".repeat(64),
    "a.".repeat(127) + "a",
  ]) {
    assert.throws(() => renderGatewayConfig(token, { [appId]: { host, port: 8080 } }), /host must be a DNS name/);
  }
  for (const port of [0, 80, 443, 8081, 65536, NaN]) {
    assert.throws(() => renderGatewayConfig(token, { [appId]: { host: "qm-upstream", port } }), /port must be 8080/);
  }
  assert.doesNotThrow(() => renderGatewayConfig(randomBytes(32).toString("base64url"), {}));
});

test("Render gateway hashes route values in a stable order and detects all config changes", () => {
  const first = { [appId]: routes[appId]!, [secondAppId]: { host: "qm-second", port: 8080 } };
  const reversed = { [secondAppId]: { port: 8080, host: "qm-second" }, [appId]: routes[appId]! };
  assert.equal(renderGatewayConfig(token, first), renderGatewayConfig(token, reversed));
  assert.equal(renderGatewayConfigHash(token, first), renderGatewayConfigHash(token, reversed));
  assert.notEqual(renderGatewayConfigHash(token, first), renderGatewayConfigHash(token, routes));
  assert.notEqual(
    renderGatewayConfigHash(token, first),
    renderGatewayConfigHash(randomBytes(32).toString("base64url"), first),
  );
  assert.notEqual(
    renderGatewayConfigHash(token, routes),
    renderGatewayConfigHash(token, { [appId]: { host: "qm-other", port: 8080 } }),
  );
  assert.notEqual(
    renderGatewayConfigHash(token, routes),
    createHash("sha256")
      .update(JSON.stringify([token, [[appId, "qm-upstream", 8080]]]))
      .digest("hex"),
  );
  assert.match(RENDER_GATEWAY_IMAGE, /^docker\.io\/library\/caddy@sha256:[0-9a-f]{64}$/);
});

const upstreamSource = String.raw`
import { createServer } from "node:http";
import { createHash } from "node:crypto";
const server = createServer(async (req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: ready\n\n");
    return;
  }
  if (req.url.startsWith("/bad-response")) {
    req.socket.end("HTTP/1.1 200 OK\r\nInvalid " + process.env.TEST_SECRET + "\r\n\r\n");
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.writeHead(200, { "content-type": "application/json", "set-cookie": "app=response-cookie", "x-app-secret": process.env.TEST_SECRET });
  res.end(JSON.stringify({ app: process.env.TEST_APP, url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString(), remotePort: req.socket.remotePort }));
});
server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  const clean = !req.headers["x-qm-gateway-token"] && !req.headers["x-qm-app-id"];
  socket.write(Buffer.from([0x81, 5, ...Buffer.from(clean ? "ready" : "leaks")]));
  socket.once("data", (data) => {
    const good = data.equals(Buffer.from([0x81, 0x84, 0, 0, 0, 0, ...Buffer.from("ping")]));
    socket.write(Buffer.from([0x81, 4, ...Buffer.from(good ? "pong" : "fail")]));
  });
});
server.listen(8080, "0.0.0.0");
`;

test(
  "Stock Caddy gates HTTP and WebSocket requests, streams SSE, and removes secrets from all logs",
  { skip: process.env.QM_TEST_CADDY !== "1", timeout: 180_000 },
  async () => {
    const name = `qm-caddy-test-${randomUUID()}`;
    const upstream = `${name}-upstream`;
    const secondUpstream = `${name}-second`;
    const directory = mkdtempSync(join(tmpdir(), "qm-caddy-test-"));
    const configPath = join(directory, "gateway.json");
    const upstreamPath = join(directory, "upstream.mjs");
    const auth = { [RENDER_GATEWAY_AUTH_HEADER]: appToken, [RENDER_GATEWAY_APP_HEADER]: appId };
    const secondAuth = { [RENDER_GATEWAY_AUTH_HEADER]: secondAppToken, [RENDER_GATEWAY_APP_HEADER]: secondAppId };
    const liveRoutes = { ...routes, [secondAppId]: { host: "qm-second", port: 8080 } };
    const shellPrefix = "/bin/sh -c ";
    assert.ok(RENDER_GATEWAY_COMMAND.startsWith(shellPrefix));
    const invokeDocker = (args: string[]) => {
      const result = spawnSync("docker", args, { encoding: "utf8", timeout: 45_000 });
      assert.ifError(result.error);
      return result;
    };
    const docker = (...args: string[]) => {
      const result = invokeDocker(args);
      assert.equal(result.status, 0, result.stderr);
      return `${result.stdout}${result.stderr}`.trim();
    };
    const rawRequest = (url: string, headers: string[]) =>
      new Promise<number>((resolve, reject) => {
        const req = request(url, { headers: ["Host", new URL(url).host, ...headers], timeout: 5_000 }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Request timed out")));
        req.end();
      });
    try {
      writeFileSync(configPath, renderGatewayConfig(token, liveRoutes));
      writeFileSync(upstreamPath, upstreamSource);
      docker("network", "create", name);
      for (const [container, host, id, secret] of [
        [upstream, "qm-upstream", appId, token],
        [secondUpstream, "qm-second", secondAppId, secondAppToken],
      ]) {
        docker(
          "run",
          "-d",
          "--name",
          container!,
          "--network",
          name,
          "--network-alias",
          host!,
          "-e",
          `TEST_SECRET=${secret}`,
          "-e",
          `TEST_APP=${id}`,
          "-v",
          `${upstreamPath}:/upstream.mjs:ro`,
          "node:24-alpine",
          "node",
          "/upstream.mjs",
        );
      }
      docker(
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "-v",
        `${configPath}:/etc/secrets/qm-render-gateway.json:ro`,
        RENDER_GATEWAY_IMAGE,
        "caddy",
        "validate",
        "--config",
        "/etc/secrets/qm-render-gateway.json",
      );
      docker(
        "run",
        "-d",
        "--platform",
        "linux/amd64",
        "--cap-drop=ALL",
        "--name",
        name,
        "--network",
        name,
        "-p",
        "127.0.0.1::8080",
        "-v",
        `${configPath}:/etc/secrets/qm-render-gateway.json:ro`,
        RENDER_GATEWAY_IMAGE,
        "/bin/sh",
        "-c",
        RENDER_GATEWAY_COMMAND.slice(shellPrefix.length),
      );
      assert.equal(docker("exec", name, "getcap", "/tmp/qm-caddy"), "");
      assert.match(docker("exec", name, "cat", "/proc/1/status"), /CapEff:\s+0+\n/);
      const endpoint = `http://${docker("port", name, "8080/tcp")}`;
      const readinessDeadline = Date.now() + 15_000;
      for (;;) {
        try {
          const response = await fetch(`${endpoint}/__qm_gateway_health`, { signal: AbortSignal.timeout(1_000) });
          assert.equal(response.status, 200);
          break;
        } catch (error) {
          if (Date.now() > readinessDeadline) throw error;
          await sleep(100);
        }
      }
      const health = await fetch(`${endpoint}/__qm_gateway_health`);
      assert.equal(await health.text(), "OK\n");
      assert.equal(
        (await fetch(`${endpoint}/__qm_gateway_health`, { headers: { [RENDER_GATEWAY_APP_HEADER]: "" } })).status,
        403,
      );
      const config = await fetch(`${endpoint}/__qm_gateway_config`, {
        headers: { [RENDER_GATEWAY_AUTH_HEADER]: token },
      });
      assert.equal(await config.text(), renderGatewayConfigHash(token, liveRoutes));
      assert.equal((await fetch(`${endpoint}/__qm_gateway_config`)).status, 403);
      for (const secret of [appToken, secondAppToken]) {
        assert.equal(
          (await fetch(`${endpoint}/__qm_gateway_config`, { headers: { [RENDER_GATEWAY_AUTH_HEADER]: secret } }))
            .status,
          403,
        );
      }
      for (const headers of [
        {},
        { [RENDER_GATEWAY_APP_HEADER]: appId },
        { [RENDER_GATEWAY_AUTH_HEADER]: token },
        { ...auth, [RENDER_GATEWAY_AUTH_HEADER]: token },
        { ...secondAuth, [RENDER_GATEWAY_AUTH_HEADER]: token },
        { ...auth, [RENDER_GATEWAY_AUTH_HEADER]: secondAppToken },
        { ...secondAuth, [RENDER_GATEWAY_AUTH_HEADER]: appToken },
        { ...auth, [RENDER_GATEWAY_AUTH_HEADER]: "wrong" },
        { ...auth, [RENDER_GATEWAY_APP_HEADER]: randomUUID() },
        { ...auth, [RENDER_GATEWAY_AUTH_HEADER]: `${appToken},${appToken}` },
        { ...auth, [RENDER_GATEWAY_APP_HEADER]: `${appId},${appId}` },
        { ...auth, [RENDER_GATEWAY_AUTH_HEADER]: "{env.TEST_SECRET}" },
        { ...auth, [RENDER_GATEWAY_APP_HEADER]: "http://qm-upstream:8080" },
      ]) {
        assert.equal((await fetch(`${endpoint}/`, { headers })).status, 403);
      }
      for (const [field, value] of [
        [RENDER_GATEWAY_AUTH_HEADER, appToken],
        [RENDER_GATEWAY_APP_HEADER, appId],
      ]) {
        for (const extra of [value!, "", "wrong"]) {
          assert.equal(
            await rawRequest(`${endpoint}/`, [...Object.entries(auth).flat(), field!.toLowerCase(), extra]),
            403,
          );
        }
      }
      for (const extra of [token, "", "wrong", appToken]) {
        assert.equal(
          await rawRequest(`${endpoint}/__qm_gateway_config`, [
            RENDER_GATEWAY_AUTH_HEADER,
            token,
            RENDER_GATEWAY_AUTH_HEADER.toLowerCase(),
            extra,
          ]),
          403,
        );
      }
      for (const [headers, id] of [
        [auth, appId],
        [secondAuth, secondAppId],
      ] as const) {
        const response = await fetch(`${endpoint}/identity`, { headers });
        assert.equal(response.status, 200);
        const seen = (await response.json()) as { app: string; headers: Record<string, string> };
        assert.equal(seen.app, id);
        assert.equal(seen.headers[RENDER_GATEWAY_AUTH_HEADER.toLowerCase()], undefined);
        assert.equal(seen.headers[RENDER_GATEWAY_APP_HEADER.toLowerCase()], undefined);
      }
      const ordinary = await fetch(`${endpoint}/nested/a%2Fb?x=one&x=two`, {
        method: "POST",
        headers: { ...auth, Authorization: "Bearer app-token", Cookie: "app=request-cookie" },
        body: "app body",
      });
      assert.equal(ordinary.status, 200);
      assert.equal(ordinary.headers.get("set-cookie"), "app=response-cookie");
      const seen = (await ordinary.json()) as {
        url: string;
        method: string;
        body: string;
        headers: Record<string, string>;
      };
      assert.equal(seen.url, "/nested/a%2Fb?x=one&x=two");
      assert.equal(seen.method, "POST");
      assert.equal(seen.body, "app body");
      assert.equal(seen.headers.authorization, "Bearer app-token");
      assert.equal(seen.headers.cookie, "app=request-cookie");
      assert.equal(seen.headers[RENDER_GATEWAY_AUTH_HEADER.toLowerCase()], undefined);
      assert.equal(seen.headers[RENDER_GATEWAY_APP_HEADER.toLowerCase()], undefined);
      const upstreamConnections = new Set<number>();
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`${endpoint}/connection`, { headers: auth });
        upstreamConnections.add(((await response.json()) as { remotePort: number }).remotePort);
      }
      assert.equal(upstreamConnections.size, 3);
      for (const path of ["/__qm_gateway_health", "/__qm_gateway_config"]) {
        const response = await fetch(endpoint + path, { headers: auth });
        assert.equal(((await response.json()) as { url: string }).url, path);
      }
      const streamAbort = new AbortController();
      const events = await fetch(`${endpoint}/events`, {
        headers: auth,
        signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(5_000)]),
      });
      assert.equal(events.headers.get("content-type"), "text/event-stream");
      const reader = events.body!.getReader();
      assert.equal(Buffer.from((await reader.read()).value!).toString(), "data: ready\n\n");
      streamAbort.abort();
      await reader.closed.catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        const req = request(`${endpoint}/socket`, {
          headers: {
            ...auth,
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
            "Sec-WebSocket-Version": "13",
          },
          timeout: 5_000,
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("WebSocket upgrade timed out")));
        req.on("response", (res) => reject(new Error(`WebSocket status ${res.statusCode}`)));
        req.on("upgrade", (res, socket, head) => {
          assert.equal(res.statusCode, 101);
          let received = Buffer.from(head);
          socket.setTimeout(5_000, () => socket.destroy(new Error("WebSocket exchange timed out")));
          socket.on("error", reject);
          socket.on("data", (data) => {
            received = Buffer.concat([received, data]);
            if (received.length < 13) return;
            try {
              assert.deepEqual(
                received,
                Buffer.from([0x81, 5, ...Buffer.from("ready"), 0x81, 4, ...Buffer.from("pong")]),
              );
              socket.destroy();
              resolve();
            } catch (error) {
              socket.destroy();
              reject(error);
            }
          });
          socket.write(Buffer.from([0x81, 0x84, 0, 0, 0, 0, ...Buffer.from("ping")]));
        });
        req.end();
      });
      assert.equal(
        await rawRequest(`${endpoint}/socket`, [
          RENDER_GATEWAY_AUTH_HEADER,
          "wrong",
          RENDER_GATEWAY_APP_HEADER,
          appId,
          "Connection",
          "Upgrade",
          "Upgrade",
          "websocket",
          "Sec-WebSocket-Key",
          randomBytes(16).toString("base64"),
          "Sec-WebSocket-Version",
          "13",
        ]),
        403,
      );
      const badResponse = await fetch(`${endpoint}/bad-response?secret=${token}`, { headers: auth });
      assert.equal(badResponse.status, 502);
      assert.equal(
        (await fetch(`${endpoint}/bad-response?secret=${secondAppToken}`, { headers: secondAuth })).status,
        502,
      );
      const admin = invokeDocker(["exec", name, "wget", "-q", "-O", "-", "http://127.0.0.1:2019/config/"]);
      assert.notEqual(admin.status, 0);
      assert.match(admin.stderr, /Connection refused/);
      docker("stop", "--time", "1", upstream);
      assert.equal((await fetch(`${endpoint}/offline?secret=${appToken}`, { headers: auth })).status, 502);
      docker("stop", "--time", "1", name);
      const logs = docker("logs", name);
      assert.ok(!logs.includes(token), "The gateway secret must not occur in access or error logs");
      assert.ok(!logs.includes(appToken), "The first app secret must not occur in access or error logs");
      assert.ok(!logs.includes(secondAppToken), "The second app secret must not occur in access or error logs");
      assert.ok(!logs.includes("app-token"));
      assert.ok(!logs.includes("request-cookie"));
      const entries = logs
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      assert.ok(entries.some((entry) => entry.logger === "http.log.error" && entry.status === 502));
      assert.ok(
        entries.some((entry) => entry.logger === "http.log.access" && entry.status === 200 && entry.app_id === appId),
      );
      assert.ok(entries.every((entry) => !entry.request && !entry.resp_headers));
    } finally {
      invokeDocker(["rm", "-f", name, upstream, secondUpstream]);
      invokeDocker(["network", "rm", name]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
