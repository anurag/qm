# Render deployment

Use this after the choices and billing confirmation in `deployment.md`.

## Preflight

Require a Render API key for the workspace that owns the deployment and a
GitHub repository and branch that local Git and Render can read. Render builds
every service from that source; no local Docker or image publication is
involved, and the deployment needs no Blueprint. Put the key in the generated
`.env` as `RENDER_API_KEY` and keep that file private; Render stores the
runtime values.

```bash
npm exec qm -- init . --org <slug> --target render --repo <url> --branch <name>
```

## Configuration

Set these keys in `qm.config.jsonc`:

- `render.workspaceId`: the authorized test or production workspace
  (`tea-...` or `usr-...`).
- `render.source.repo` and `render.source.branch`: initialization requires
  `--repo` and `--branch`. The repository must contain the Render build and startup
  files. Each `qm up` resolves the branch to one commit and pins
  every build to it. Automatic deploys are off so `qm up` controls the update
  order.
- `render.region`: the region for the core services, Postgres, and MinIO.
  `render.appRegion` optionally selects the region for new published apps; it
  defaults to `render.region`, and each app keeps the region selected at
  creation.
- `render.corePlan`, `render.servicePlan`, and `render.storage.plan`: Render
  compute plan IDs such as `2c-4g`. Retired names such as `standard` are
  rejected with the current ID. `render.corePlan` defaults to `2c-4g`, which fits the
  default 16 run workers; a smaller core plan needs a lower `env.core.WORKERS`.
- `render.postgresPlan` and `render.postgresDiskSizeGB`: passed through to
  Render Postgres. `render.storage.diskSizeGB` sizes the MinIO disk, the only
  attached service disk.
- `env.core.SHUTDOWN_DRAIN_MS` (default 10000): how long a previous core
  instance gives in-flight turns after SIGTERM. Render ends that instance 300
  seconds after SIGTERM, so keep the value below 290000.
- `publicUrl` and `apiUrl`: the assigned `onrender.com` URLs work without DNS
  changes. To use custom domains, set both to HTTPS origins with different
  hostnames and run `qm up`. The CLI adds each hostname to the portal (or the web
  UI when there is no portal) and to core, and prints the DNS record to create.
  Until both domains are verified, sandboxes and published apps cannot reach
  core and `qm check --live` fails. Run `qm slack render` after changing
  `publicUrl`. A hostname removed from the config stays on its service until it
  is removed in the Render dashboard.

## Deploy

```bash
npm exec qm -- setup .
npm exec qm -- slack render
npm exec qm -- check
npm exec qm -- secrets push
npm exec qm -- plan
npm exec qm -- up
npm exec qm -- doctor
npm exec qm -- check --live
```

`qm up` creates one project with one production environment for core, web UI,
portal, Render Postgres, and bundled MinIO, initializes MinIO before it deploys
core, applies registered database migrations, and uploads the deployment layer.
Each published app gets a network-isolated environment in the same project.
Native Render Sandboxes are workspace resources; do not create a second project
for them. The CLI records resource IDs in `render.resources.json`; retain this
file so updates act on the same resources. `qm up`, `qm down`, `qm rollback`,
and `qm secrets push` take `.render.lock` in the deployment directory. A second
such command waits up to 30 seconds for the holder and otherwise stops with an
error. A retry after an interruption cancels any build still running and
deploys the current commit. `check --live` proves service health and durable
object storage.

After the first successful deployment, rerun `npm exec qm -- up` and confirm it
reconciles the same resources.

## Agent-computer proof

Native Render Sandboxes have no operator shell, so read the proof file from the
durable home archive that core writes to MinIO at each checkpoint. The archive
of a scope is the object `render-home/<url-encoded scope id>.tar` in the
`qm-storage` bucket. A checkpoint runs at turn end when the home changed, at
most once per five minutes, and the reaper covers a throttled one within about
ten minutes, so wait for one before you read. Use the MinIO service's
onrender.com URL, the `qm-storage` access key, and the `QM_STORAGE_SECRET_KEY`
value from the MinIO service's environment in the Render dashboard:

```bash
scope_id='personal:<exact-admin-principal>'
key="render-home/$(node -p 'encodeURIComponent(process.argv[1])' "$scope_id").tar"
mc alias set qm https://<prefix>-minio.onrender.com qm-storage "$QM_STORAGE_SECRET_KEY"
mc cat "qm/qm-storage/$key" | tar -xOf - ./workspace/qm-computer-proof.txt
```

Require the output to match the UUID created in the browser. A missing or
ambiguous scope, archive, or file is a failed proof.

Routine operations:

```bash
npm exec qm -- status
npm exec qm -- logs core --follow
npm exec qm -- rollback --to <release-label-commit-or-deploy-id>
npm exec qm -- down
```

`rollback` restores the previous successful service builds, retains the current
operator environment values, and does not reverse database migrations. The CLI
retains the last ten releases in `render.resources.json`; `qm status` lists
them. `down` suspends the services; Postgres and the MinIO disk keep running and
continue to incur charges. Archive published apps before stopping their parent
deployment. `down --purge` deletes the recorded QM services, Postgres, and MinIO
disk together with app databases and stored objects; it retains the project and
does not retire workspace sandboxes. Use it only with explicit authorization to
delete the deployment and its stored data. Do not change unrelated
infrastructure, DNS, or Cloudflare rules.
