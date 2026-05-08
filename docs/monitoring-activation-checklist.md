# Monitoring Activation Checklist

- Confirm alert channel readiness (`MONITORING_ALERT_CHANNEL` or `MONITORING_ALERT_EMAIL`).
- Confirm log retention readiness (`LOG_RETENTION_DAYS`).
- Confirm uptime monitor readiness (`UPTIME_MONITOR_URL`).
- Confirm `GET /platform/monitoring` and `GET /platform/monitoring/readiness` return expected payloads.
- Confirm no external monitoring service calls are executed by readiness checks.
- Confirm blocker count is zero before launch sign-off.
