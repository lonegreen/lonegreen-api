# Operations: what to watch after launch

This document describes **safe, non-secret** signals for operators. It does not replace Stripe Dashboard, database backups, or incident runbooks.

## Health endpoint

`GET /health` returns aggregated readiness (database, migrations, billing counts, Stripe config flags, email, uploads, queue, scheduler, environment). Use it for load balancers and uptime checks.

### Operational block (`operational`)

The payload includes a small **`operational`** object (no secrets):

- **`subscription_interval_poll_enabled`** — Whether the hourly `setInterval` subscription engine is on (`SUBSCRIPTION_INTERVAL_ENGINE`). In production this should usually be **false** so only the cron/queue path runs subscription processing.
- **`subscription_processing_cron_utc`** — Nominal schedule for the scheduler task (daily subscription processing).
- **`upload_ephemeral_warning`** — True when uploads use local disk on a host that looks ephemeral (e.g. common PaaS env vars). Plan for object storage if customer files must survive redeploys.

## Logs to monitor

All of these go through the project logger (secrets and tokens are redacted in structured fields).

| Signal | Log message / context | What it means |
|--------|------------------------|----------------|
| Stripe webhook handler failure | `STRIPE_WEBHOOK_HANDLER_FAILURE` with `event_id`, `event_type`, `code` | Event was accepted but processing threw; event claim may be rolled back for retry. Check Stripe Dashboard → Webhooks and application logs together. |
| Stripe webhook route failure | `STRIPE_WEBHOOK_ROUTE_FAILURE` with `webhook_error_code` | Signature, body, configuration, or sync errors at the HTTP layer. |
| Billing mutation blocked | `BILLING_MUTATION_BLOCKED` with `company_id`, `http_status`, `action_required`, `billing_status`, `path`, `method` | A staff user hit a mutating API while company billing blocks writes. Expected when suspended or past due; spikes may indicate billing or UX issues. |
| Scheduler | `SCHEDULER TASK ERROR` / `SCHEDULER LOOP ERROR` | Cron task failed; includes task name. |
| Uploads (boot) | Logger warning from upload readiness when ephemeral production storage is detected | Files under local `/public/uploads` may not persist across deploys. |

## Stripe Dashboard

- **Webhook delivery** — Failed deliveries and response codes; correlate with `STRIPE_WEBHOOK_*` logs by time.
- **Subscriptions / invoices** — Source of truth for payment state; compare with internal `companies` billing fields after incidents.

## Database integrity

Periodically run the read-only audit (see `docs/INTEGRITY_AUDIT.md`):

```bash
node scripts/integrity-audit.js
```

## Smoke tests

See `docs/SMOKE_TEST.md` for local/staging HTTP checks after deploys.
