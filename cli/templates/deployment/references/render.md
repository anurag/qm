# Render

For a branch deployment, install the CLI built from that branch, then run:

```sh
qm init --org <org> --target render \
  --repo https://github.com/OWNER/REPOSITORY.git --branch YOUR_BRANCH
```

Use a branch with Render support. These two flags must be supplied together and
are valid only for Render. They set `render.source.repo` and `render.source.branch`.
Render builds the built-in QM services and app runner from this repository.
MinIO uses a digest-pinned image. This path requires no image publication,
manifest changes, or local Docker engine. Private repositories need a Render
GitHub connection with access to the repository; public repositories do not.

Set `render.workspaceId`, region, and
the portal email access gate. Run `qm setup` for Render, model, administrator,
and email settings. Bundled MinIO does not require an AWS account or manually
created storage credentials. Keep `.env` private.

## Deployment

Run `qm check`, `qm plan`, and `qm up`. The CLI uses the Render API to create or
update a project named `<appPrefix>-qm`, with `orgId` as the default prefix. Its
`production` environment contains:

- Public core with one instance and no persistent disk.
- Private web UI and public portal with the sign-in broker.
- Render Postgres with external access initially disabled.
- MinIO from a digest-pinned image based on [Render's template](https://render.com/templates/minio), with a 10 GB disk by default.
- Separate services for plugins with published images.

A Blueprint is not required. Each `qm up` builds the configured Git branch.
Automatic Git deploys are disabled, so a push alone does not deploy changes.
Branches can move; builds are not pinned to a fixed Git commit. App deployment
and restore also build the app runner from the configured repository and branch.
`imageOverrides` and published plugin images remain explicit image selections.
Local source plugins still require published images. Adding `render.source` to
an existing deployment converts services to Git builds and retains service IDs
and disks. After a config change, run `qm plan` and `qm up`.
The CLI records assigned URLs and uploads the deployment
layer after core is healthy. Run `qm slack render` when the URLs change.
This target uses assigned `onrender.com` URLs; custom domains need a separate migration.
Slack runs in core and admin in web UI. Removing `slack` clears its core
environment credentials; disconnect a stored installation in Admin separately.

The CLI sets core's `RENDER_PROJECT_ID` to the shared project and
`RENDER_ENVIRONMENT_ID` to `production`. App deployment requires the project ID;
Render Sandboxes alone do not. Core creates an isolated environment in that
project for each app owner scope. It contains that owner's private apps and a
trusted gateway that runs stock Caddy. Core, Postgres, and MinIO stay in the
shared environment. The app private network cannot reach the shared stack or
another owner's environment.

The CLI supplies `RENDER_POSTGRES_ID` and a credential-free external
`RENDER_APP_DATABASE_ENDPOINT` with `sslmode=verify-full`. Core provisions app
databases through its internal administrator connection. Apps use restricted
logins over the public endpoint with TLS certificate and hostname checks.
QM adds the reported app-service outbound IP ranges to the database access list under
a shared lock and retains existing entries. It does not add a public catch-all
rule. Keep database credentials on the server and do not disable TLS checks.

Core applies QM access checks before it sends authenticated requests over HTTPS
to the owner's gateway. The gateway routes them to private apps and does not run
app code. Anyone with write access to an app can run code on its owner's private
network and reach that owner's other apps. Treat all app editors in an owner
scope as trusted with every app in that scope. Read-only shares still use core
access checks. Ownership transfers retain the previous owner's write grant.

Each active owner adds one public gateway web service and one environment. The
gateway has no disk. Route changes redeploy it and can interrupt active streams
for that owner.

## Storage

After MinIO is ready, the CLI starts a one-off initialization job on that service.
The job uses the image's MinIO client over the private network to create the
private `qm-storage` bucket and a scoped identity. It uses the MinIO service's
root and storage credentials. Core receives only the scoped identity and public
HTTPS API URL. The AWS SDK variables contain MinIO credentials. The job uses the
same image as the server. No AWS account or local MinIO client is required.

Core uses `S3_REGION=us-east-1`, `S3_FORCE_PATH_STYLE=true`,
`WORKSPACE_STORE=s3`, `SNAPSHOT_STORE=s3`, and `TRANSFER_STORE=s3`. The CLI sets
CORS to the QM public origin. Incomplete multipart uploads become eligible for
cleanup after 24 hours, with cleanup every six hours. Completed objects remain.
Core waits for authenticated bucket access before it starts.

Postgres stores metadata. MinIO stores durable files and portable sandbox
backups. Files at `/data` are temporary. MinIO has one instance and a persistent
disk; storage can stop briefly during its deploys. Keep one core instance.
Existing local data needs a separate migration; QM does not migrate files or
detach a core disk.

To use an existing MinIO deployment or S3-compatible service, set
`render.storage` to `{"type":"external"}`. Set `env.core.S3_BUCKET`, `S3_REGION`,
and, when needed, `AWS_ENDPOINT_URL_S3` and `S3_FORCE_PATH_STYLE`. Use the API URL.
Setup then requests its access key and secret. Use `AWS_SESSION_TOKEN` only for
temporary credentials. An explicit `AWS_SESSION_TOKEN=` in `.env` clears a
saved token with `qm secrets push`; omission retains its saved value. Existing
configs without a storage field keep external mode.

Use a private bucket and a scoped identity. Configure browser upload CORS and
incomplete-upload cleanup. Do not expire durable objects. Switching modes does
not migrate objects or transfer ownership of an external store.

## Operations

`qm status` reports resource state. `qm logs [-f]` reads provider logs.
`qm secrets push` updates operator secrets. `qm doctor` checks credentials
without creating resources. `qm check --live` checks the owned resources, health,
and signed core access. It then runs the shared session and database checks in
a Render one-off job. The session check uses the configured model, checks the
stored reply and title, and archives its test session. Model and job usage apply.

`qm down` retains Postgres and MinIO data; storage charges continue.
`qm down --purge` deletes hosted QM services, Postgres, and bundled MinIO data.
The project, environment, and external storage remain. Keep
`render.resources.json` available for recovery; it contains resource IDs and
pending operations for the shared stack, but no credentials. Core stores runtime
app, owner gateway, and owner environment state in Postgres. CLI teardown does
not remove these resources.

Shutdown stops if a published app still runs in any environment in the project.
Archive or stop these apps first. Purge stops if any published app service remains, including a
suspended service. Back up app data and delete these services before purge.

Published apps use private services with no persistent disk. QM supplies a
restricted `DATABASE_URL` for each app's Postgres database and runtime
`QM_APP_STORAGE_URL` and `QM_APP_STORAGE_TOKEN` for signed file URLs. Keep file
keys and metadata in Postgres. Do not use SQLite or local files for persistent
state. Read runtime credentials only from the server environment; do not copy
their values into publish parameters, source files, or browser code.

Idle cleanup and archive suspend the app and revoke its source and storage
tokens. They retain its service, database, and objects for restore. Rollback
deploys earlier code and retains current data. Storage charges continue. Deleting
the app service does not delete its database or objects. For permanent removal,
archive the app, back up its data, then remove its service and retained app data.

Suspending the last active app in an owner scope also suspends its gateway and
retains the environment. Restore resumes the required resources.

Agent sandboxes are created on demand. Core runs the existing scheduler;
Workflows and Render Cron Jobs are not required.

## Agent-computer proof

Ask the agent to write a unique value to `/root/workspace/qm-computer-proof.txt`.
Find its sandbox ID in Admin, read the file through the Render SDK, and compare
its value. Restart the sandbox through QM and confirm the file remains. Restart
core with an empty data directory and repeat the check. Share a file before the
restart and confirm another authorized session can read it afterward. Test a
browser multipart upload, app deployment and rollback, and teardown.

## Release

To use released images, install a CLI release with Render support and run
`qm init --org <org> --target render` without `--repo` and `--branch`.
Without `render.source`, QM uses the image digests in that CLI release. The
release workflow builds, publishes, and pins the standard images. Operators do
not need to publish them. The checked-in placeholder manifest cannot deploy an
image-based stack. Git builds do not use those standard image entries.
