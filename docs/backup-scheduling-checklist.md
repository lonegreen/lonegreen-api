# Backup Scheduling Checklist

- Confirm backup automation flag and schedule cron are configured.
- Confirm retention policy values are configured and within acceptable minimums.
- Confirm restore drill target and manifest are configured.
- Confirm `GET /platform/backups/status` and `GET /platform/backups/readiness` return expected readiness state.
- Confirm readiness is audit-only (no backup execution from readiness routes).
- Confirm restore drill readiness is green before launch sign-off.
