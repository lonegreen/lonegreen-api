# Backup Automation Plan (Phase 12)

- New read-only endpoint: `GET /platform/backups/status` (platform owner only).
- Scope: readiness validation only; no backup job execution and no restore mutation.
- Validation checks:
  - `BACKUP_AUTOMATION_ENABLED`
  - `BACKUP_STORAGE`
  - `BACKUP_SCHEDULE_CRON`
  - `BACKUP_RETENTION_DAYS`
  - `BACKUP_RESTORE_MANIFEST_PATH`
- Output is warning-driven and intended for operational review before automation rollout.
