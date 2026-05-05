# Production Deployment Checklist

## Environment

- `NODE_ENV=production`
- `DATABASE_URL` set to the production managed PostgreSQL URL
- `JWT_SECRET` is at least 32 characters and stored only in the host secret manager
- `ALLOWED_ORIGINS` contains only trusted production origins
- `PUBLIC_APP_URL` points to the canonical production app URL
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are production-mode values
- `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_BUSINESS` are production-mode monthly Price IDs
- Optional yearly Stripe Price IDs are configured together or left blank together
- `BILLING_LIFECYCLE_AUTOMATION=true`
- `EMAIL_USER` and `EMAIL_PASS` are configured for password reset delivery
- `ALLOW_MAINTENANCE_ROUTES=false`
- `ALLOW_SEED_ADMIN=false`
- `RUN_STARTUP_MIGRATIONS=true` for a controlled startup migration deploy, or use Render pre-deploy command `node db/setup.js`

## Pre-Deploy

- Run `npm run backup:db`
- Store the backup outside the app server
- Run `node db/setup.js` against staging first
- Run `node --check server.js`
- Confirm `/health` is healthy in staging
- Confirm Stripe webhooks are pointed to `/billing/stripe/webhook`
- Confirm Stripe webhook events include payment failures, successful payments, subscription updates/deletions, invoice finalization failures, and trial-ending notices
- Confirm upload storage is acceptable for production or externalized before relying on uploaded files

## Deploy

- Deploy the application build
- Run migrations explicitly if production startup migrations are disabled
- Start the app with `npm start`
- Check `/health`
- Confirm logs do not contain secrets
- Confirm CORS accepts only configured origins

## Post-Deploy Smoke Test

- Log in as owner/admin
- Log in as worker and confirm worker-scoped data only
- Open dashboard billing panel
- Open platform dashboard as `platform_owner`
- Create a test client/job/invoice in a non-production tenant or staging
- Confirm upload validation rejects unsupported files
- Confirm Stripe test mode in staging or live mode in production as appropriate
