import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";
import { s3Client, type S3ConnectionOptions } from "../persistence/s3.ts";
import type { Deployment, DeployStore } from "./deploy-store.ts";

const TOKEN_KIND = "render-app-storage";
const DEPLOYMENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const URL_TTL_SECONDS = 60;

type StorageMethod = "GET" | "PUT" | "DELETE";
type StorageCommand = GetObjectCommand | PutObjectCommand | DeleteObjectCommand;

interface StorageAccess {
  kind: typeof TOKEN_KIND;
  version: 1;
  deploymentId: string;
  principalId: string;
  exp: number;
}

export class RenderAppStorageError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface RenderAppStorage {
  sign(
    deploymentId: string,
    token: string,
    input: { method: unknown; key: unknown },
  ): Promise<{ url: string; method: StorageMethod; expiresAt: number }>;
}

export function mintRenderAppStorageToken(
  secret: string,
  access: Pick<StorageAccess, "deploymentId" | "principalId">,
): Promise<string> {
  return mintSignedPayload(
    { ...access, kind: TOKEN_KIND, version: 1, exp: Number.MAX_SAFE_INTEGER } satisfies StorageAccess,
    secret,
  );
}

export function createRenderAppStorage(
  opts: S3ConnectionOptions & {
    bucket: string;
    prefix?: string;
    signingSecret: string;
    deployStore: Pick<DeployStore, "get">;
    authorizes(deployment: Deployment, principalId: string, permission: "read" | "write"): Promise<boolean>;
    client?: S3Client;
    presign?: (command: StorageCommand, expiresIn: number) => Promise<string>;
    now?: () => number;
  },
): RenderAppStorage {
  if (!opts.bucket || !opts.signingSecret) throw new Error("Render app storage requires a bucket and signing secret");
  const client = opts.client ?? s3Client({ ...opts, requestChecksumCalculation: "WHEN_REQUIRED" });
  const presign = opts.presign ?? ((command, expiresIn) => getSignedUrl(client, command, { expiresIn }));
  const now = opts.now ?? Date.now;
  return {
    async sign(deploymentId, token, input) {
      const access = (await verifySignedPayload(token, opts.signingSecret)) as StorageAccess | null;
      if (
        !access ||
        access.kind !== TOKEN_KIND ||
        access.version !== 1 ||
        typeof access.deploymentId !== "string" ||
        !DEPLOYMENT_ID.test(access.deploymentId) ||
        typeof access.principalId !== "string" ||
        !access.principalId ||
        !Number.isSafeInteger(access.exp) ||
        now() >= access.exp
      )
        throw new RenderAppStorageError("Invalid or expired app storage token", 401);
      if (access.deploymentId !== deploymentId) throw new RenderAppStorageError("App storage access denied", 403);
      const deployment = await opts.deployStore.get(deploymentId);
      if (
        !deployment ||
        deployment.id !== deploymentId ||
        !(await opts.authorizes(deployment, access.principalId, "read"))
      )
        throw new RenderAppStorageError("App storage access denied", 403);
      const { method, key } = input;
      if (method !== "GET" && method !== "PUT" && method !== "DELETE")
        throw new RenderAppStorageError("method must be GET, PUT, or DELETE");
      if (
        typeof key !== "string" ||
        !key ||
        Buffer.byteLength(key, "utf8") > 512 ||
        /[\u0000-\u001f\u007f\\]/.test(key) ||
        key.split("/").some((segment) => !segment || segment === "." || segment === "..")
      )
        throw new RenderAppStorageError("key must be a relative object path of 1 to 512 bytes without dot segments");
      const target = { Bucket: opts.bucket, Key: `${opts.prefix ?? ""}app-data/${deploymentId}/${key}` };
      let command: StorageCommand;
      if (method === "GET") command = new GetObjectCommand(target);
      else if (method === "PUT") command = new PutObjectCommand(target);
      else command = new DeleteObjectCommand(target);
      const expiresAt = now() + URL_TTL_SECONDS * 1000;
      return { url: await presign(command, URL_TTL_SECONDS), method, expiresAt };
    },
  };
}
