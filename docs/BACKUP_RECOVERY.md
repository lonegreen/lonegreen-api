# Backup & Recovery

FairLinx uses local PostgreSQL tools for backups and restores. The scripts read `DATABASE_URL` from the environment and do not store secrets in code.

## Local Backup

Create a backup with:

```bash
npm run backup:db
```

This runs:

```bash
node scripts/backup-db.js
```

The script creates `backups/` when needed and writes a file named:

```text
backups/lonegreen-backup-YYYY-MM-DD-HH-mm-ss.dump
```

The backup uses a non-destructive custom-format dump:

```bash
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" -f backups/file.dump
```

`pg_dump` must be installed locally and available on `PATH`.

### Rotation, retention, and logging (Phase 13)

- After each successful dump, older files matching `lonegreen-backup-*.dump` may be removed:
  - **Count cap:** `BACKUP_KEEP_COUNT` (default `30`) — keeps the newest N dumps after age cleanup.
  - **Age cap:** `BACKUP_MAX_AGE_DAYS` (default `45`) — removes dumps older than this many days, but never deletes the single newest remaining file.
- Optional directory override: `BACKUP_DIR` (absolute or relative to process cwd).
- Append-only JSON lines are written to `backups/backup.log` (`backup_start`, `backup_success`, `backup_failed`).

### Optional automated schedule (in-process)

If `DATABASE_BACKUP_CRON` is set to a valid [node-cron](https://github.com/node-cron/node-cron) expression (for example `15 4 * * *` for 04:15 daily), the app scheduler runs `runBackup({ trigger: "scheduler" })` on that cadence when the server is running. This uses the same local `pg_dump` as the CLI. On ephemeral hosts, remember dumps on local disk may not survive redeploys—copy artifacts to durable storage.

### Manual HTTP trigger (non-production maintenance only)

When `ALLOW_MAINTENANCE_ROUTES=true` (disallowed in production by `config/env.js`), you can trigger a backup without shell access:

```http
POST /setup-db/backup
```

Response JSON includes `path`, `size_bytes`, `duration_ms`, and `rotation` metadata. This still requires `DATABASE_URL` and `pg_dump` on the server PATH.

## Restore validation (dry-run only)

**No automatic restore** — validation checks files only; the database is not modified.

Validate a custom-format dump (exists, non-trivial size, `pg_restore -l` can read the TOC):

```bash
npm run backup:validate -- backups/lonegreen-backup-2026-05-03-12-00-00.dump
```

Machine-readable output:

```bash
npm run backup:validate -- backups/your-file.dump --json
```

Each run appends a JSON line to `backups/restore-validation.log`. For a real restore after validation, continue to use `npm run restore:db` with `--yes` as documented below.

## Local Restore

Restore is destructive. It requires an explicit `--yes` flag.

```bash
npm run restore:db -- backups/lonegreen-backup-2026-05-01-10-30-00.dump --yes
```

This runs:

```bash
node scripts/restore-db.js backups/lonegreen-backup-2026-05-01-10-30-00.dump --yes
```

The restore uses:

```bash
pg_restore --clean --no-owner --dbname="$DATABASE_URL" backups/file.dump
```

`pg_restore` must be installed locally and available on `PATH`.

## Render Notes

- Use the Render External Database URL when running backup or restore from your local machine.
- Use the Render Internal Database URL only from inside Render services.
- Never paste `DATABASE_URL` into code, docs commits, screenshots, or issue comments.
- Keep production restore commands slow and deliberate. Verify the target database before running restore.

## Pre-Migration Backup Checklist

1. Confirm `DATABASE_URL` points to the intended database.
2. Run `npm run backup:db`.
3. Confirm the `.dump` file exists under `backups/`.
4. Store a copy somewhere secure if this is a production backup.
5. Record backup filename, time, app version/commit, and database target.
6. Run the migration only after the backup succeeds.

## Pre-Deploy Backup Checklist

1. Confirm no previous restore or migration is in progress.
2. Confirm `NODE_ENV=production` on the target service.
3. Confirm `DATABASE_URL` points to the production database.
4. Run `npm run backup:db` from a trusted machine with `pg_dump` installed.
5. Copy the `.dump` file to secure storage outside the app server.
6. Verify the file size is non-zero and timestamped.
7. Keep the backup until the deploy has been verified and the next scheduled backup succeeds.

## Emergency Restore Checklist

1. Stop application writes if possible.
2. Confirm the restore target `DATABASE_URL`.
3. Confirm the backup file path.
4. Run:

```bash
npm run restore:db -- backups/file.dump --yes
```

5. Run:

```bash
node db/setup.js
```

6. Start the app.
7. Verify login, dashboard, clients, jobs, invoices, subscriptions, and company isolation.
8. Preserve restore logs if anything fails.

## Storage And Git Safety

- Backups are stored locally in `backups/`.
- Do not commit database dumps.
- Do not commit `.env`.
- `.gitignore` should include:
  - `backups/`
  - `*.dump`
  - `.env`
