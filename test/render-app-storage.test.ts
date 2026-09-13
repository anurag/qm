import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import {
  createRenderAppStorage,
  renderAppStoragePolicy,
  type StoredRenderAppStorage,
} from "../src/deploy/render-app-storage.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { RenderApiError, type RenderApi } from "../src/deploy/render-api.ts";

test("Render storage policies constrain listing and writes to one app prefix", () => {
  const prefix = `app-data/${randomUUID()}/`;
  const policy = renderAppStoragePolicy("qm-storage", prefix);
  assert.deepEqual(policy.Statement[1]!.Condition, { StringLike: { "s3:prefix": [`${prefix}*`] } });
  assert.deepEqual(policy.Statement[2]!.Resource, [`arn:aws:s3:::qm-storage/${prefix}*`]);
  for (const unsafe of ["../", "*", "app-data/*/", "app-data/?/", ""])
    assert.throws(() => renderAppStoragePolicy("qm-storage", unsafe));
});

test("Render app storage keeps credentials through archive and restore and only changes its MinIO service", async () => {
  const store = createMemoryMap<StoredRenderAppStorage>();
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api: RenderApi = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (path === "/services/srv-minio" && method === "GET")
        return { ownerId: "tea-test", environmentId: "env-test", type: "web_service" } as T;
      if (path === "/services/srv-minio/jobs" && method === "POST")
        return { id: `job-${calls.length}`, status: "pending" } as T;
      if (path.startsWith("/services/srv-minio/jobs/job-") && method === "GET") return { status: "succeeded" } as T;
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  const opts = {
    apiKey: "key",
    workspaceId: "tea-test",
    environmentId: "env-test",
    minioServiceId: "srv-minio",
    endpoint: "http://qm-minio:9000",
    bucket: "qm-storage",
    store,
    keyMaterial: "encryption-key",
    api,
  };
  const storage = createRenderAppStorage(opts);
  const id = randomUUID();
  const first = await storage.ensure(id);
  assert.equal(first.S3_PREFIX, `app-data/${id}/`);
  assert.equal(first.AWS_REQUEST_CHECKSUM_CALCULATION, "WHEN_REQUIRED");
  assert.equal(JSON.stringify(await store.get(id)).includes(first.AWS_SECRET_ACCESS_KEY!), false);
  assert.deepEqual(await createRenderAppStorage(opts).ensure(id), first);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  await storage.suspend(id);
  assert.equal((await store.get(id))!.enabled, false);
  assert.deepEqual(await createRenderAppStorage(opts).ensure(id), first);
  assert.equal(calls.filter((call) => call.method === "POST").length, 3);
  assert.ok(calls.every((call) => call.path.startsWith("/services/srv-minio")));
  const another = await storage.ensure(randomUUID());
  assert.notEqual(another.AWS_ACCESS_KEY_ID, first.AWS_ACCESS_KEY_ID);
  assert.notEqual(another.S3_PREFIX, first.S3_PREFIX);
});

test("Render app storage settings send S3 stream bytes without checksum trailers", async () => {
  const storage = createRenderAppStorage({
    apiKey: "key",
    workspaceId: "tea-test",
    environmentId: "env-test",
    minioServiceId: "srv-minio",
    endpoint: "https://minio.example.test",
    bucket: "qm-storage",
    store: createMemoryMap<StoredRenderAppStorage>(),
    keyMaterial: "test-key",
    api: {
      async request<T>(method: string, path: string): Promise<T> {
        if (path === "/services/srv-minio")
          return { ownerId: "tea-test", environmentId: "env-test", type: "web_service" } as T;
        return (method === "POST" ? { id: "job-test" } : { status: "succeeded" }) as T;
      },
    },
  });
  const env = await storage.ensure(randomUUID());
  const directory = await mkdtemp(join(tmpdir(), "qm-render-s3-"));
  const file = join(directory, "part");
  const input = Buffer.from("Render streamed object bytes\n".repeat(1024));
  const previous = process.env.AWS_REQUEST_CHECKSUM_CALCULATION;
  try {
    await writeFile(file, input);
    const requests: Array<{ headers: Record<string, string>; bytes: Buffer }> = [];
    for (const checksum of ["WHEN_SUPPORTED", env.AWS_REQUEST_CHECKSUM_CALCULATION!]) {
      process.env.AWS_REQUEST_CHECKSUM_CALCULATION = checksum;
      const client = new S3Client({
        endpoint: env.AWS_ENDPOINT_URL_S3,
        region: env.AWS_REGION,
        forcePathStyle: true,
        credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
        maxAttempts: 1,
        requestHandler: {
          async handle(request: { headers: Record<string, string>; body: AsyncIterable<Uint8Array> }) {
            const chunks: Buffer[] = [];
            for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
            requests.push({ headers: request.headers, bytes: Buffer.concat(chunks) });
            return { response: { statusCode: 200, headers: { etag: '"part"' }, body: Readable.from([]) } };
          },
        },
      });
      const body = createReadStream(file);
      try {
        await client.send(
          new UploadPartCommand({
            Bucket: env.S3_BUCKET,
            Key: env.S3_PREFIX + "part",
            UploadId: "test-upload",
            PartNumber: 1,
            Body: body,
            ContentLength: input.length,
          }),
        );
      } finally {
        body.destroy();
        client.destroy();
      }
    }
    const [defaultRequest, renderRequest] = requests;
    assert.equal(defaultRequest!.headers["content-encoding"], "aws-chunked");
    assert.equal(defaultRequest!.headers["x-amz-trailer"], "x-amz-checksum-crc32");
    assert.notDeepEqual(defaultRequest!.bytes, input);
    assert.equal(renderRequest!.headers["content-length"], String(input.length));
    assert.equal(renderRequest!.headers["content-encoding"], undefined);
    assert.equal(renderRequest!.headers["transfer-encoding"], undefined);
    assert.equal(renderRequest!.headers["x-amz-trailer"], undefined);
    assert.deepEqual(renderRequest!.bytes, input);
  } finally {
    if (previous === undefined) delete process.env.AWS_REQUEST_CHECKSUM_CALCULATION;
    else process.env.AWS_REQUEST_CHECKSUM_CALCULATION = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Failed Render storage transitions retain intent so cleanup and retry repair the actual account", async () => {
  const store = createMemoryMap<StoredRenderAppStorage>();
  let outcome = "succeeded";
  let jobs = 0;
  const api: RenderApi = {
    async request<T>(method: string, path: string): Promise<T> {
      if (path === "/services/srv-minio")
        return { ownerId: "tea-test", environmentId: "env-test", type: "web_service" } as T;
      if (method === "POST") return { id: `job-${++jobs}` } as T;
      return { status: outcome } as T;
    },
  };
  const storage = createRenderAppStorage({
    apiKey: "key",
    workspaceId: "tea-test",
    environmentId: "env-test",
    minioServiceId: "srv-minio",
    endpoint: "http://localhost:9000",
    bucket: "qm-storage",
    store,
    keyMaterial: "test-key",
    api,
  });
  const id = randomUUID();
  await storage.ensure(id);
  await storage.suspend(id);
  outcome = "failed";
  await assert.rejects(storage.ensure(id), /job.*failed/);
  assert.equal((await store.get(id))!.enabled, false);
  assert.equal((await store.get(id))!.operation, "enable");
  assert.equal((await store.get(id))!.jobId, undefined);
  outcome = "succeeded";
  await storage.suspend(id);
  assert.equal(jobs, 4);
  assert.equal((await store.get(id))!.operation, undefined);
  await storage.ensure(id);
  outcome = "failed";
  await assert.rejects(storage.suspend(id), /job.*failed/);
  assert.equal((await store.get(id))!.enabled, true);
  assert.equal((await store.get(id))!.operation, "disable");
  outcome = "succeeded";
  await storage.ensure(id);
  assert.equal(jobs, 7);
  assert.equal((await store.get(id))!.operation, undefined);
});

test("Uncertain Render storage submissions reconcile across restarts before the opposite operation", async () => {
  const store = createMemoryMap<StoredRenderAppStorage>();
  const jobs: Array<{ id: string; serviceId: string; startCommand: string; status: string }> = [];
  let visible = false;
  let enabled = false;
  let pages = 0;
  const api: RenderApi = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (path === "/services/srv-minio")
        return { ownerId: "tea-test", environmentId: "env-test", type: "web_service" } as T;
      if (method === "POST") {
        const job = {
          id: `job-${jobs.length + 1}`,
          serviceId: "srv-minio",
          startCommand: (body as { startCommand: string }).startCommand,
          status: jobs.length ? "succeeded" : "pending",
        };
        jobs.push(job);
        if (jobs.length === 1) throw new Error("The accepted job response was lost");
        const script = Buffer.from(job.startCommand.split(" ")[4]!, "base64").toString();
        enabled = !script.includes("admin user disable");
        return job as T;
      }
      if (path.startsWith("/services/srv-minio/jobs?")) {
        if (!visible) return [] as T;
        pages++;
        const query = new URL(`https://render.test${path}`).searchParams;
        if (!query.has("cursor"))
          return Array.from({ length: 100 }, (_, i) => ({
            job: { id: `unrelated-${i}`, serviceId: "srv-minio", startCommand: "unrelated" },
            cursor: `cursor-${i}`,
          })) as T;
        assert.equal(query.get("cursor"), "cursor-99");
        return [{ job: jobs[0], cursor: "last" }] as T;
      }
      const job = jobs.find((item) => path.endsWith(`/${item.id}`));
      if (job) return job as T;
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  const opts = {
    apiKey: "key",
    workspaceId: "tea-test",
    environmentId: "env-test",
    minioServiceId: "srv-minio",
    endpoint: "http://localhost:9000",
    bucket: "qm-storage",
    store,
    keyMaterial: "test-key",
    api,
    pollIntervalMs: 1,
    timeoutMs: 50,
  };
  const id = randomUUID();
  await assert.rejects(createRenderAppStorage(opts).ensure(id), /accepted job response was lost/);
  const submission = (await store.get(id))!.jobRequest;
  assert.match(submission!.commandHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(await store.get(id)).includes(jobs[0]!.startCommand), false);
  await assert.rejects(createRenderAppStorage(opts).suspend(id), /submission is still unconfirmed/);
  assert.equal(jobs.length, 1);
  assert.deepEqual((await store.get(id))!.jobRequest, submission);
  visible = true;
  await assert.rejects(createRenderAppStorage(opts).suspend(id), /job-1 is still pending/);
  assert.equal(pages, 2);
  assert.equal(jobs.length, 1);
  assert.equal(enabled, false);
  assert.equal((await store.get(id))!.jobId, "job-1");
  jobs[0]!.status = "succeeded";
  enabled = true;
  await createRenderAppStorage(opts).suspend(id);
  assert.equal(jobs.length, 2);
  assert.equal(enabled, false);
  assert.equal((await store.get(id))!.enabled, false);
  assert.equal((await store.get(id))!.operation, undefined);
  assert.equal((await store.get(id))!.jobRequest, undefined);
  await createRenderAppStorage(opts).ensure(id);
  assert.equal(jobs.length, 3);
  assert.equal(enabled, true);
  assert.notEqual(jobs[0]!.startCommand, jobs[2]!.startCommand);
});

test("Rejected Render storage submissions retain repair intent and allow a new job", async () => {
  const store = createMemoryMap<StoredRenderAppStorage>();
  let rejected = true;
  let jobs = 0;
  const api: RenderApi = {
    async request<T>(method: string, path: string): Promise<T> {
      if (path === "/services/srv-minio")
        return { ownerId: "tea-test", environmentId: "env-test", type: "web_service" } as T;
      if (method === "POST") {
        if (rejected) throw new RenderApiError(method, path, 429);
        return { id: `job-${++jobs}` } as T;
      }
      return { status: "succeeded" } as T;
    },
  };
  const storage = createRenderAppStorage({
    apiKey: "key",
    workspaceId: "tea-test",
    environmentId: "env-test",
    minioServiceId: "srv-minio",
    endpoint: "http://localhost:9000",
    bucket: "qm-storage",
    store,
    keyMaterial: "test-key",
    api,
  });
  const id = randomUUID();
  await assert.rejects(storage.ensure(id), /HTTP 429/);
  assert.equal((await store.get(id))!.operation, "enable");
  assert.equal((await store.get(id))!.jobRequest, undefined);
  rejected = false;
  await storage.ensure(id);
  assert.equal(jobs, 1);
  assert.equal((await store.get(id))!.enabled, true);
});
