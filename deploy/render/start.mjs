import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export async function waitForMinio({ timeoutMs = 120_000, intervalMs = 1_000 } = {}) {
  if (!process.env.S3_BUCKET || !process.env.AWS_ENDPOINT_URL_S3) {
    throw new Error("Bundled MinIO requires a bucket and endpoint");
  }
  const { HeadBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: process.env.S3_REGION ?? "us-east-1",
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    maxAttempts: 1,
  });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    while (!signal.aborted) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }), { abortSignal: signal });
        return;
      } catch {
        await sleep(intervalMs, undefined, { signal }).catch(() => {});
      }
    }
    throw new Error("MinIO did not accept the QM bucket credentials before the startup deadline");
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const service = process.argv[2];
  const entries = { core: "src/index.ts", "web-ui": "server/index.ts", portal: "src/index.ts" };
  if (!Object.hasOwn(entries, service)) throw new Error("Unknown Render service");
  const entry = entries[service];
  if (service === "core" && process.env.RENDER_QM_MINIO === "true") await waitForMinio();
  const entryPath = resolve(entry);
  process.argv.splice(1, 2, entryPath);
  await import(pathToFileURL(entryPath).href);
}
