# FairLinx Backup And Restore Playbook

## Backup Expectations (Neon/Postgres)
- Use managed provider backup capabilities as primary safety net.
- Define and review retention windows and restore points.
- Periodically verify backup restorability with test restores.
- Track backup ownership and escalation contacts.

## Manual Backup Examples (`pg_dump`)

```bash
pg_dump "$DATABASE_URL" --format=custom --file="fairlinx_backup_YYYYMMDD.dump"
```

```bash
pg_dump "$DATABASE_URL" --format=plain --no-owner --no-privileges > "fairlinx_backup_YYYYMMDD.sql"
```

## Restore Checklist
1. Confirm restore target (staging vs production) and approval.
2. Snapshot current state before restore when possible.
3. Restore backup to isolated environment first.
4. Validate schema presence and key workflow tables.
5. Run health/readiness checks and smoke tests.
6. Validate tenant isolation and role boundaries post-restore.
7. Promote restored environment only after approval.

## Migration Rollback Caution
- Avoid ad-hoc destructive migration rollback in production.
- Prefer restore-to-known-good snapshot over manual down-migrations.
- If rollback is unavoidable, require peer review and written runbook.

## Verification After Restore
- Auth and role access checks.
- Billing read checks and Stripe webhook processing sanity.
- Marketplace/support/verification/moderation/dispute list/read paths.
- Upload URL and attachment access validation.

## RPO/RTO Notes
- **RPO**: Maximum tolerable data loss window (define per environment).
- **RTO**: Maximum tolerable recovery duration (define per incident class).
- Review targets quarterly and after major architecture changes.

## Local Backup Safety Rules
- Never commit dumps to source control.
- Encrypt sensitive backups at rest.
- Limit backup file permissions.
- Delete temporary local backups after verified transfer.
