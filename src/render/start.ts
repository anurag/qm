import { loadConfig } from "../config.ts";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export async function awaitBucket(
  client: { send(command: HeadBucketCommand, options: { abortSignal: AbortSignal }): Promise<unknown> },
  bucket: string,
  signal: AbortSignal,
  retryMs = 1_000,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
      return;
    } catch {
      await sleep(retryMs, undefined, { signal }).catch(() => undefined);
    }
  }
  throw new Error("MinIO did not accept the QM bucket credentials before the startup deadline");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  if (config.deployProvider === "render") {
    const bucket = config.s3Bucket;
    const endpoint = config.s3Endpoint;
    if (!bucket || !endpoint) throw new Error("Bundled MinIO requires S3_BUCKET and AWS_ENDPOINT_URL_S3");
    const client = new S3Client({
      region: config.s3Region ?? "us-east-1",
      endpoint,
      forcePathStyle: true,
      maxAttempts: 1,
    });
    try {
      await awaitBucket(client, bucket, AbortSignal.timeout(120_000));
    } finally {
      client.destroy();
    }
  }
  await import("../index.ts");
}
