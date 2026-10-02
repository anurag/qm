import { CliError } from "./log.ts";

export const renderMinioCommand = "minio server --address 0.0.0.0:9000 /data";

const storagePolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
        "s3:GetLifecycleConfiguration",
        "s3:PutLifecycleConfiguration",
      ],
      Resource: ["arn:aws:s3:::qm-storage"],
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
      Resource: ["arn:aws:s3:::qm-storage/*"],
    },
  ],
};

export function renderMinioInitCommand(slug: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new CliError("Render returned no valid private hostname for MinIO");
  const script = `set -eu
umask 077
: "\${MINIO_ROOT_USER:?MINIO_ROOT_USER is missing}"
: "\${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is missing}"
: "\${QM_STORAGE_SECRET_KEY:?QM_STORAGE_SECRET_KEY is missing}"
carriage_return=$(printf '\\r')
line_feed='
'
require_single_line() {
  case "$2" in
    *"$carriage_return"*|*"$line_feed"*)
      printf 'MinIO initialization failed: %s must be one line\\n' "$1" >&2
      exit 1
      ;;
  esac
}
require_single_line MINIO_ROOT_USER "$MINIO_ROOT_USER"
require_single_line MINIO_ROOT_PASSWORD "$MINIO_ROOT_PASSWORD"
require_single_line QM_STORAGE_SECRET_KEY "$QM_STORAGE_SECRET_KEY"
if [ "$MINIO_ROOT_USER" = "qm-storage" ]; then
  printf 'MinIO root and QM users must be different\\n' >&2
  exit 1
fi
mc_config=$(mktemp -d /tmp/qm-minio.XXXXXX)
trap 'rm -rf "$mc_config"' EXIT
trap 'exit 1' HUP INT TERM
unset MC_HOST_qm MC_CONFIG_ENV_FILE
mc_quiet() { timeout -s TERM -k 5 30 mc --config-dir "$mc_config" --no-color "$@" >/dev/null 2>&1; }
run_mc() {
  operation=$1
  shift
  if ! mc_quiet "$@"; then
    printf 'MinIO initialization failed: %s\\n' "$operation" >&2
    exit 1
  fi
}
printf '%s\\n%s\\n' "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" | run_mc 'root connection' alias set qm http://${slug}:9000 --api S3v4 --path on
run_mc 'readiness check' ready qm
run_mc 'bucket creation' mb --ignore-existing qm/qm-storage
run_mc 'private bucket access' anonymous set none qm/qm-storage
cat >"$mc_config/policy.json" <<'QM_MINIO_POLICY'
${JSON.stringify(storagePolicy)}
QM_MINIO_POLICY
run_mc 'storage policy' admin policy create qm qm-storage "$mc_config/policy.json"
printf '%s\\n' "$QM_STORAGE_SECRET_KEY" | run_mc 'storage user' admin user add qm qm-storage
if ! mc_quiet admin policy attach qm qm-storage --user qm-storage; then
  run_mc 'storage policy detachment' admin policy detach qm qm-storage --user qm-storage
  run_mc 'storage policy attachment' admin policy attach qm qm-storage --user qm-storage
fi
printf 'MinIO storage is ready\\n'
`;
  return renderJobCommand(script, "timeout -s TERM -k 10 120 /bin/sh");
}

function renderJobCommand(script: string, interpreter: string): string {
  const separator = "${IFS}";
  const decode = ["printf", "%s", Buffer.from(script).toString("base64")].join(separator);
  return `/bin/sh -c ${decode}|${["base64", "-d"].join(separator)}|${interpreter.split(" ").join(separator)}`;
}
