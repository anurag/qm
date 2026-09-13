import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createS3DurableByteStore } from "../src/files/durable-byte-store.ts";
import { createDirectFileUploads, multipartChecksum } from "../src/files/direct-file-upload.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import type { FileUpload, FileUploadStore } from "../src/files/file-upload-store.ts";
import { createS3BlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createS3SnapshotStore } from "../src/sandbox/home-snapshot.ts";
import { s3Client } from "../src/persistence/s3.ts";

async function objectServer(t: TestContext) {
  t.mock.property(process, "env", {
    ...process.env,
    AWS_PROFILE: undefined,
    AWS_DEFAULT_PROFILE: undefined,
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    AWS_SESSION_TOKEN: "test-session-token",
    AWS_EC2_METADATA_DISABLED: "true",
  });
  const objects = new Map<string, Buffer>();
  const objectHeaders = new Map<string, Record<string, string>>();
  const parts = new Map<string, Buffer[]>();
  const requests: Array<{ method: string; url: URL; headers: IncomingHttpHeaders }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push({ method: request.method!, url, headers: request.headers });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    response.setHeader("content-type", "application/xml");
    if (url.searchParams.has("uploads")) {
      parts.set(url.pathname, []);
      response.end("<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>");
    } else if (url.searchParams.has("uploadId")) {
      if (request.method === "PUT") {
        parts.get(url.pathname)!.push(body);
        response.setHeader("etag", '"part"');
        response.end();
      } else if (request.method === "POST") {
        objects.set(url.pathname, Buffer.concat(parts.get(url.pathname)!));
        response.end('<CompleteMultipartUploadResult><ETag>"object"</ETag></CompleteMultipartUploadResult>');
      } else {
        parts.delete(url.pathname);
        response.end();
      }
    } else if (request.method === "PUT") {
      const source = request.headers["x-amz-copy-source"];
      objects.set(url.pathname, source ? objects.get(decodeURIComponent(String(source)))! : body);
      response.end(source ? '<CopyObjectResult><ETag>"copy"</ETag></CopyObjectResult>' : undefined);
    } else if (request.method === "DELETE") {
      objects.delete(url.pathname);
      response.statusCode = 204;
      response.end();
    } else {
      const object = objects.get(url.pathname);
      if (object) {
        const binary = url.searchParams.get("response-content-type") === "application/octet-stream";
        response.setHeader("content-type", binary ? "application/octet-stream" : "text/plain");
        if (binary) response.setHeader("content-length", object.length);
        else response.setHeader("content-encoding", "br");
        for (const [name, value] of Object.entries(objectHeaders.get(url.pathname) ?? {}))
          response.setHeader(name, value);
        response.flushHeaders();
        if (request.method === "HEAD") response.end();
        else response.end(binary ? object : brotliCompressSync(object));
      } else {
        response.statusCode = 404;
        response.end("<Error><Code>NoSuchKey</Code></Error>");
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    options: { bucket: "qm-test", region: "auto", endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true },
    requests,
    objects,
    objectHeaders,
  };
}

async function read(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("S3-compatible durable bytes stream through the configured endpoint and use standard credentials", async (t) => {
  const { options, requests } = await objectServer(t);
  const store = createS3DurableByteStore({ ...options, prefix: "org/" });
  const content = Buffer.from("durable bytes");
  const stored = await store.put(Readable.from(content));
  const opened = await store.open(stored.blobKey);
  assert.ok(opened);
  assert.equal(opened.sizeBytes, content.length);
  assert.deepEqual(await read(opened.stream), content);
  await store.delete(stored.blobKey);
  assert.equal(await store.open(stored.blobKey), null);
  for (const request of requests) {
    assert.equal(request.url.pathname, `/qm-test/org/${stored.blobKey}`);
    assert.match(request.headers.authorization!, /Credential=test-access-key\/.*\/auto\/s3\/aws4_request/);
    assert.equal(request.headers["x-amz-security-token"], "test-session-token");
    assert.equal(request.headers["x-amz-sdk-checksum-algorithm"], undefined);
    assert.equal(request.headers["content-encoding"], undefined);
    if (request.method === "GET")
      assert.equal(request.url.searchParams.get("response-content-type"), "application/octet-stream");
  }
});

test("S3-compatible transfers and portable snapshots use the configured endpoint", async (t) => {
  const { options, requests } = await objectServer(t);
  const transfers = createS3BlobTransferStore({ ...options, prefix: "org/" });
  const snapshots = createS3SnapshotStore({ ...options, prefix: "org/home" });
  const content = Buffer.from("home archive");
  const transfer = await transfers.put(content);
  const opened = await transfers.open(transfer.blobId);
  assert.ok(opened);
  assert.equal(opened.sizeBytes, content.length);
  assert.deepEqual(await read(opened.stream), content);
  await snapshots.put("personal:user", content);
  const snapshot = await snapshots.open("personal:user");
  assert.ok(snapshot);
  assert.equal(snapshot.size, content.length);
  assert.deepEqual(await read(snapshot.parts), content);
  const upload = await snapshots.createUpload!("personal:next");
  await upload.addPart(content);
  await upload.complete();
  const next = await snapshots.open("personal:next");
  assert.ok(next);
  assert.equal(next.size, content.length);
  assert.deepEqual(await read(next.parts), content);
  await snapshots.put("source", content);
  await snapshots.adoptFromS3!("copied", { bucket: options.bucket, key: "org/home/source.tar" });
  const copied = await snapshots.open("copied");
  assert.ok(copied);
  assert.equal(copied.size, content.length);
  assert.deepEqual(await read(copied.parts), content);
  await snapshots.delete!("personal:user");
  await transfers.delete(transfer.blobId);
  assert.equal(await snapshots.open("personal:user"), null);
  assert.equal(await transfers.open(transfer.blobId), null);
  assert.ok(requests.every((request) => request.url.pathname.startsWith("/qm-test/org/")));
  for (const request of requests.filter((r) => r.method === "GET" || r.method === "HEAD"))
    assert.equal(request.url.searchParams.get("response-content-type"), "application/octet-stream");
});

test("direct uploads verify exact length, checksum and identity through a compressing S3 endpoint", async (t) => {
  const { options, requests, objects, objectHeaders } = await objectServer(t);
  const content = Buffer.from("text responses can be compressed in transit\n".repeat(20));
  const id = "a".repeat(32);
  const checksums = [createHash("sha256").update(content).digest("base64")];
  const row: FileUpload = {
    id,
    actorId: "user",
    scopeId: "personal:user",
    name: "text.txt",
    mimetype: "text/plain",
    sizeBytes: content.length,
    partSize: 64 * 1024 * 1024,
    checksums,
    uploadId: "upload",
    state: "completing",
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  };
  const store: FileUploadStore = {
    async insert() {},
    async get() {
      return structuredClone(row);
    },
    async transition(_id, from, to) {
      if (!from.includes(row.state)) return false;
      row.state = to;
      return true;
    },
    async expired() {
      return [];
    },
  };
  const key = `files/uploads/${id}`;
  const path = `/${options.bucket}/${key}`;
  objects.set(path, content);
  const headers = { "x-amz-checksum-sha256": multipartChecksum(checksums), "x-amz-meta-qm-upload": id };
  objectHeaders.set(path, headers);
  const client = s3Client(options);
  t.after(() => client.destroy());
  const head = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key }));
  assert.equal(head.ContentLength, undefined);
  const transformed = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
  assert.equal(transformed.ContentLength, undefined);
  assert.notDeepEqual(Buffer.from(await transformed.Body!.transformToByteArray()), content);
  const bytes = createS3DurableByteStore(options);
  const files = createMemoryFileArtifactStore(bytes);
  const uploads = createDirectFileUploads({ ...options, store, files });
  const wrongHeaders: Array<Record<string, string>> = [
    { "content-length": String(content.length + 1) },
    { "x-amz-checksum-sha256": checksums[0]! },
    { "x-amz-meta-qm-upload": "another-upload" },
  ];
  for (const wrong of wrongHeaders) {
    objectHeaders.set(path, { ...headers, ...wrong });
    await assert.rejects(uploads.complete(id), /integrity check failed/);
    assert.equal(await files.get(id), null);
  }
  objectHeaders.set(path, headers);
  const artifact = await uploads.complete(id);
  assert.equal(artifact.sizeBytes, content.length);
  assert.equal(artifact.mimetype, "text/plain");
  assert.ok(artifact.blobKey);
  const opened = await bytes.open(artifact.blobKey);
  assert.ok(opened);
  assert.equal(opened.sizeBytes, content.length);
  assert.deepEqual(await read(opened.stream), content);
  for (const request of requests.slice(2))
    assert.equal(request.url.searchParams.get("response-content-type"), "application/octet-stream");
});

test("S3 client preserves AWS checksum defaults unless a custom endpoint is set", async (t) => {
  t.mock.property(process, "env", {
    ...process.env,
    AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_SUPPORTED",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_SUPPORTED",
  });
  const aws = s3Client({ region: "us-west-2" });
  const compatible = s3Client({ region: "auto", endpoint: "https://objects.example.com", forcePathStyle: true });
  t.after(() => {
    aws.destroy();
    compatible.destroy();
  });
  assert.equal(await aws.config.requestChecksumCalculation(), "WHEN_SUPPORTED");
  assert.equal(await aws.config.responseChecksumValidation(), "WHEN_SUPPORTED");
  assert.equal(aws.config.forcePathStyle, false);
  assert.equal(await compatible.config.requestChecksumCalculation(), "WHEN_REQUIRED");
  assert.equal(await compatible.config.responseChecksumValidation(), "WHEN_REQUIRED");
  assert.equal(compatible.config.forcePathStyle, true);
});
