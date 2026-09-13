# Deploy the Render provider branch

Install the CLI from this branch and let Render build QM from its GitHub
repository. The normal release workflow runs only on upstream `main`; the
published npm release must not be assumed to contain this provider.

This path does not need image publication, edits to `cli/manifest.json`, or a
local Docker engine. Render builds the built-in QM services and app runner from
their Dockerfiles in the configured repository. MinIO uses a digest-pinned image.
The CLI provisions them through the Render API without a Blueprint. When MinIO
is ready, the CLI starts a one-off job that uses the same image to create the
storage bucket and scoped identity.

## Requirements

- Node 24.18.0 and Git.
- A GitHub repository and branch that contain the Render provider code.
- A Render API key with access to the target workspace and Render Sandboxes.
- An OpenAI API key and the email address of the first QM administrator.

Use an HTTPS GitHub repository URL. Public repositories do not need a Render
GitHub connection. For a private repository, connect its GitHub account to Render
and grant Render access to that repository before deployment.

## Install the branch CLI

Replace `OWNER/REPOSITORY` and `YOUR_BRANCH` with the repository and branch to
build. Run these commands in Bash. Use a fresh clone with no private deployment
layer.

```bash
export QM_REPO_URL="https://github.com/OWNER/REPOSITORY.git"
export QM_BRANCH="YOUR_BRANCH"
git clone --branch "$QM_BRANCH" --single-branch "$QM_REPO_URL" qm-render
cd qm-render
export QM_SOURCE_DIR="$PWD"
export QM_RELEASE_DIR="$QM_SOURCE_DIR/.generated/render-release"
mkdir -p "$QM_RELEASE_DIR"
cd "$QM_SOURCE_DIR/cli"
npm ci
npm pack --pack-destination "$QM_RELEASE_DIR"
export QM_CLI_TARBALL="$QM_RELEASE_DIR/yc-software-qm-$(node -p 'require("./package.json").version').tgz"
```

Keep the packed CLI with the deployment so later commands use the same provider
code. The configured Git branch controls the code that Render builds and can
move independently of this local CLI package.

## Create an administrator test deployment

```bash
mkdir -p "$QM_SOURCE_DIR/../qm-render-live"
cd "$QM_SOURCE_DIR/../qm-render-live"
mkdir -p .generated/cli
cp "$QM_CLI_TARBALL" .generated/cli/qm-render.tgz
npm init -y
npm install --save-exact ./.generated/cli/qm-render.tgz
npm exec qm -- init . --org qm-render-live --target render --model-provider openai \
  --repo "$QM_REPO_URL" --branch "$QM_BRANCH"
```

Use a new, unique `org` value if `qm-render-live` is already in use. `--repo` and
`--branch` must be supplied together and only work with `--target render`. Init
validates them and writes `render.source.repo` and `render.source.branch` before
it creates secrets. Edit `qm.config.jsonc`:

- Replace `render.workspaceId` with your workspace ID, such as `tea-...`.
- Keep `render.region` as `oregon`, or select your preferred supported region.
- Keep `render.storage.type` as `minio`. This creates bundled MinIO and a disk.
- For the first test, remove `slack` from `services` and remove `env.slack`. Keep
  `core`, `web-ui`, `admin`, `portal`, and `auth`.
- Keep `modelProvider` as `openai` and `env.core.HARNESS` as `pi`.

Keep `render.source` set to the repository and branch selected above. Render
builds all standard QM services from that source. MinIO uses its pinned image. An
`imageOverrides` entry still selects that service's published image. Plugins
still require published images; local source plugins are not supported by this
path. Render Sandboxes use Render's base image, so no separate `sandbox-base`
image is needed.

The generated plans are paid plans. `qm plan` lists the resources and plans before
creation. Core and object storage each use one instance in this first version.

```bash
npm exec qm -- setup
```

Choose No when asked to set up sign-in email. Enter your Render API key, OpenAI API
key, and `you@example.com:org_admin` for `ADMIN_GRANTS`. Setup generates the internal
secrets. Bundled MinIO does not require AWS credentials. Keep `.env` private.

## Deploy and check

```bash
npm exec qm -- check
npm exec qm -- doctor
npm exec qm -- plan
npm exec qm -- up
npm exec qm -- status
npm exec qm -- check --live
npm exec qm -- conformance
npm exec qm -- admin-login
```

`qm up` creates or updates a project named `<org>-qm` and a `production` environment
containing Postgres, core, private web UI, public portal, and MinIO.
It writes the assigned URLs into `qm.config.jsonc` and stores resource IDs in
`render.resources.json`. Keep this file: later commands use it to update the same
resources. Do not run two CLI operations concurrently in this deployment directory.

`check --live` creates a bounded one-off job to check the live core session and
database path, in addition to the health and signed configuration checks. Open the
private, single-use link from `admin-login` within five minutes. Then submit a task
that runs a shell command and writes a file. Confirm that the task uses a Render
Sandbox, the file can be reopened, and an uploaded file can be downloaded. Test app
deployment, app restore, and persistence across a core restart before using the
deployment for important data.

For later changes, update the config and run `qm plan` and `qm up` again. Each
`qm up` builds the configured Git branch, even when its name has not changed.
Automatic Git deploys are disabled, so pushing the branch alone does not deploy
it. If the CLI code changes, pull the branch, repack the CLI, and reinstall it
from the new tarball before running the command. App deployment and restore also
build the app runner from the configured repository and branch.

```bash
npm exec qm -- logs core --tail 100
npm exec qm -- down
```

`down` retains the database and MinIO data, and storage charges continue. Use
`down --purge` only to delete the hosted stack and its stored data. Runtime apps and
sandboxes have their own lifecycle and must be removed through QM. The project and
environment remain after purge.

The first live deployment is still unverified. App authors must be trusted to
access peer services on the shared Render private network; the current provider
does not isolate app authors from each other.

## Use released images instead

After a CLI release includes Render support, a new deployment can use the
standard release images:

```bash
mkdir qm-render-release
cd qm-render-release
npm init -y
npm install --save-exact @yc-software/qm@VERSION_WITH_RENDER_SUPPORT
npm exec qm -- init . --org qm-render-release --target render --model-provider openai
```

Complete the same configuration, setup, and checks above. Omit `--repo` and
`--branch`; without `render.source`, the CLI selects its released image digests.
The QM release workflow builds and publishes those images, so operators do not
need to publish them. The checked-in placeholder manifest cannot run this image
path. Git builds work without replacing its standard image entries.

To convert an existing image-based deployment to Git builds, add the following
fields to its existing `render` object and run `qm plan` and `qm up`:

```json
{
  "source": {
    "repo": "https://github.com/OWNER/REPOSITORY.git",
    "branch": "YOUR_BRANCH"
  }
}
```

Keep `render.resources.json`. Conversion updates the existing services and
preserves their IDs and disks. Existing `imageOverrides` and plugin image
selections remain in effect.
