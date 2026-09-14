import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { cp, lchown, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

function git(args, cwd, env) {
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("error", () => rejectGit(new Error("Could not start Git for the app source")));
    child.on("exit", (code) =>
      code === 0
        ? resolveGit(Buffer.concat(stdout).toString("utf8"))
        : rejectGit(new Error(`App source Git command failed (${code})`)),
    );
  });
}

export async function prepareRenderApp(manifestPath, appDir, env = process.env) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const url = new URL(manifest.url);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    typeof manifest.token !== "string" ||
    !manifest.token ||
    /[\r\n\0]/.test(manifest.token) ||
    typeof manifest.commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.commit) ||
    typeof manifest.entrypoint !== "string" ||
    !manifest.entrypoint.trim() ||
    manifest.entrypoint.includes("\0")
  )
    throw new Error("Invalid Render app source manifest");
  const staging = await mkdtemp(join(tmpdir(), "qm-render-source-"));
  const gitEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${manifest.token}`,
    GIT_CONFIG_KEY_1: "http.followRedirects",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
  };
  try {
    await git(["init", "--quiet"], staging, gitEnv);
    await git(["fetch", "--quiet", "--no-tags", "--depth=1", url.toString(), manifest.commit], staging, gitEnv);
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], staging, gitEnv);
    if ((await git(["rev-parse", "HEAD"], staging, gitEnv)).trim() !== manifest.commit)
      throw new Error("Render app source does not match the selected commit");
    await rm(join(staging, ".git"), { recursive: true });
    await mkdir(appDir, { recursive: true });
    for (const entry of await readdir(appDir)) await rm(join(appDir, entry), { recursive: true, force: true });
    await cp(staging, appDir, { recursive: true, verbatimSymlinks: true });
    return manifest.entrypoint;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runRenderApp({
  manifestPath = "/etc/secrets/qm-render-artifact.json",
  appDir = "/app",
  env = process.env,
  gatewayPort = 8080,
  appPort = 8081,
} = {}) {
  const gatewayToken = env.QM_RENDER_APP_TOKEN;
  if (typeof gatewayToken !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(gatewayToken))
    throw new Error("Render app requires a private gateway token");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.readinessNonce !== undefined &&
    (typeof manifest.readinessNonce !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(manifest.readinessNonce))
  )
    throw new Error("Invalid Render app readiness nonce");
  const entrypoint = await prepareRenderApp(manifestPath, appDir, env);
  const appEnv = { ...env, ...manifest.runtimeEnv, PORT: String(appPort) };
  delete appEnv.QM_RENDER_APP_TOKEN;
  const privileged = process.getuid?.() === 0;
  if (privileged) {
    appEnv.HOME = "/home/node";
    appEnv.USER = "node";
    appEnv.LOGNAME = "node";
    const own = async (dir) => {
      await lchown(dir, 1000, 1000);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await own(path);
        else await lchown(path, 1000, 1000);
      }
    };
    await own(appDir);
  }
  for (const key of Object.keys(appEnv))
    if (key.startsWith("GIT_CONFIG_") || key === "GIT_ASKPASS" || key === "SSH_ASKPASS") delete appEnv[key];
  let appReady = false;
  let started = false;
  let stopping = false;
  const checkReady = async () => {
    if (stopping) return false;
    const reachable = await fetch(`http://127.0.0.1:${appPort}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    }).then(
      async (response) => {
        await response.body?.cancel();
        return response.status < 500;
      },
      () => false,
    );
    appReady = reachable && !stopping;
    return appReady;
  };
  const server = createRenderAppGateway({
    token: gatewayToken,
    readinessNonce: manifest.readinessNonce,
    appPort,
    isReady: () => appReady,
    checkReady: () => started && checkReady(),
    onUnavailable: () => {
      appReady = false;
    },
  });
  const sockets = new Set();
  let connectionsClosed;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (!sockets.size) connectionsClosed?.();
    });
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(gatewayPort, "0.0.0.0", ready);
  });
  const child = spawn("bash", ["-c", entrypoint], {
    cwd: appDir,
    env: appEnv,
    stdio: "inherit",
    detached: true,
    ...(privileged ? { uid: 1000, gid: 1000 } : {}),
  });
  let spawnError;
  const completion = new Promise((resolveExit) => {
    child.on("error", (error) => {
      spawnError = error;
      resolveExit(1);
    });
    child.on("exit", (code, signal) => resolveExit(code ?? (signal === "SIGTERM" ? 143 : 1)));
  });
  const forward = (signal) => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return false;
    }
  };
  let shutdown;
  let shutdownTimer;
  const stop = (signal) => {
    if (shutdown) return shutdown;
    stopping = true;
    appReady = false;
    forward(signal);
    const deadline = Date.now() + 30_000;
    shutdownTimer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      forward("SIGKILL");
    }, 30_000);
    shutdown = Promise.all([
      new Promise((done) => {
        server.close(() => {
          if (!sockets.size) done();
          else connectionsClosed = done;
        });
      }),
      (async () => {
        while (Date.now() < deadline && forward(0)) await new Promise((done) => setTimeout(done, 50));
      })(),
    ]);
    return shutdown;
  };
  const term = () => {
    void stop("SIGTERM");
  };
  const interrupt = () => {
    void stop("SIGINT");
  };
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  try {
    const deadline = Date.now() + 90_000;
    while (true) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Render app exited before it was ready");
      if (await checkReady()) break;
      if (Date.now() >= deadline) throw new Error("Render app did not become ready");
      await new Promise((done) => setTimeout(done, 200));
    }
    started = true;
    return await completion;
  } finally {
    await stop("SIGTERM");
    forward("SIGKILL");
    clearTimeout(shutdownTimer);
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
  }
}

export function createRenderAppGateway({
  token,
  readinessNonce,
  appPort = 8081,
  isReady = () => true,
  checkReady = isReady,
  onUnavailable = () => {},
}) {
  const authorized = (req) => {
    const value = req.headers["x-qm-render-app-token"];
    return (
      typeof value === "string" &&
      Buffer.byteLength(value) === Buffer.byteLength(token) &&
      timingSafeEqual(Buffer.from(value), Buffer.from(token))
    );
  };
  const options = (req) => {
    const headers = { ...req.headers };
    delete headers["x-qm-render-app-token"];
    return { hostname: "127.0.0.1", port: appPort, method: req.method, path: req.url, headers };
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/__qm_ready") {
      const ready = await checkReady();
      const headers = { "cache-control": "no-store" };
      if (ready && authorized(req) && readinessNonce) headers["x-qm-render-app-ready"] = readinessNonce;
      res.writeHead(ready ? 204 : 503, headers).end();
      return;
    }
    if (!authorized(req)) {
      res.writeHead(403).end();
      return;
    }
    if (!isReady()) {
      res.writeHead(503).end();
      return;
    }
    const upstream = request(options(req), (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => {
      if (req.aborted || res.destroyed) return;
      onUnavailable();
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (!authorized(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!isReady()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    let upgraded = false;
    let clientClosed = false;
    const upstream = request(options(req));
    upstream.on("error", () => {
      if (clientClosed || socket.destroyed) return;
      onUnavailable();
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstream.on("response", (res) => {
      const response = new ServerResponse(req);
      response.assignSocket(socket);
      response.on("finish", () => socket.end());
      response.on("error", () => socket.destroy());
      res.on("aborted", () => socket.destroy());
      response.writeHead(res.statusCode ?? 502, { ...res.headers, connection: "close" });
      res.pipe(response);
    });
    upstream.on("upgrade", (res, connection, upstreamHead) => {
      upgraded = true;
      socket.write(
        `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${Object.entries(res.headers)
          .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((part) => `${key}: ${part}\r\n`))
          .join("")}\r\n`,
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) connection.write(head);
      socket.on("error", () => connection.destroy());
      socket.on("close", () => connection.end());
      connection.on("error", () => socket.destroy());
      connection.on("close", () => socket.end());
      socket.pipe(connection).pipe(socket);
    });
    socket.on("end", () => {
      clientClosed = true;
      if (!upgraded) {
        upstream.destroy();
        socket.end();
      }
    });
    socket.on("close", () => {
      clientClosed = true;
      upstream.destroy();
    });
    upstream.end();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runRenderApp();
  } catch {
    console.error("Render app startup failed; check its source, credential, and entrypoint");
    process.exitCode = 1;
  }
}
