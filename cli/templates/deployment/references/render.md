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
- Render Postgres with external access disabled.
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
pending operations, but no credentials.

Published apps use private services with a 1 GB disk at `/data` by default. Idle
cleanup and archive suspend them and revoke source access while retaining data.
Storage charges continue. For permanent removal, archive the app, back up its
data, then delete its owned service in Render. The shared private network does
not enforce QM access checks between apps: app code can reach peer service
ports. As with Fly, app authors must be trusted to access the deployment network.

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
