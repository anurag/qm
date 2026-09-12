# Render Sandboxes

To use Render Sandboxes with an existing QM deployment, set:

```dotenv
SANDBOX_BACKEND=render
RENDER_API_KEY=
RENDER_WORKSPACE_ID=
RENDER_REGION=oregon
```

Supply the API key through your deployment's secret store. Set the workspace ID
to the workspace that owns the sandboxes. The core needs a reachable
`PUBLIC_API_URL` for sandbox calls to QM. Use Postgres for durable provider
references and a persistent `DATA_DIR` for home backups.

`RENDER_SANDBOX_PLAN` selects `starter`, `standard`, or `pro`. The default is
`starter`. `RENDER_SANDBOX_TTL_SEC` sets the sandbox lifetime; the default is
7200 seconds. `SANDBOX_TIMEOUT_SEC` sets the command timeout.
The sandbox lifetime must exceed the command timeout by more than 60 seconds.

The provider uses the official `@renderinc/sdk` package, pinned to version
1.1.0. It implements command execution, file operations, process sessions,
blob transfers, home import and export, restart, and idle cleanup. See the
[SDK sandbox source](https://github.com/render-oss/sdk/blob/main/typescript/src/experimental/sandboxes/index.ts).

Native filesystem snapshots provide the normal restore path. Portable home
backups on the core disk provide recovery after a native snapshot expires.
If `SNAPSHOT_STORE=s3` is already configured, the provider uses that store for
portable backups instead. Multiple core instances must use the same S3 store.
Each checkpoint records its exact backup reference. A missing backup causes
an explicit recovery error; QM does not restore an older local copy or create
an empty replacement home.

Filesystem snapshots restore files. They do not resume background processes.
Process sessions continue while their original sandbox remains active. They
must be started again after the sandbox expires or is replaced.

The provider reports that it has no enforced egress proxy. It does not claim
network restrictions that the integration has not configured.

For local development, run:

```sh
bash scripts/dev-instance.sh up --sandbox render
```

Set `RENDER_API_KEY` and `RENDER_WORKSPACE_ID` first. The development launcher
uses `PUBLIC_API_URL` when supplied, or starts a tunnel for sandbox callbacks.

A release must include the new core image before a deployed QM instance can
use this provider. Unit tests use fake Render responses. Live acceptance must
check signed agent execution, snapshot restore, core restart, and scope deletion.
