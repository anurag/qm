import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3Client } from "../persistence/s3.ts";
import { createS3SnapshotStore, type HomeSnapshotStore, type S3SnapshotStoreOptions } from "./home-snapshot.ts";

export interface RenderSnapshotStore extends HomeSnapshotStore {
  delete(key: string): Promise<void>;
}

export function createRenderSnapshotStore(opts: S3SnapshotStoreOptions): RenderSnapshotStore {
  const s3 = opts.s3 ?? s3Client(opts.region);
  const keyFor = opts.keyFor ?? ((key: string) => `${opts.prefix}/${encodeURIComponent(key)}.tar`);
  return {
    ...createS3SnapshotStore({ ...opts, s3, keyFor }),
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: keyFor(key) }));
    },
  };
}
