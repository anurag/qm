import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const launcher = new URL("../deploy/render/start.mjs", import.meta.url);
const { waitForMinio } = await import(launcher.href);

test("Render preserves configured URLs and delivers signals to the service", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "qm-render-start-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(
      join(cwd, "src", "index.ts"),
      'import {pathToFileURL} from "node:url";\nif (import.meta.url !== pathToFileURL(process.argv[1]).href) throw new Error("entry guard did not match");\nprocess.on("SIGTERM", () => process.exit(0));\nconsole.log(JSON.stringify({url: process.env.PUBLIC_WEB_URL, web: process.env.WEB_UI_PUBLIC_URL}));\nsetInterval(() => {}, 1000);\n',
    );
    const child = spawn(process.execPath, [fileURLToPath(launcher), "core"], {
      cwd,
      env: {
        ...process.env,
        PUBLIC_WEB_URL: "https://portal.example.com",
        WEB_UI_PUBLIC_URL: "https://portal.example.com",
        RENDER_QM_MINIO: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = once(child, "exit");
    try {
      const [data] = await once(child.stdout, "data");
      assert.deepEqual(JSON.parse(String(data)), {
        url: "https://portal.example.com",
        web: "https://portal.example.com",
      });
      child.kill("SIGTERM");
      assert.deepEqual(await exit, [0, null]);
    } finally {
      child.kill("SIGKILL");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const accepted of [true, false]) {
  test(`MinIO readiness ${accepted ? "retries and uses the configured credentials" : "has a bounded deadline"}`, async () => {
    const saved = { ...process.env };
    let requests = 0;
    const server = createServer((req, res) => {
      assert.match(req.headers.authorization ?? "", /Credential=qm-storage\//);
      assert.equal(req.url, "/qm-storage/");
      requests += 1;
      res.writeHead(accepted && requests > 1 ? 200 : 403);
      res.end();
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address === "object");
      Object.assign(process.env, {
        AWS_ACCESS_KEY_ID: "qm-storage",
        AWS_SECRET_ACCESS_KEY: "test-secret-without-cloud-access",
        AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${address.port}`,
        S3_BUCKET: "qm-storage",
        S3_FORCE_PATH_STYLE: "true",
        S3_REGION: "us-east-1",
      });
      delete process.env.AWS_SESSION_TOKEN;
      if (accepted) {
        await waitForMinio({ timeoutMs: 1_000, intervalMs: 5 });
        assert.equal(requests, 2);
      } else {
        await assert.rejects(waitForMinio({ timeoutMs: 250, intervalMs: 5 }), /startup deadline/);
        assert.ok(requests > 0);
      }
    } finally {
      process.env = saved;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
