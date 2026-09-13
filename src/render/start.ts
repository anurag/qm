import { loadConfig } from "../config.ts";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { setTimeout as sleep } from "node:timers/promises";

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
  const signal = AbortSignal.timeout(120_000);
  let ready = false;
  try {
    while (!signal.aborted) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
        ready = true;
        break;
      } catch {
        await sleep(1_000, undefined, { signal }).catch(() => undefined);
      }
    }
    if (!ready) throw new Error("MinIO did not accept the QM bucket credentials before the startup deadline");
  } finally {
    client.destroy();
  }
}

await import("../index.ts");
