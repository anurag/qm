import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";
import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import {
  createRenderAppStorage,
  renderAppStoragePolicy,
  type StoredRenderAppStorage,
} from "../src/deploy/render-app-storage.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { RenderApiError } from "../src/deploy/render-api.ts";
import { createFakeRenderApi, type FakeRenderApiCall } from "./support/fake-render.ts";

type StorageOptions = Parameters<typeof createRenderAppStorage>[0];

function fixture(handle: (call: FakeRenderApiCall) => unknown, extra: Partial<StorageOptions> = {}) {
  const store = createMemoryMap<StoredRenderAppStorage>();
  const api = createFakeRenderApi((call) => {
    if (call.path === "/services/srv-minio" && call.method === "GET")
      return { ownerId: "tea-test", environmentId: "env-test", type: "web_service" };
    return handle(call);
  });
  const opts: StorageOptions = {
    apiKey: "key",
    workspaceId: "tea-test",
    environmentId: "env-test",
    minioServiceId: "srv-minio",
    endpoint: "http://localhost:9000",
    bucket: "qm-storage",
    store,
    keyMaterial: "test-key",
    api,
    ...extra,
  };
  return { store, api, opts, storage: createRenderAppStorage(opts), restart: () => createRenderAppStorage(opts) };
}

const scriptOperation = (body: unknown): "enable" | "disable" =>
  Buffer.from((body as { startCommand: string }).startCommand.split(" ")[4]!, "base64")
    .toString()
    .includes("admin user disable")
    ? "disable"
    : "enable";

test("Render storage retries revocation after command failures and accepts only confirmed missing users", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qm-render-revoke-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "timeout"),
    `#!/bin/sh
case "$*" in
  *"admin user disable"*) [ "$MC_OUTCOME" = disabled ] ;;
  *"admin user info"*)
    case "$MC_OUTCOME" in
      timeout) exit 124 ;;
      server) printf '%s' '{"status":"error","error":{"cause":{"error":{"Code":"InternalError"}}}}'; exit 1 ;;
      auth) printf '%s' '{"status":"error","error":{"cause":{"error":{"Code":"AccessDenied"}}}}'; exit 1 ;;
      missing) printf '%s' '{"status":"error","error":{"cause":{"error":{"Code":"XMinioAdminNoSuchUser"}}}}'; exit 1 ;;
      exists) printf '%s' '{"status":"success","userStatus":"enabled"}' ;;
      malformed) printf '%s' 'no user response'; exit 1 ;;
    esac ;;
  *) cat >/dev/null ;;
esac
`,
    { mode: 0o700 },
  );
  let outcome = "disabled";
  let status = "succeeded";
  let jobs = 0;
  const f = fixture(async ({ method, body }) => {
    if (method !== "POST") return { status };
    if (scriptOperation(body) === "disable") {
      const script = Buffer.from((body as { startCommand: string }).startCommand.split(" ")[4]!, "base64").toString();
      status = await promisify(execFile)("/bin/sh", ["-c", script], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          MINIO_ROOT_USER: "test-root",
          MINIO_ROOT_PASSWORD: "test-password",
          MC_OUTCOME: outcome,
        },
      }).then(
        () => "succeeded",
        () => "failed",
      );
    } else status = "succeeded";
    return { id: `job-${++jobs}` };
  });
  const id = randomUUID();
  const credentials = await f.storage.ensure(id);
  for (outcome of ["timeout", "server", "auth", "exists", "malformed"]) {
    await assert.rejects(f.restart().suspend(id), /job.*failed/, outcome);
    assert.equal((await f.store.get(id))!.enabled, true, outcome);
    assert.equal((await f.store.get(id))!.operation, "disable", outcome);
  }
  outcome = "disabled";
  await f.restart().suspend(id);
  assert.equal((await f.store.get(id))!.enabled, false);
  assert.equal((await f.store.get(id))!.operation, undefined);
  assert.deepEqual(await f.restart().ensure(id), credentials);
  outcome = "missing";
  await f.restart().suspend(id);
  assert.equal((await f.store.get(id))!.enabled, false);
  assert.equal((await f.store.get(id))!.operation, undefined);
});

test("Render storage policies constrain listing and writes to one app prefix", () => {
  const prefix = `app-data/${randomUUID()}/`;
  const policy = renderAppStoragePolicy("qm-storage", prefix);
  const statement = (action: string) => policy.Statement.find((item) => item.Action.includes(action))!;
  assert.deepEqual(statement("s3:ListBucket").Condition, { StringLike: { "s3:prefix": [`${prefix}*`] } });
  assert.deepEqual(statement("s3:PutObject").Resource, [`arn:aws:s3:::qm-storage/${prefix}*`]);
  for (const unsafe of ["../", "*", "app-data/*/", "app-data/?/", ""])
    assert.throws(() => renderAppStoragePolicy("qm-storage", unsafe));
});

test("Render app storage keeps credentials through archive and restore and only changes its MinIO service", async () => {
  let jobs = 0;
  const f = fixture(
    ({ method, path }) => {
      if (path === "/services/srv-minio/jobs" && method === "POST") return { id: `job-${++jobs}`, status: "pending" };
      if (path.startsWith("/services/srv-minio/jobs/job-") && method === "GET") return { status: "succeeded" };
      throw new Error(`Unexpected ${method} ${path}`);
    },
    { endpoint: "http://qm-minio:9000", keyMaterial: "encryption-key" },
  );
  const id = randomUUID();
  const first = await f.storage.ensure(id);
  assert.equal(first.S3_PREFIX, `app-data/${id}/`);
  assert.equal(first.AWS_REQUEST_CHECKSUM_CALCULATION, "WHEN_REQUIRED");
  assert.equal(JSON.stringify(await f.store.get(id)).includes(first.AWS_SECRET_ACCESS_KEY!), false);
  assert.deepEqual(await f.restart().ensure(id), first);
  assert.equal(jobs, 1);
  await f.storage.suspend(id);
  assert.equal((await f.store.get(id))!.enabled, false);
  assert.deepEqual(await f.restart().ensure(id), first);
  assert.equal(jobs, 3);
  assert.ok(f.api.calls.every((call) => call.path.startsWith("/services/srv-minio")));
  const another = await f.storage.ensure(randomUUID());
  assert.notEqual(another.AWS_ACCESS_KEY_ID, first.AWS_ACCESS_KEY_ID);
  assert.notEqual(another.S3_PREFIX, first.S3_PREFIX);
});

test("Render app storage settings send S3 stream bytes without checksum trailers", async () => {
  const f = fixture(({ method }) => (method === "POST" ? { id: "job-test" } : { status: "succeeded" }), {
    endpoint: "https://minio.example.test",
  });
  const env = await f.storage.ensure(randomUUID());
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
  let outcome = "succeeded";
  let jobs = 0;
  const f = fixture(({ method }) => (method === "POST" ? { id: `job-${++jobs}` } : { status: outcome }));
  const id = randomUUID();
  await f.storage.ensure(id);
  await f.storage.suspend(id);
  outcome = "failed";
  await assert.rejects(f.storage.ensure(id), /job.*failed/);
  assert.equal((await f.store.get(id))!.enabled, false);
  assert.equal((await f.store.get(id))!.operation, "enable");
  assert.equal((await f.store.get(id))!.jobId, undefined);
  outcome = "succeeded";
  await f.storage.suspend(id);
  assert.equal(jobs, 4);
  assert.equal((await f.store.get(id))!.operation, undefined);
  await f.storage.ensure(id);
  outcome = "failed";
  await assert.rejects(f.storage.suspend(id), /job.*failed/);
  assert.equal((await f.store.get(id))!.enabled, true);
  assert.equal((await f.store.get(id))!.operation, "disable");
  outcome = "succeeded";
  await f.storage.ensure(id);
  assert.equal(jobs, 7);
  assert.equal((await f.store.get(id))!.operation, undefined);
});

test("Uncertain Render storage submissions reconcile across restarts before the opposite operation", async () => {
  const jobs: Array<{ id: string; serviceId: string; startCommand: string; status: string }> = [];
  let enabled = false;
  let pages = 0;
  const f = fixture(
    ({ method, path, query, body }) => {
      if (method === "POST") {
        const job = {
          id: `job-${jobs.length + 1}`,
          serviceId: "srv-minio",
          startCommand: (body as { startCommand: string }).startCommand,
          status: jobs.length ? "succeeded" : "pending",
        };
        jobs.push(job);
        if (jobs.length === 1) throw new Error("The accepted job response was lost");
        enabled = scriptOperation(body) === "enable";
        return job;
      }
      if (path === "/services/srv-minio/jobs" && method === "GET") {
        pages++;
        if (!query.has("cursor"))
          return Array.from({ length: 100 }, (_, i) => ({
            job: { id: `unrelated-${i}`, serviceId: "srv-minio", startCommand: "unrelated" },
            cursor: `cursor-${i}`,
          }));
        assert.equal(query.get("cursor"), "cursor-99");
        return [{ job: jobs[0], cursor: "last" }];
      }
      const job = jobs.find((item) => path.endsWith(`/${item.id}`));
      if (job) return job;
      throw new Error(`Unexpected ${method} ${path}`);
    },
    { pollIntervalMs: 1, timeoutMs: 50 },
  );
  const id = randomUUID();
  await assert.rejects(f.restart().ensure(id), /accepted job response was lost/);
  const submission = (await f.store.get(id))!.jobRequest;
  assert.match(submission!.commandHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(await f.store.get(id)).includes(jobs[0]!.startCommand), false);
  await assert.rejects(f.restart().suspend(id), /job-1 is still pending/);
  assert.equal(pages, 2);
  assert.equal(jobs.length, 1);
  assert.equal(enabled, false);
  assert.equal((await f.store.get(id))!.jobId, "job-1");
  jobs[0]!.status = "succeeded";
  enabled = true;
  await f.restart().suspend(id);
  assert.equal(jobs.length, 2);
  assert.equal(enabled, false);
  assert.equal((await f.store.get(id))!.enabled, false);
  assert.equal((await f.store.get(id))!.operation, undefined);
  assert.equal((await f.store.get(id))!.jobRequest, undefined);
  await f.restart().ensure(id);
  assert.equal(jobs.length, 3);
  assert.equal(enabled, true);
  assert.notEqual(jobs[0]!.startCommand, jobs[2]!.startCommand);
});

for (const status of [400, 401, 403, 404, 409, 410, 412, 422, 429])
  test(`Rejected Render storage submissions (${status}) retain repair intent and allow a new job`, async () => {
    let rejected = true;
    let jobs = 0;
    const f = fixture(({ method, path }) => {
      if (method === "POST") {
        if (rejected) throw new RenderApiError(method, path, status);
        return { id: `job-${++jobs}` };
      }
      return { status: "succeeded" };
    });
    const id = randomUUID();
    await assert.rejects(f.storage.ensure(id), new RegExp(`HTTP ${status}`));
    assert.equal((await f.store.get(id))!.operation, "enable");
    assert.equal((await f.store.get(id))!.jobRequest, undefined);
    rejected = false;
    await f.storage.ensure(id);
    assert.equal(jobs, 1);
    assert.equal((await f.store.get(id))!.enabled, true);
  });

for (const failure of ["503", "connection"])
  for (const failedOperation of ["enable", "disable"] as const)
    for (const nextOperation of ["enable", "disable"] as const)
      test(`Render storage recovers ${failedOperation} lost before creation (${failure}) with ${nextOperation} after restart`, async () => {
        const events: string[] = [];
        let fail = false;
        let enabled = false;
        let userExists = false;
        let jobs = 0;
        const f = fixture(({ method, path, body }) => {
          if (method === "POST") {
            const operation = scriptOperation(body);
            events.push(`POST ${operation}`);
            if (fail) {
              if (failure === "503") throw new RenderApiError(method, path, 503);
              throw new Error("Connection closed before job creation");
            }
            if (operation === "enable") userExists = true;
            if (userExists) enabled = operation === "enable";
            return { id: `job-${++jobs}` };
          }
          if (path === "/services/srv-minio/jobs" && method === "GET") {
            events.push("LIST");
            return [];
          }
          return { status: "succeeded" };
        });
        const id = randomUUID();
        const initial = failedOperation === "disable" ? await f.storage.ensure(id) : undefined;
        fail = true;
        await assert.rejects(
          failedOperation === "enable" ? f.storage.ensure(id) : f.storage.suspend(id),
          /HTTP 503|Connection closed/,
        );
        const pending = (await f.store.get(id))!;
        assert.ok(pending.jobRequest);
        assert.equal(pending.operation, failedOperation);
        const acceptedBeforeRetry = jobs;
        fail = false;
        events.length = 0;
        const restarted = f.restart();
        const result = nextOperation === "enable" ? await restarted.ensure(id) : await restarted.suspend(id);
        const final = (await f.store.get(id))!;
        assert.deepEqual(events, ["LIST", `POST ${nextOperation}`]);
        assert.equal(jobs, acceptedBeforeRetry + 1);
        assert.equal(enabled, nextOperation === "enable");
        assert.equal(final.enabled, enabled);
        assert.equal(final.operation, undefined);
        assert.equal(final.jobRequest, undefined);
        assert.equal(final.jobId, undefined);
        assert.equal(final.accessKey, pending.accessKey);
        assert.equal(final.secretKeyEnc, pending.secretKeyEnc);
        if (initial && result) assert.deepEqual(result, initial);
      });

for (const failure of ["request", "missing cursor", "repeated cursor", "invalid list"])
  test(`Render storage keeps unconfirmed writes after a job search ${failure}`, async () => {
    let posts = 0;
    let pages = 0;
    let searchFails = true;
    const f = fixture(({ method, path, query }) => {
      if (method === "POST") {
        if (++posts === 1) throw new RenderApiError(method, path, 503);
        return { id: "job-retry" };
      }
      if (path === "/services/srv-minio/jobs" && method === "GET") {
        pages++;
        if (!searchFails) return [];
        if (query.has("cursor")) {
          if (failure === "request") throw new RenderApiError(method, path, 503);
          if (failure === "invalid list") return null;
        }
        return Array.from({ length: 100 }, (_, index) => ({
          job: { id: `unrelated-${index}`, serviceId: "srv-minio", startCommand: "unrelated" },
          ...(failure === "missing cursor" ? {} : { cursor: `cursor-${index}` }),
        }));
      }
      return { status: "succeeded" };
    });
    const id = randomUUID();
    await assert.rejects(f.restart().ensure(id), /HTTP 503/);
    const pending = structuredClone(await f.store.get(id));
    await assert.rejects(f.restart().suspend(id), /HTTP 503|pagination did not advance|invalid job list/);
    assert.equal(posts, 1);
    assert.equal(pages, failure === "missing cursor" ? 1 : 2);
    assert.deepEqual(await f.store.get(id), pending);
    searchFails = false;
    await f.restart().suspend(id);
    assert.equal(posts, 2);
    assert.equal((await f.store.get(id))!.enabled, false);
    assert.equal((await f.store.get(id))!.jobRequest, undefined);
  });
