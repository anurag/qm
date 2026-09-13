# `qm`

The standalone deployment CLI for QM. The normative directory schema,
security guarantees, target behavior, and lifecycle are in
[`docs/deploy-directory.md`](../docs/deploy-directory.md). `qm init` materializes
the agent-consumable package runbook into the deployment repository.

```bash
npm exec --yes --package=@yc-software/qm@latest -- \
  qm init . --org acme --target aws
npm install
npm exec qm -- check
npm exec qm -- infra render
npm exec qm -- doctor
npm exec qm -- infra build-image
npm exec qm -- plan
npm exec qm -- up --yes
npm exec qm -- check --live
```

This package is published to npm as `@yc-software/qm`, with npm provenance attesting the
building workflow. A release is one dispatch of `.github/workflows/release.yml` from
`main`: it signs and pushes the first-party images, publishes the package pinning their
digests, and then tags `v<version>` and creates the GitHub release with the resolved
digests attached. Each release picks its own version: a patch bump past the latest released version, or
`cli/package.json`'s version when a PR raised it higher (for a minor or major bump); a
tag that already exists stops the release rather than moving. The checked-in image
manifest contains placeholders that the release workflow replaces with image
digests. Render Git builds do not use these standard image entries. The
packed-artifact test exercises the consumer path locally.

The CLI deploys long-running QM services; it is not the runtime. Docker runs
them locally, Fly runs them as Fly apps with Fly Machines for agent computers, and AWS
runs digest-pinned ARM64 tasks on ECS Fargate with Lambda MicroVM agent computers.
Render runs QM services, Render Sandboxes, and published apps. To build from Git,
install the branch CLI and use `qm init --target render --repo <HTTPS-GitHub-URL>
--branch <name>`. The flags must be supplied together. Render builds the selected
branch without local Docker, image publication, or manifest changes. See the
[Render branch deployment guide](../docs/render-branch-deploy.md) for installation
and setup. Omit these flags to use standard images from a release with Render
support.

## Deployment directory

```text
qm.config.jsonc
package.json
package-lock.json
deployment.md
.codex/skills/deploy-qm/
.env.example
.env
slack-app-manifest.yml
slack-sso-manifest.yml
sandbox/
  tools/<id>/tool.json
  tools/<id>/<binary>
  skills/<id>/SKILL.md
  Dockerfile
plugins/<name>/Dockerfile
infra/
```

`qm.config.jsonc` is committed and contains no secret values. `.env` is ignored.
`package.json` pins the CLI package at the exact version that scaffolded the
directory — `contract: 1` is only the compatibility floor — so every checkout
resolves the same interpreter; upgrade the pin deliberately.
`cd` into it and the DEPLOY commands act on it; `--config` / `--env-file` / `--sandbox-dir` relocate
a piece (e.g. several deployments sharing one `sandbox/`). `check` validates the config,
computed secret names, tools, skills, and plugins without network access; `up`, `plan`, and
`sandbox build` run the same checks first. `doctor` verifies external prerequisites read-only.
`plan` renders the deployment; AWS mutation requires `up --yes`.

For a single-host Docker deployment, `sandbox.backend: "local"` runs each agent
computer in its own container. `qm up` builds the local runtime from the CLI's
pinned sandbox base, mounts the host Docker socket into trusted core, and connects
core to each sandbox's private network. An explicit `sandbox.image` uses that
runnable local image instead.

On AWS, `up` verifies under the deploy lease that RDS point-in-time recovery
is current (its `LatestRestorableTime` must lag by at most
`QM_AWS_DB_MAX_RESTORE_LAG_MS`, default 10 minutes) and records the pre-deploy
timestamp in the deployment manifest it precedes. `rollback` restores code and
configuration only, so it prints that timestamp as the matching data restore
point (`aws rds restore-db-instance-to-point-in-time`);
`aws.predeployDbSnapshot: false` opts out.

`sandbox build` is a local validation build of the sandbox layer image. At runtime
sandboxes boot their platform's stock image; tools and skills arrive through the
deployment-layer sync, which every ordinary `up` performs.

Auto uses its built-in model classifier unless `qm.config.jsonc` declares one
`securityScreen` proxy with a provider label, HTTPS endpoint, and `shadow` or
`enforce` rollout. The proxy token is routed separately through
`secretEnv.core.SECURITY_SCREEN_PROXY_TOKEN`.

## Commands

```text
init [dir] [--org id] [--target docker|fly|aws|render]
     [--repo <HTTPS-GitHub-URL> --branch <name>]
check [--json] [--live]
doctor
infra render|build-image|delete-image|delete-task-definitions
conformance [dir] [--static]
plan
up [--yes] [--build-from[=repo]] [--image-label label]
slack render
outputs [--json]
admin-login [--email admin@example.com]
proof scope-key <scope-id>
secrets push [--from file]
status
logs [service] [-f] [--tail n]
down [--purge]
rollback [--to revision-or-sha]
sandbox build [--from image] [--tag tag] [--dry-run]
```

## Administrator login without email

After deployment, run `qm admin-login` to print a single-use login URL valid for
five minutes. Open it and confirm the displayed administrator email. The command
uses the deployment's existing `PORTAL_SESSION_SECRET` and the email in
`ADMIN_GRANTS`; if several admins are configured, select one with `--email`.
QM checks that the selected account still has `org_admin` access when the link
is redeemed. The command creates no account or role grant.

Run it from the deployment directory with its `.env`, or use `--config` and
`--env-file`. Inside a running deployment without a config file, supply
`PORTAL_PUBLIC_URL`, `PORTAL_SESSION_SECRET`, and `ADMIN_GRANTS` through its
environment. The CLI prints only the URL, which is a temporary login credential;
do not publish it or put it in shared logs.

`qm setup` offers email setup separately. Skip it to use administrator login
without Resend or SMTP. To enable ordinary email login later, rerun `qm setup`
and configure the selected transport's complete credential set and sender,
then push secrets and redeploy. Missing email credentials disable email sign-in;
QM and `qm admin-login` remain available, even if a sender is still configured.

Deployment commands accept `--config`, `--env-file`, and `--sandbox-dir`;
`admin-login` uses only `--config` and `--env-file`. `dev` remains
the contributor worktree loop and is separate from the portable deployment contract.

## Package contract

The `@yc-software/qm/contract` export is the supported programmatic surface for
conformance tests. It exposes the contract version, parsing/rendering
functions, and provider ids without registering arbitrary runtime plugins.
Incompatible directory
changes increment the contract major; optional fields may be added within a
major.

The package calls Docker with Buildx, Flyctl, the AWS CLI, and Git for the
relevant targets. Terraform runs against the AWS module generated by `init`.
The Render target calls the Render API directly.

## Render

Run `qm init --org acme --target render`, set `render.workspaceId`, and configure
portal access. Run `qm setup` for Render, model, administrator, and email settings,
then `qm check`, `qm plan`, and `qm up`. The CLI creates or updates one Render
project with a `production` environment containing core, web UI, portal, Postgres,
and bundled MinIO. A Blueprint and a Git repository are not required.

MinIO uses a digest-pinned image. The CLI starts a one-off job on MinIO to create
a private bucket and a scoped identity, then supplies that identity to core.
No AWS account is required. To use an existing MinIO deployment or another
S3-compatible store, set `render.storage` to
`{"type":"external"}` and configure its bucket and endpoint in `env.core`. Setup
then requests that store's credentials. Existing Render configs without the
storage field keep external mode.

Core has one instance without a persistent disk. Postgres and object storage
hold durable state. MinIO has its own persistent disk. The core creates Render
Sandboxes when an agent needs one. The CLI supplies `RENDER_PROJECT_ID` to core.
Published apps for each owner scope use a separate isolated environment in that
project, with private app services and a trusted gateway that runs stock Caddy.
Core applies QM access checks before it routes requests through that gateway.
Each app has a distinct gateway token. The gateway checks the app ID and token,
then removes both headers before it forwards the request to the app.
Anyone with write access to an app can run code on its owner's private network
and reach that owner's other apps. Treat all app editors in an owner scope as
trusted with every app in that scope. Read-only shares still use core access
checks. Ownership transfers retain the previous owner's write grant.

Published app services have no persistent disk. QM creates a restricted Postgres
database for each app and supplies file access through the configured object
store. Core provisions databases through the internal connection. Apps use the
public database endpoint with TLS certificate and hostname checks. QM adds the
reported app-service outbound IP ranges to the database access list and retains existing
entries; it does not add a public catch-all rule. The CLI supplies the database
resource ID and credential-free app endpoint to core.

Each active owner adds one public gateway web service and one environment. The
gateway has no disk; route changes redeploy it and can interrupt active streams.
Core stores runtime app and gateway state in Postgres. These resources are not
listed in `render.resources.json` or removed by CLI teardown. Suspending the
last active app also suspends its gateway and retains the environment. Read the
generated Render deployment reference for storage details, lifecycle commands,
and image release requirements.

`qm down` stops if a published app still runs in any project environment. Archive
or stop apps first. `qm down --purge` stops if any app service remains, including
a suspended service. Back up app data and remove these services before purge.
