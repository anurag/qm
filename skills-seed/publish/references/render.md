# Publish an app on Render

Read this reference before you build when the `publish` tool identifies Render as
the deployment provider. The published app is a private service with no persistent
disk. QM supplies its database and file credentials at runtime. Those credentials
are not supplied to the agent computer.

## Database

Use the runtime `DATABASE_URL` with a Postgres client, such as `pg` for Node.js.
This database belongs to the app. Keep records, settings, counters, and file
metadata there. Use a connection pool with at most five connections per app
process and parameterized SQL. This leaves connection capacity for old and new
versions during a deployment. For Node.js `pg`, set `max: 5` on the pool. Do not replace
Postgres with SQLite or files when the connection is unavailable. Fail startup
with a clear error that does not include the connection string.

The runtime database URL uses the public Render Postgres endpoint with
`sslmode=verify-full`. Keep its TLS certificate and hostname checks enabled.
Do not replace its host with a private Render hostname or disable certificate
checks. QM provisions the app's database access and service outbound IP rules.
The private app network is isolated from QM's shared services and other owners.
Apps with the same owner share a private network, including code that an app
editor can publish.

Old and new app versions can run at the same time during a deployment. Use a
migration library that serializes migrations, or hold a Postgres advisory lock on
one connection while the migration runs. Release the lock on that connection.
Make schema changes compatible with both versions. Add a column before code needs
it; remove an old column only after no active version uses it. A code rollback
does not restore the database or undo a migration.

Initialize the database and complete migrations before the server listens on
`PORT`. Private service readiness uses a TCP connection, so a listening port must
mean that the app can serve requests. On `SIGTERM`, stop accepting requests, let
active requests finish within a bounded time, and close the database pool.

## Files

The server receives `QM_APP_STORAGE_URL` and `QM_APP_STORAGE_TOKEN`. To authorize
one file operation, send a server request to that URL:

```http
POST <QM_APP_STORAGE_URL>
Authorization: Bearer <QM_APP_STORAGE_TOKEN>
Content-Type: application/json

{"method":"PUT","key":"uploads/record-id/file-id"}
```

The response has `url`, `method`, and `expiresAt` fields. `expiresAt` is a Unix
timestamp in milliseconds. The URL expires after
60 seconds. Supported methods are `GET`, `PUT`, and `DELETE`. Each URL authorizes
one object key and one method; it does not grant a bucket or prefix operation.
Use the returned method to send the file request to the returned URL. For `PUT`,
send the file bytes as the request body. Request a new URL when one has expired.

Generate object keys on the server under `uploads/`. Authorize the user and the
record before issuing a signed URL. Store the key, original file name, media
type, size, and owning record in Postgres. Store the key, not the signed URL.
Confirm upload success before marking the file as available. Record a pending
upload or deletion in Postgres when retries must survive a restart. The database
and object store do not share a transaction.

The app can proxy file bytes through its server or give an authorized browser a
short-lived signed URL. Keep `DATABASE_URL` and `QM_APP_STORAGE_TOKEN` on the
server. Never send them to the browser, print them in logs, or include them in
`publish.env`. Do not put database credentials, tokens, or signed URLs in source
files. Keep uploads out of the app directory and `/tmp` as persistent storage.

## Test on the agent computer

The agent computer and the published service have separate environments.
Publishing does not supply a sandbox database or file credentials for tests.
Check the available tools with `id -u`, `command -v pg_config`, and
`pg_config --bindir`. Check that the returned directory contains `initdb`,
`postgres`, `pg_ctl`, `createuser`, and `createdb`. A Postgres client package alone is not enough.
Do not assume that Docker or a Postgres server is installed in the sandbox.

If server binaries are available, use a disposable local cluster outside the
directory you will publish. Run Postgres as a non-root user. For a non-root shell:

```sh
set -eu
QM_PG_BIN="$(pg_config --bindir)"
QM_PG_TEST_DIR="$(mktemp -d /tmp/qm-publish-pg.XXXXXX)"
"$QM_PG_BIN/initdb" -D "$QM_PG_TEST_DIR/data" -U qm_test_admin -A trust
"$QM_PG_BIN/pg_ctl" -D "$QM_PG_TEST_DIR/data" -l "$QM_PG_TEST_DIR/server.log" -o "-h 127.0.0.1 -p 55432 -k $QM_PG_TEST_DIR" -w start
"$QM_PG_BIN/createuser" -h 127.0.0.1 -p 55432 -U qm_test_admin --no-superuser --no-createdb --no-createrole qm_app_test
"$QM_PG_BIN/createdb" -h 127.0.0.1 -p 55432 -U qm_test_admin -O qm_app_test qm_app_test
```

The cluster accepts local test connections without a password. Bind only to
loopback and use only disposable data. If the shell runs as root and a `postgres`
user is installed, make that user own the temporary directory and run the server
commands with `runuser -u postgres --`. Do not run `initdb` or `postgres` as root.
If the binaries, a suitable user, or permission to install them are unavailable,
report that the real database check is blocked. Do not substitute SQLite or claim
that a mock proves the Postgres behavior.

Start the app with the `background` tool. Supply
`DATABASE_URL=postgresql://qm_app_test@127.0.0.1:55432/qm_app_test` and `PORT=8080`
for that process. Use the real database to test migrations, a write followed by a
read, concurrent app startup, restart persistence, and `SIGTERM` shutdown. Check
the page or API with `curl`. Use a local file-API stub only for tests of request
handling and expiry errors; state that this does not verify the deployed storage
service. After publishing, verify a real upload, download, and deletion through
the app before reporting that file storage works.

Stop the local app and run `pg_ctl -D <temporary-data-directory> -m fast -w stop`
as the database user when tests finish. Keep the cluster, logs, and test
configuration outside the published directory.
