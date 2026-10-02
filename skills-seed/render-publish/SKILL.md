---
name: render-publish
description: Publish an app when DEPLOY_PROVIDER is render. Use Render Postgres for records and scoped object storage for files.
---

# Publish on Render

Use this skill with the publish skill when the deployment target is Render.

Published apps run as diskless Render services in separate network-isolated environments within the QM project. Each update starts a new process before Render stops the old process. Start the HTTP server on `process.env.PORT` or the equivalent environment value. Do not set a fixed port. The gateway checks a credential on HTTPS requests from QM. Other apps cannot connect to the internal app port.

Use `DATABASE_URL` for app records. Each app has its own PostgreSQL database and login. The login cannot connect to the QM core database or other app databases. Use a bounded connection pool with at most 10 connections per process. Use database transactions for changes to related records. Run compatible schema changes before the HTTP server starts. A rollback restores code, so schema changes must work with both the previous and new code.

Use an S3 client for files. Read `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, and `S3_PREFIX` from the environment. Enable path-style requests. Prepend `S3_PREFIX` to every object key and list prefix. The credentials allow access only to that app's prefix. Do not use the root bucket as a list prefix. QM sets `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` to avoid optional checksum trailers on streaming uploads. Keep this setting. For AWS SDK JavaScript, set `endpoint`, `region`, `forcePathStyle: true`, and `requestChecksumCalculation: "WHEN_REQUIRED"` on `S3Client`.

Treat the local filesystem as temporary. Do not use SQLite, a local uploads directory, or `/data` for retained data. Store generated files in object storage before you return their links. Keep credentials on the server. Do not send database or storage credentials to a browser.

Apps use an immutable QM Git commit for source. Keep dependency installation in the entrypoint when the app needs packages. Bind the HTTP port only after initialization succeeds. Handle SIGTERM to stop new work and finish current requests.

Update an app by its existing name. Archive suspends its service and disables its storage credential. Restore uses the retained database, object prefix, and service. These operations do not delete app data. Verify a record and an object after create, update, rollback, and archive/restore.
