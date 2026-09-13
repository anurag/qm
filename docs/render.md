# Render

QM uses the Render API to deploy its services, database, and bundled object
storage. The core creates Render Sandboxes through the sandbox provider interface.

## Create the deployment

Install the CLI from the branch that contains Render support as described in the
[branch deployment guide](./render-branch-deploy.md). Then select the repository
and branch that Render will build:

```sh
npm exec qm -- init . --org <slug> --target render \
  --repo https://github.com/OWNER/REPOSITORY.git --branch YOUR_BRANCH
npm exec qm -- setup
npm exec qm -- check
npm exec qm -- plan
npm exec qm -- up
```

Use a branch with the Render provider code. `--repo` and `--branch` must be given
together and require `--target render`. They set `render.source.repo` and
`render.source.branch`. The repository must use an HTTPS GitHub URL. Private
repositories require a Render GitHub connection with access to that repository.
Public repositories do not require this connection. This path needs no image
publication, CLI manifest changes, or local Docker engine.

Set `render.workspaceId`, the region, and the portal email access gate in
`qm.config.jsonc` before setup. Setup collects Render, model, administrator, and
email settings. Keep `.env` private. In a private QM fork, keep this deployment
directory under `deploy/layers/<org>/`.

`qm up` creates or updates a project named `<appPrefix>-qm`, with `orgId` as the
default prefix. It puts the services and database in the `production` environment.
The CLI uses the Render API directly. It does not require a Blueprint, a Git
checkout on the operator's machine after CLI installation, or a separate
infrastructure command.

With `render.source`, Render builds the built-in QM services from their
Dockerfiles in the same repository. Each `qm up` builds the configured branch,
even if its name has not changed. Automatic Git deploys are disabled;
pushing to the branch alone does not deploy it. The branch can move, so these
builds are not pinned to one Git commit. Published app deployment and restore
also build the app runner from this repository and branch.

`imageOverrides` and published plugin images remain explicit image selections.
Local source plugins still require published images. Adding `render.source` to
an existing deployment converts its services to Git builds while preserving
their service IDs and disks.

The CLI records the assigned service URLs in the local config and uploads the
deployment layer after core is healthy. Run `qm slack render` when those URLs
change. For later changes, edit the config and run `qm plan` and `qm up` again.
This target uses the assigned `onrender.com` URLs; custom domains are not supported.

## Bundled MinIO

New Render configurations select:

```json
{
  "render": {
    "storage": { "type": "minio", "plan": "0.5c-512mb", "diskSizeGB": 10 }
  }
}
```

MinIO runs a digest-pinned image from
[Render's MinIO template](https://render.com/templates/minio). After MinIO is
ready, QM's Render deployment code starts a one-off initialization job on that
service. The job uses the image's MinIO client over the private network to create
the private `qm-storage` bucket and a scoped identity. It uses the MinIO service's
root and storage credentials. Core receives only the scoped identity.

The initialization job uses the same image as the server and requires no local
Docker engine or MinIO client. Setup generates the credentials and does not ask
for AWS credentials.

QM uses the AWS SDK's S3 protocol, so the runtime variables retain the names
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. They contain MinIO credentials.
Core uses the MinIO service's public HTTPS API URL as `AWS_ENDPOINT_URL_S3`, with
`S3_BUCKET=qm-storage`, `S3_REGION=us-east-1`, and `S3_FORCE_PATH_STYLE=true`.
The public endpoint supports browser uploads with signed URLs. The CLI sets
upload CORS to the QM public origin.

MinIO makes incomplete multipart uploads eligible for cleanup after 24 hours and
checks them every six hours. Completed objects remain. MinIO has one instance
and a persistent disk; its deploys can briefly interrupt storage. Core waits for
authenticated bucket access before startup.

## Use an existing object store

Set `render.storage.type` to `external` and configure the existing bucket:

```json
{
  "render": { "storage": { "type": "external" } },
  "env": {
    "core": {
      "S3_BUCKET": "qm-storage",
      "S3_REGION": "us-east-1",
      "AWS_ENDPOINT_URL_S3": "https://your-minio-api.onrender.com",
      "S3_FORCE_PATH_STYLE": "true"
    }
  }
}
```

Keep the other deployment settings. For AWS S3, use the bucket's AWS region and
omit the custom endpoint. Setup collects external storage credentials in `.env`.
Temporary credentials can require `AWS_SESSION_TOKEN`. Set `AWS_SESSION_TOKEN=`
to clear a saved token with `qm secrets push`; omission keeps its saved value.
Existing Render configs without a `storage` field retain external mode.

Use a private bucket and a scoped identity that permit reads, writes, deletes,
multipart uploads, and signed URLs. Configure upload CORS for the QM public
origin and incomplete-upload cleanup. Do not expire durable objects. QM does
not take ownership of external storage or move objects when storage mode changes.

## Services and data

The default stack contains public core, private web UI, public portal, Render
Postgres, and MinIO. Slack runs in core, admin in web UI, and the sign-in broker
in portal. Image plugins get separate services and only the credentials they
request. Removing `slack` clears core's environment
credentials. Disconnect any stored Slack installation in Admin separately.

Core selects `SANDBOX_BACKEND=render`, `DEPLOY_PROVIDER=render`,
`WORKSPACE_STORE=s3`, `SNAPSHOT_STORE=s3`, and `TRANSFER_STORE=s3`. Postgres stores
sessions, runs, file metadata, and provider references. Object storage holds
workspace files, portable sandbox backups, file artifacts, and Git archives.
Core has no persistent disk; files at `/data` are temporary. Keep one core
instance until concurrent recovery has been tested. Existing local data needs a
separate backup and migration; QM does not copy it or detach disks automatically.

`qm status` and `qm logs` report the owned resources. `qm secrets push` updates
operator secrets. `qm down` retains Postgres and MinIO data, so storage charges
continue. `qm down --purge` deletes the hosted QM services, Postgres, and bundled MinIO
data. It retains the project and environment. External object storage is outside
this lifecycle. Keep `render.resources.json` with the deployment configuration;
it records resource IDs and pending operations, but no credentials. Do not use
one deployment directory for concurrent CLI operations.

Shutdown stops if a published app still runs in the environment. Archive or stop
these apps first. Purge stops if any published app service remains, including a
suspended service. Back up app data and delete these services before purge.

Published apps use private Render services in the same environment. QM proxies
public requests through its existing access controls. The shared private network
does not enforce those controls between apps: app code can connect directly to
peer service ports. This matches the current Fly limitation; use this target
where app authors are trusted to access the deployment network.

App services have no persistent disk. Render keeps the current instance available
while its replacement starts. QM continues to route requests to the live service
during the update. Render keeps the current instance when a build or startup
fails before the replacement becomes ready. The
runner forwards shutdown signals; Render allows up to 300 seconds for shutdown.
App code must drain requests on SIGTERM and keep database changes compatible with
both versions. Private services use TCP health checks, so the app must finish
initialization before it listens on `PORT`. A process that accepts TCP connections
but returns HTTP errors can still pass Render's readiness check; QM's HTTP check
cannot undo that traffic switch.

QM creates one logical Postgres database and a restricted login for each app on
the managed Postgres instance. It supplies `DATABASE_URL` at runtime. App roles
can create tables in their own database; they cannot read or change QM's data or
connect to another app database. Credentials are encrypted in QM's durable store.
The managed Postgres login must have `CREATEDB` and `CREATEROLE`. App pools should
use at most five connections because apps share the instance's connection limit.

Files use the configured S3-compatible store. QM supplies `QM_APP_STORAGE_URL`
and `QM_APP_STORAGE_TOKEN` at runtime. The app server requests a short-lived URL
for a single `GET`, `PUT`, or `DELETE`; QM fixes the bucket and app-specific key
prefix. Keep file keys and metadata in Postgres. Do not put SQLite databases,
uploads, or other durable state on the app filesystem. App storage credentials
are not part of the immutable source version or publish result.

Idle cleanup and archive suspend the app and revoke its source and storage
tokens. They retain its service, database, and objects for restore. Rollback
changes code and retains the data. Storage charges continue. To remove an app
permanently, archive it, back up its data, then remove its owned resources.

Apps fetch their selected Git commit through the existing core Git endpoint on
each startup. Their credentials permit reads of one app and are stored durably
so a core restart does not invalidate them. The runner does not receive QM
object-store credentials.

Agent sandboxes are created on demand in the Render workspace. Workflows and
Render Cron Jobs are not required; core runs the existing QM scheduler.

## Release and validation

For released images, install a CLI release that includes Render support and omit
`--repo` and `--branch` during init. Without `render.source`, the CLI uses its
released image digests. The release workflow builds and publishes the QM launcher
and app runner images, then pins them in the CLI package. MinIO uses its separate
digest-pinned image in both deployment modes. Operators do not need to build or
publish these images.

The checked-in manifest contains placeholders. It cannot deploy an image-based
stack, but Git builds do not use those standard image entries. The
[branch deployment guide](./render-branch-deploy.md) covers CLI installation,
Git builds, setup, and live checks before an upstream release.

See [Render Sandboxes](./render-sandboxes.md) for sandbox configuration and
snapshot recovery. Live acceptance must check initial setup, signed-in agent
execution, sandbox restore, core restart with an empty data directory, shared
files, a browser multipart upload, app deployment and rollback, and teardown.

## Interrupted operations

The CLI saves resource IDs after each successful creation. An interrupted run
resumes from that record. If a create request has an unknown result, the CLI
stops before sending another create. Inspect Render and recover the resource ID
in `render.resources.json` before retrying. Do not delete the record to bypass
this check; a delayed request could still create a resource.

App deployments also record pending operations in Postgres before submission.
A retry checks the recorded operation first. An unresolved create or queued
deploy can require operator recovery because Render does not expose a request
idempotency key. An app with a missing retained service or database fails restore
instead of starting with empty data. Back up app data before manual cleanup.
