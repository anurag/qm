import assert from "node:assert/strict";
import { test } from "node:test";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { awaitBucket } from "../src/render/start.ts";

test("Render core start waits for the bundled MinIO bucket and gives up at the deadline", async () => {
  const buckets: string[] = [];
  let failures = 2;
  const client = {
    async send(command: HeadBucketCommand) {
      buckets.push(command.input.Bucket!);
      if (failures-- > 0) throw new Error("connection refused");
      return {};
    },
  };
  await awaitBucket(client, "qm-storage", AbortSignal.timeout(10_000), 1);
  assert.deepEqual(buckets, ["qm-storage", "qm-storage", "qm-storage"]);
  await assert.rejects(
    awaitBucket(client, "qm-storage", AbortSignal.abort(), 1),
    /did not accept the QM bucket credentials before the startup deadline/,
  );
  assert.equal(buckets.length, 3);
  failures = Number.POSITIVE_INFINITY;
  await assert.rejects(awaitBucket(client, "qm-storage", AbortSignal.timeout(20), 1), /startup deadline/);
});
