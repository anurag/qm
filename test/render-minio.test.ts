import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { renderMinioCommand, renderMinioImage, renderMinioInitCommand } from "../cli/src/render-minio.ts";

test(
  "MinIO initialization recovers partial setup, preserves data, and rotates scoped credentials",
  {
    skip: process.env.QM_TEST_MINIO !== "1",
    timeout: 180_000,
  },
  async () => {
    const name = `qm-minio-test-${randomUUID()}`;
    const volume = `${name}-data`;
    const clients: S3Client[] = [];
    const initializationLogs: string[] = [];
    const rootUser = "qm-test-root";
    const rootPassword = "qm-test-root-password";
    const firstSecret = "qm-test-application-secret";
    const rotatedSecret = "qm-test-rotated-application-secret";
    const invokeDocker = (args: string[], env: NodeJS.ProcessEnv = {}) => {
      const result = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: 45_000,
        env: { ...process.env, ...env },
      });
      assert.ifError(result.error);
      return result;
    };
    const docker = (...args: string[]) => {
      const result = invokeDocker(args);
      assert.equal(result.status, 0, result.stderr);
      return `${result.stdout}${result.stderr}`.trim();
    };
    const initialize = (secret: string, env: NodeJS.ProcessEnv = {}) => {
      const command = renderMinioInitCommand("localhost");
      const prefix = "/bin/sh -c ";
      assert.ok(command.startsWith(prefix));
      const result = invokeDocker(
        [
          "exec",
          "-e",
          "MINIO_ROOT_USER",
          "-e",
          "MINIO_ROOT_PASSWORD",
          "-e",
          "QM_STORAGE_SECRET_KEY",
          name,
          "/bin/sh",
          "-c",
          command.slice(prefix.length),
        ],
        {
          MINIO_ROOT_USER: rootUser,
          MINIO_ROOT_PASSWORD: rootPassword,
          QM_STORAGE_SECRET_KEY: secret,
          ...env,
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      initializationLogs.push(output);
      docker("exec", name, "/bin/sh", "-c", 'for path in /tmp/qm-minio.*; do if [ -e "$path" ]; then exit 1; fi; done');
      return { status: result.status, output };
    };
    const initializeOk = (secret: string) => {
      const result = initialize(secret);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /MinIO storage is ready/);
    };
    const client = (endpoint: string, secret: string, root = false) => {
      const value = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: { accessKeyId: root ? rootUser : "qm-storage", secretAccessKey: secret },
      });
      clients.push(value);
      return value;
    };
    const wait = async (s3: S3Client) => {
      const signal = AbortSignal.timeout(15_000);
      while (!signal.aborted) {
        try {
          await s3.send(new HeadBucketCommand({ Bucket: "qm-storage" }), { abortSignal: signal });
          return;
        } catch {
          await sleep(100);
        }
      }
      assert.fail("MinIO storage did not become ready");
    };
    const readMarker = async (s3: S3Client) =>
      (await s3.send(new GetObjectCommand({ Bucket: "qm-storage", Key: "marker" }))).Body?.transformToString();
    try {
      docker("volume", "create", volume);
      const [entrypoint, ...args] = renderMinioCommand.split(" ");
      const started = invokeDocker(
        [
          "run",
          "-d",
          "--platform",
          "linux/amd64",
          "--name",
          name,
          "-p",
          "127.0.0.1::9000",
          "-v",
          `${volume}:/data`,
          "-e",
          "MINIO_ROOT_USER",
          "-e",
          "MINIO_ROOT_PASSWORD",
          "-e",
          "MINIO_API_CORS_ALLOW_ORIGIN=https://portal.example.test",
          "-e",
          "MINIO_API_STALE_UPLOADS_EXPIRY=24h",
          "-e",
          "MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL=6h",
          "--entrypoint",
          entrypoint!,
          renderMinioImage,
          ...args,
        ],
        { MINIO_ROOT_USER: rootUser, MINIO_ROOT_PASSWORD: rootPassword },
      );
      assert.equal(started.status, 0, started.stderr);
      let endpoint = `http://${docker("port", name, "9000/tcp")}`;
      const root = client(endpoint, rootPassword, true);

      const collision = initialize(firstSecret, { MINIO_ROOT_USER: "qm-storage" });
      assert.equal(collision.status, 1);
      assert.match(collision.output, /MinIO root and QM users must be different/);
      const partial = initialize("short");
      assert.equal(partial.status, 1);
      assert.match(partial.output, /MinIO initialization failed: storage user/);
      await root.send(new HeadBucketCommand({ Bucket: "qm-storage" }));

      initializeOk(firstSecret);
      let app = client(endpoint, firstSecret);
      await wait(app);
      await app.send(new PutObjectCommand({ Bucket: "qm-storage", Key: "marker", Body: "saved-before-restart" }));
      initializeOk(firstSecret);
      assert.equal(await readMarker(app), "saved-before-restart");
      for (const separator of ["\r", "\n"]) {
        for (const [field, value] of [
          ["MINIO_ROOT_USER", rootUser],
          ["MINIO_ROOT_PASSWORD", rootPassword],
          ["QM_STORAGE_SECRET_KEY", rotatedSecret],
        ]) {
          const invalid = initialize(rotatedSecret, { [field!]: `${value}${separator}discarded` });
          assert.equal(invalid.status, 1);
          assert.equal(invalid.output.trim(), `MinIO initialization failed: ${field} must be one line`);
          assert.equal(await readMarker(app), "saved-before-restart");
        }
      }
      await root.send(new CreateBucketCommand({ Bucket: "other-private-bucket" }));
      await assert.rejects(
        app.send(new HeadBucketCommand({ Bucket: "other-private-bucket" })),
        /UnknownError|AccessDenied/,
      );
      assert.equal((await fetch(`${endpoint}/qm-storage/marker`)).status, 403);
      const cors = await fetch(`${endpoint}/qm-storage/marker`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://portal.example.test",
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "x-amz-checksum-sha256",
        },
      });
      assert.equal(cors.headers.get("access-control-allow-origin"), "https://portal.example.test");
      const otherCors = await fetch(`${endpoint}/qm-storage/marker`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://other.example.test",
          "Access-Control-Request-Method": "PUT",
        },
      });
      assert.equal(otherCors.headers.get("access-control-allow-origin"), null);

      docker("stop", "--time", "5", name);
      assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", name), "0");
      docker("start", name);
      endpoint = `http://${docker("port", name, "9000/tcp")}`;
      app = client(endpoint, firstSecret);
      await wait(app);
      assert.equal(await readMarker(app), "saved-before-restart");

      initializeOk(rotatedSecret);
      app = client(endpoint, rotatedSecret);
      await wait(app);
      assert.equal(await readMarker(app), "saved-before-restart");
      await assert.rejects(client(endpoint, firstSecret).send(new HeadBucketCommand({ Bucket: "qm-storage" })));
      await client(endpoint, rootPassword, true).send(new HeadBucketCommand({ Bucket: "other-private-bucket" }));
      const logs = [docker("logs", name), ...initializationLogs].join("\n");
      for (const secret of [rootPassword, firstSecret, rotatedSecret]) assert.ok(!logs.includes(secret));
    } finally {
      for (const value of clients) value.destroy();
      try {
        docker("rm", "-f", name);
      } finally {
        docker("volume", "rm", volume);
      }
    }
  },
);
