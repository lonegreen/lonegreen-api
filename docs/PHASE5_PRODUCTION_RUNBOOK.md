# Phase 5 Production Runbook

This runbook is for production readiness checks before starting Marketplace work. It does not include secrets, credentials, or production data.

## Deploy Checklist

1. Confirm the branch contains only reviewed Phase 1-5 changes.
2. Confirm `NODE_ENV=production`.
3. Confirm `ALLOW_MAINTENANCE_ROUTES=false` and `ALLOW_SEED_ADMIN=false`.
4. Confirm `RUN_STARTUP_MIGRATIONS=false` unless this is an intentional migration deploy window.
5. Run:

```bash
npm test
npm run smoke:test
npm run integrity:audit -- --strict
```

6. Deploy.
7. Check `/health`, `/health/live`, and `/health/ready`.
8. Monitor logs for `STARTUP_ERROR`, `POSTGRES_POOL_ERROR`, `HEALTH_READINESS_NOT_READY`, `SCHEDULER TASK ERROR`, and `SUBSCRIPTION_ENGINE_RUN_ERROR`.

## Neon Backup And Restore

1. Before migrations or risky deploys, create a Neon backup or snapshot.
2. Run the app backup command from a trusted machine if `pg_dump` is available:

```bash
npm run backup:db
npm run backup:validate -- backups/your-backup.dump
```

3. Store production backups outside the app server.
4. Restore only during an approved incident window.
5. After restore, run:

```bash
node db/setup.js
npm run integrity:audit -- --strict
npm run smoke:test
```

## Migration Checklist

1. Confirm the database target is the intended Neon database.
2. Confirm integrity audit is clean before applying migrations.
3. Prefer explicit migration runs with `node db/setup.js`.
4. Keep `RUN_STARTUP_MIGRATIONS=false` during normal production boots.
5. Recheck `/health/ready` after migrations.

## Smoke Test Checklist

Default smoke tests are safe and credential-free:

```bash
npm run smoke:test
```

Authenticated probes are optional and require explicit env vars:

```bash
SMOKE_USERNAME=... SMOKE_PASSWORD=... npm run smoke:test
```

The smoke test checks app health, readiness, login error shape, and `/billing/me` only when credentials are provided.

## Rollback Basics

1. Stop the rollout and preserve logs.
2. Redeploy the last known good app version.
3. Restore the previous env snapshot.
4. If data is affected, restore from a verified Neon/app backup.
5. Re-run `/health/ready`, smoke tests, and integrity audit.

## Before Marketplace

1. `/health/ready` must be healthy.
2. Integrity audit must be clean.
3. Scheduler status should show `subscription_processing` registered.
4. Queue status should show `durability=in_memory_best_effort`; do not rely on it for critical Marketplace payments.
5. Billing and Stripe webhooks should show no unresolved production failures.
