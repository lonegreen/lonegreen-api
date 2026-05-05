# Go-Live Runbook

## Preflight

1. Freeze schema changes for the launch window.
2. Create and verify a database backup:

```bash
npm run backup:db
npm run backup:validate
```

3. Run local syntax checks:

```bash
node -c server.js
node -c config/env.js
node -c db/pool.js
node -c db/setup.js
node -c services/productionReadiness.js
node -c services/stripeService.js
node -c services/stripeWebhookService.js
node -c services/billingService.js
node -c routes/billing.js
node -c routes/stripeWebhook.js
```

4. Confirm `.env.example` contains no real secrets.

## Render Deployment

1. Set Render build command to `npm install`.
2. Set Render start command to `npm start`.
3. Add the required env vars from `docs/RENDER_DEPLOYMENT_GUIDE.md`.
4. Run migrations by pre-deploy command `node db/setup.js` or set `RUN_STARTUP_MIGRATIONS=true` for the deploy window.
5. Deploy.
6. Check:

```bash
curl https://your-service.onrender.com/health
```

Expected launch state:

- `ok=true`
- `database.status=ok`
- `migrations.status=current`
- `stripe.status=configured`
- `environment.status=ready`

## Stripe Configuration

1. Use live-mode Stripe keys and live-mode Price IDs together.
2. Configure webhook endpoint:

```text
https://your-service.onrender.com/billing/stripe/webhook
```

3. Enable:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.payment_succeeded
invoice.payment_failed
invoice.finalization_failed
customer.subscription.trial_will_end
```

4. Configure Customer Portal in live mode.

## Stripe Test Pass

1. In staging/test mode, create Checkout session.
2. Complete Checkout with a Stripe test card.
3. Confirm `/billing/me` becomes active or trialing.
4. Trigger `invoice.payment_failed`.
5. Confirm grace period and recovery state.
6. Trigger `invoice.payment_succeeded`.
7. Confirm access restored.
8. Schedule cancellation at period end.
9. Reactivate.
10. Downgrade with usage above limit and confirm block.

## Live Switch

1. Replace test Stripe env vars with live values.
2. Save and deploy Render service.
3. Confirm `/health` after deploy.
4. Complete one low-risk live subscription.
5. Confirm the webhook succeeded and local billing fields are reconciled.
6. Monitor logs for `STRIPE_WEBHOOK_ROUTE_FAILURE`, `STRIPE_WEBHOOK_HANDLER_FAILURE`, `BILLING_MUTATION_BLOCKED`, and scheduler errors.

## Rollback

1. Redeploy previous successful Render deploy.
2. Restore previous env variable snapshot.
3. Disable `RUN_STARTUP_MIGRATIONS` unless a migration rerun is intentional.
4. If data changed incorrectly, restore the verified database backup.
5. In Stripe Workbench, retry failed webhook events after the app is healthy.
6. Recheck `/health`, `/billing/me`, and the dashboard billing panel.
