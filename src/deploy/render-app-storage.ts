import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { sleep } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { createRenderApi, list, RenderApiError, type RenderApi } from "./render-api.ts";

export interface StoredRenderAppStorage {
  deploymentId: string;
  accessKey: string;
  secretKeyEnc: string;
  enabled: boolean;
  jobId?: string;
  jobRequest?: { commandHash: string; createdAfter: string };
  operation?: "enable" | "disable";
}

interface Job {
  id: string;
  status: string;
  serviceId?: string;
  startCommand?: string;
}

export function renderAppStoragePolicy(bucket: string, prefix: string) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-zA-Z0-9/_-]+\/$/.test(prefix))
    throw new Error("Render app storage requires a bucket and a safe object prefix");
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:GetBucketLocation"], Resource: [`arn:aws:s3:::${bucket}`] },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
      {
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}*`],
      },
    ],
  };
}

export function createRenderAppStorage(opts: {
  apiKey: string;
  workspaceId: string;
  environmentId: string;
  minioServiceId: string;
  endpoint: string;
  bucket: string;
  prefix?: string;
  region?: string;
  store: DurableMap<StoredRenderAppStorage>;
  keyMaterial: string | Buffer;
  api?: RenderApi;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): { ensure(deploymentId: string): Promise<Record<string, string>>; suspend(deploymentId: string): Promise<void> } {
  const endpoint = new URL(opts.endpoint);
  if (
    !opts.minioServiceId ||
    !opts.keyMaterial.length ||
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new Error("Render app storage requires a MinIO service and a valid endpoint");
  const key = deriveConnectorKey(opts.keyMaterial, "render-app-storage");
  const api = opts.api ?? createRenderApi(opts);
  const prefixFor = (id: string) => `${opts.prefix ?? ""}app-data/${id}/`;
  const path = `/services/${encodeURIComponent(opts.minioServiceId)}`;
  const poll = opts.pollIntervalMs ?? 2_000;
  const hashCommand = (command: string) => createHash("sha256").update(command).digest("hex");

  async function provision(record: StoredRenderAppStorage, operation: "enable" | "disable"): Promise<void> {
    const service = await api.request<{ ownerId: string; environmentId?: string; type: string }>("GET", path);
    if (
      service?.ownerId !== opts.workspaceId ||
      service.environmentId !== opts.environmentId ||
      service.type !== "web_service"
    )
      throw new Error("The MinIO service does not belong to this Render environment");
    if (record.jobRequest && !record.jobId) {
      const jobId = await findSubmittedJob(record.jobRequest);
      record = { ...record, jobId, jobRequest: jobId ? record.jobRequest : undefined };
      if (jobId) await opts.store.put(record.deploymentId, record);
    }
    if (record.jobId) {
      if (!record.operation) throw new Error("Render app storage job has no saved operation");
      const previousOperation = record.operation;
      const succeeded = await wait(record.jobId);
      const jobId = record.jobId;
      record = {
        ...record,
        enabled: succeeded ? previousOperation === "enable" : record.enabled,
        jobId: undefined,
        jobRequest: undefined,
        operation: succeeded ? undefined : previousOperation,
      };
      await opts.store.put(record.deploymentId, record);
      if (previousOperation === operation) {
        if (!succeeded) throw new Error(`Render app storage job ${jobId} failed`);
        return;
      }
    }
    const password = decryptSecret(record.secretKeyEnc, key);
    const policy = JSON.stringify(renderAppStoragePolicy(opts.bucket, prefixFor(record.deploymentId)));
    const script = `set -eu
: ${randomBytes(24).toString("hex")}
umask 077
config=$(mktemp -d)
trap 'rm -rf "$config"' EXIT
unset MC_HOST_qm MC_CONFIG_ENV_FILE
run_mc() { timeout -s TERM -k 5 30 mc --config-dir "$config" --no-color "$@" >/dev/null 2>&1; }
printf '%s\\n%s\\n' "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" | run_mc alias set qm ${shq(endpoint.toString())} --api S3v4 --path on
printf '%s' ${shq(policy)} > "$config/policy.json"
${
  operation === "disable"
    ? `if ! run_mc admin user disable qm ${shq(record.accessKey)}; then
  result=$(timeout -s TERM -k 5 30 mc --config-dir "$config" --no-color --json admin user info qm ${shq(record.accessKey)} 2>/dev/null) && exit 1
  case "$result" in
    *'"Code":"XMinioAdminNoSuchUser"'*) ;;
    *) exit 1 ;;
  esac
fi`
    : `printf '%s\\n' ${shq(password)} | run_mc admin user add qm ${shq(record.accessKey)}
run_mc admin user enable qm ${shq(record.accessKey)}
run_mc admin policy create qm ${shq(`qm-app-${record.accessKey}`)} "$config/policy.json"
run_mc admin policy attach qm ${shq(`qm-app-${record.accessKey}`)} --user ${shq(record.accessKey)} || {
  run_mc admin policy detach qm ${shq(`qm-app-${record.accessKey}`)} --user ${shq(record.accessKey)}
  run_mc admin policy attach qm ${shq(`qm-app-${record.accessKey}`)} --user ${shq(record.accessKey)}
}`
}
`;
    const startCommand = `/bin/sh -c printf %s ${Buffer.from(script).toString("base64")} | base64 -d | /bin/sh`;
    record = {
      ...record,
      operation,
      jobRequest: {
        commandHash: hashCommand(startCommand),
        createdAfter: new Date(Date.now() - 60_000).toISOString(),
      },
    };
    await opts.store.put(record.deploymentId, record);
    let job: Job | null;
    try {
      job = await api.request<Job>("POST", `${path}/jobs`, { startCommand });
    } catch (error) {
      if (error instanceof RenderApiError && error.rejected)
        await opts.store.put(record.deploymentId, { ...record, jobRequest: undefined });
      throw error;
    }
    if (!job?.id) throw new Error("Render did not return an app storage job ID");
    record = { ...record, jobId: job.id };
    await opts.store.put(record.deploymentId, record);
    if (!(await wait(job.id))) {
      await opts.store.put(record.deploymentId, { ...record, jobId: undefined, jobRequest: undefined });
      throw new Error(`Render app storage job ${record.jobId} failed`);
    }
    await opts.store.put(record.deploymentId, {
      ...record,
      enabled: operation === "enable",
      operation: undefined,
      jobId: undefined,
      jobRequest: undefined,
    });
  }

  async function findSubmittedJob(
    request: NonNullable<StoredRenderAppStorage["jobRequest"]>,
  ): Promise<string | undefined> {
    let match: string | undefined;
    for (const job of await list<Job>(api, `${path}/jobs`, "job", { createdAfter: request.createdAfter })) {
      if (
        job.serviceId === opts.minioServiceId &&
        job.startCommand &&
        hashCommand(job.startCommand) === request.commandHash
      ) {
        if (match && match !== job.id) throw new Error("Render returned duplicate app storage job submissions");
        match = job.id;
      }
    }
    return match;
  }

  async function wait(jobId: string): Promise<boolean> {
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      const job = await api.request<Job>("GET", `${path}/jobs/${encodeURIComponent(jobId)}`);
      if (job?.status === "succeeded") return true;
      if (job && ["failed", "canceled"].includes(job.status)) return false;
      await sleep(Math.max(1, poll));
    }
    throw new Error(`Render app storage job ${jobId} is still pending`);
  }

  return {
    async ensure(deploymentId) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(deploymentId))
        throw new Error("Render app storage requires a deployment UUID");
      let record = await opts.store.get(deploymentId);
      if (!record)
        record = await opts.store.putIfAbsent(deploymentId, {
          deploymentId,
          accessKey: randomBytes(10).toString("hex").toUpperCase(),
          secretKeyEnc: encryptSecret(randomBytes(30).toString("base64url"), key),
          enabled: false,
        });
      if (record.deploymentId !== deploymentId) throw new Error("Render app storage identity does not match");
      if (!record.enabled || record.operation) await provision(record, "enable");
      return {
        AWS_ACCESS_KEY_ID: record.accessKey,
        AWS_SECRET_ACCESS_KEY: decryptSecret(record.secretKeyEnc, key),
        AWS_REGION: opts.region ?? "us-east-1",
        AWS_ENDPOINT_URL_S3: endpoint.toString(),
        AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
        S3_FORCE_PATH_STYLE: "true",
        S3_BUCKET: opts.bucket,
        S3_PREFIX: prefixFor(deploymentId),
      };
    },
    async suspend(deploymentId) {
      const record = await opts.store.get(deploymentId);
      if (record && (record.enabled || record.operation)) await provision(record, "disable");
    },
  };
}
