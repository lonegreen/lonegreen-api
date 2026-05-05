# Render Deployment Guide

## Service Settings

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- App port: the server reads `process.env.PORT` and falls back to `4000` locally.

Render sets `NODE_ENV=production` for Node services at runtime and provides `PORT` with a default of `10000` unless you override it. Keep this app's start command as `npm start`.

## Required Render Environment Variables

Set these in Render Dashboard -> Web Service -> Environment. Do not commit real values.

```text
NODE_ENV=production
DATABASE_URL=<Render Postgres internal database URL>
JWT_SECRET=<32+ character random secret>
ALLOWED_ORIGINS=https://your-service.onrender.com
PUBLIC_APP_URL=https://your-service.onrender.com
RUN_STARTUP_MIGRATIONS=true
BILLING_LIFECYCLE_AUTOMATION=true
STRIPE_SECRET_KEY=<sk_live_... or sk_test_... for staging>
STRIPE_WEBHOOK_SECRET=<whsec_... from the matching webhook endpoint>
STRIPE_PRICE_BASIC=<monthly Basic price id>
STRIPE_PRICE_PRO=<monthly Pro price id>
STRIPE_PRICE_BUSINESS=<monthly Business price id>
STRIPE_PRICE_BASIC_YEARLY=<optional yearly Basic price id>
STRIPE_PRICE_PRO_YEARLY=<optional yearly Pro price id>
STRIPE_PRICE_BUSINESS_YEARLY=<optional yearly Business price id>
EMAIL_USER=<only if email is enabled>
EMAIL_PASS=<only if email is enabled>
ALLOW_MAINTENANCE_ROUTES=false
ALLOW_SEED_ADMIN=false
SUBSCRIPTION_INTERVAL_ENGINE=false
```

## Migrations

Preferred paid-service pattern:

```bash
node db/setup.js
```

Use it as a Render pre-deploy command when available. If no pre-deploy command is available, set `RUN_STARTUP_MIGRATIONS=true` for the deployment window, deploy once, confirm `/health` reports migrations `current`, then set `RUN_STARTUP_MIGRATIONS=false` for routine deploys.

## Deploy Checklist

1. Create Render Postgres and use the internal `DATABASE_URL` from the same region as the web service.
2. Add environment variables in Render and save with deploy.
3. Confirm Build Command is `npm install`.
4. Confirm Start Command is `npm start`.
5. Deploy.
6. Open `https://your-service.onrender.com/health`.
7. Confirm `database.status=ok`, `migrations.status=current`, and `environment.status=ready`.
8. Open `/health.html` as owner/admin and confirm no launch blockers are displayed.

## Render-Specific Notes

- `server.js` sets `trust proxy` to `1`, which is appropriate behind Render's proxy.
- `db/pool.js` enables PostgreSQL SSL for Render-style hosts or `sslmode=require`.
- Local uploads are stored under `public/uploads`; on Render this is ephemeral unless replaced with persistent/external storage.
- Optional integrations can be absent in development, but production readiness will flag missing Stripe/email launch configuration.

## Rollback

1. In Render, redeploy the previous successful deploy from the Events page.
2. Restore the previous environment variable snapshot if env changes caused the issue.
3. If a migration caused data corruption, restore the last verified database backup and rerun smoke tests.
4. Disable `RUN_STARTUP_MIGRATIONS` after rollback unless intentionally running migrations.
5. Recheck `/health` and Stripe webhook delivery status.
