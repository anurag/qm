import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { renderMinioCommand, renderMinioInitCommand } from "../cli/src/render-minio.ts";
import { createRenderAppStorage, type StoredRenderAppStorage } from "../src/deploy/render-app-storage.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFakeRenderApi } from "./support/fake-render.ts";

const execute = promisify(execFile);
const minioContext = fileURLToPath(new URL("../deploy/render-minio", import.meta.url));
const skip = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return false;
  } catch {
    return "start a Docker daemon to run the MinIO script tests";
  }
})();

interface ShellResult {
  status: number;
  stdout: string;
  stderr: string;
}

function renderShellCommand(command: string): string {
  assert.ok(command.startsWith("/bin/sh -c "));
  return command.slice("/bin/sh -c ".length);
}

async function docker(...args: string[]): Promise<string> {
  return (await execute("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
}

function run(args: string[]): Promise<ShellResult> {
  return execute("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
    (error: Error & { code?: number; stdout?: string; stderr?: string }) => {
      if (typeof error.code !== "number") throw error;
      return { status: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    },
  );
}

test(
  "MinIO scripts initialize, re-run, enable, disable, and scope app access on the pinned image",
  { skip, timeout: 900_000 },
  async (t) => {
    const image = (await docker("build", "--quiet", "--file", `${minioContext}/Dockerfile`, minioContext)).trim();
    const container = `qm-minio-${randomUUID()}`;
    const storageSecret = randomUUID();
    await docker(
      "run",
      "--detach",
      "--name",
      container,
      "--publish",
      "127.0.0.1::9000",
      "--mount",
      "type=tmpfs,destination=/data,tmpfs-mode=1777",
      "--env",
      "MINIO_ROOT_USER=test-root",
      "--env",
      `MINIO_ROOT_PASSWORD=${randomUUID()}`,
      "--env",
      `QM_STORAGE_SECRET_KEY=${storageSecret}`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      renderMinioCommand,
    );
    t.after(() => docker("rm", "--force", container));
    const exec = (command: string) => run(["exec", container, "/bin/sh", "-c", command]);
    const endpoint = `http://${(await docker("port", container, "9000/tcp")).split("\n")[0]!.trim()}`;
    const deadline = Date.now() + 120_000;
    while (
      !(await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1_000) }).then(
        (response) => response.ok,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < deadline, "MinIO did not become healthy");
      await delay(250);
    }

    const init = renderShellCommand(renderMinioInitCommand("localhost"));
    for (const attempt of [1, 2]) {
      const result = await exec(init);
      assert.equal(result.status, 0, `initialization attempt ${attempt}: ${result.stderr}`);
      assert.equal(result.stdout, "MinIO storage is ready\n");
    }

    const jobs = new Map<string, Promise<ShellResult>>();
    const commands: string[] = [];
    const api = createFakeRenderApi(({ method, path, body }) => {
      if (path === "/services/srv-minio" && method === "GET")
        return { ownerId: "tea-test", environmentId: "env-test", type: "web_service" };
      if (path === "/services/srv-minio/jobs" && method === "POST") {
        const command = (body as { startCommand: string }).startCommand;
        commands.push(command);
        const id = `job-${jobs.size + 1}`;
        jobs.set(id, exec(renderShellCommand(command)));
        return { id, status: "pending" };
      }
      const job = /^\/services\/srv-minio\/jobs\/(job-\d+)$/.exec(path);
      if (job && method === "GET")
        return jobs
          .get(job[1]!)!
          .then((result) => ({ id: job[1], status: result.status === 0 ? "succeeded" : "failed" }));
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const storage = createRenderAppStorage({
      apiKey: "key",
      workspaceId: "tea-test",
      environmentId: "env-test",
      minioServiceId: "srv-minio",
      endpoint: "http://localhost:9000",
      bucket: "qm-storage",
      store: createMemoryMap<StoredRenderAppStorage>(),
      keyMaterial: "test-key",
      api,
      pollIntervalMs: 50,
    });
    const deploymentId = randomUUID();
    const credentials = await storage.ensure(deploymentId);
    const accessKey = credentials.AWS_ACCESS_KEY_ID!;
    const user = async () => {
      const result = await exec(
        `mc --config-dir /tmp/qm-test-mc --no-color alias set qm http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc --config-dir /tmp/qm-test-mc --no-color admin user info qm ${accessKey} --json`,
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as { userStatus: string; policyName?: string };
    };
    const rerunLatestJob = async () => {
      const result = await exec(renderShellCommand(commands.at(-1)!));
      assert.equal(result.status, 0, result.stderr);
    };
    const put = (key: string) =>
      new S3Client({
        endpoint,
        region: credentials.AWS_REGION,
        forcePathStyle: true,
        maxAttempts: 1,
        requestChecksumCalculation: "WHEN_REQUIRED",
        credentials: { accessKeyId: accessKey, secretAccessKey: credentials.AWS_SECRET_ACCESS_KEY! },
      }).send(new PutObjectCommand({ Bucket: credentials.S3_BUCKET, Key: key, Body: "content" }));
    const forbidden = (error: unknown) =>
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 403;

    let info = await user();
    assert.equal(info.userStatus, "enabled");
    assert.ok(info.policyName?.split(",").includes(`qm-app-${accessKey}`), info.policyName);
    await put(`${credentials.S3_PREFIX}file.txt`);
    await assert.rejects(put("app-data/other/file.txt"), forbidden);
    await rerunLatestJob();
    assert.equal((await user()).userStatus, "enabled");

    await storage.suspend(deploymentId);
    assert.equal((await user()).userStatus, "disabled");
    await assert.rejects(put(`${credentials.S3_PREFIX}file.txt`), forbidden);
    await rerunLatestJob();
    assert.equal((await user()).userStatus, "disabled");

    assert.deepEqual(await storage.ensure(deploymentId), credentials);
    info = await user();
    assert.equal(info.userStatus, "enabled");
    assert.ok(info.policyName?.split(",").includes(`qm-app-${accessKey}`), info.policyName);
    await put(`${credentials.S3_PREFIX}file.txt`);
    assert.equal(commands.length, 3);
  },
);
