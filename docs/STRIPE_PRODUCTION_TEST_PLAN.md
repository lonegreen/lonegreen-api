# Stripe Production Test Plan

## Mode Safety

Use one Stripe mode per environment. A test `STRIPE_SECRET_KEY`, test `STRIPE_WEBHOOK_SECRET`, and test `price_` IDs must stay together. A live `STRIPE_SECRET_KEY`, live webhook secret, and live `price_` IDs must stay together.

Before live mode:

```bash
node -c services/stripeService.js
node -c services/stripeWebhookService.js
```

## Price Mapping

- Basic -> internal plan `starter`
- Pro -> internal plan `pro`
- Business -> internal plan `enterprise`
- Monthly prices use `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`
- Yearly prices use `STRIPE_PRICE_BASIC_YEARLY`, `STRIPE_PRICE_PRO_YEARLY`, `STRIPE_PRICE_BUSINESS_YEARLY`

## Webhook Endpoint

Configure this exact endpoint in Stripe Workbench:

```text
https://your-service.onrender.com/billing/stripe/webhook
```

Enable these events:

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

The app also preserves the backward-compatible `/billing/webhook` route, but production Stripe should point to `/billing/stripe/webhook`.

## Local Test Mode Checklist

1. Start the app:

```bash
npm start
```

2. Forward Stripe test events:

```bash
stripe listen --forward-to localhost:4000/billing/stripe/webhook
```

3. Use the printed `whsec_...` as `STRIPE_WEBHOOK_SECRET` for local testing.
4. Create a Checkout session from the app billing screen.
5. Complete Checkout with a Stripe test card.
6. Confirm `GET /billing/me` shows active/trial billing state and Stripe IDs.
7. Trigger or simulate `invoice.payment_failed`.
8. Confirm grace period and recovery state appear in `GET /billing/me`.
9. Trigger or simulate `invoice.payment_succeeded`.
10. Confirm access is restored and failure fields clear.
11. Cancel at period end and confirm access remains until `current_period_end`.
12. Reactivate and confirm `cancel_at_period_end=false`.
13. Attempt a downgrade below current usage and confirm the API blocks it.

## Live Mode Go-Live Checklist

1. Create live Products and Prices for Basic, Pro, and Business.
2. Configure the Stripe Customer Portal in live mode.
3. Set Render Stripe env vars with live-mode values only.
4. Configure the live webhook endpoint and copy its live `whsec_...`.
5. Deploy and confirm `/health` shows Stripe configured.
6. Complete one low-risk live Checkout using a real payment method.
7. Confirm Stripe Dashboard shows the customer and subscription.
8. Confirm `GET /billing/me` shows `stripe_customer_id`, `stripe_subscription_id`, plan, billing cycle, and period dates.
9. Confirm webhook delivery is successful in Stripe Workbench.
10. Void/refund the live test payment only if appropriate for the account's launch process.

## Customer Portal

Owner/admin users open the portal through `/billing/create-portal-session`, `/billing/portal`, or recovery flow `/billing/recovery`. The portal uses the company's stored Stripe customer ID and returns to the dashboard. If Stripe or the customer ID is missing, the API returns a safe JSON error rather than exposing provider internals.
