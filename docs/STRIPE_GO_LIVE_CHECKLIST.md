# Stripe Go-Live Checklist

## Keys And Mode

- Replace test keys with live `STRIPE_SECRET_KEY`
- Replace test Price IDs with live Price IDs
- Set live `STRIPE_WEBHOOK_SECRET` from the live webhook endpoint
- Keep test and live webhook secrets separate
- Never log or commit Stripe keys

## Webhook Endpoint

- Endpoint path: `/billing/stripe/webhook`
- Events enabled:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
  - `invoice.finalization_failed`
  - `customer.subscription.trial_will_end`
- Confirm the endpoint returns `2xx` for successful sync
- Confirm unresolved company or failed sync returns retryable `5xx`

## Customer Portal And Prices

- Customer Portal is configured in the same Stripe mode as the keys
- Billing recovery uses the customer portal when a Stripe customer exists
- Price mapping is live and documented:
  - Basic -> `starter`
  - Pro -> `pro`
  - Business -> `enterprise`
- Optional yearly price IDs are either configured for every tier or yearly billing is treated as unavailable

## Subscription Lifecycle

- Successful invoice sets billing active
- Failed invoice sets `past_due` and grace period fields
- Grace evaluation suspends only after `billing_grace_until`
- Canceled subscription sets `cancelled`
- No Stripe event deletes company workflow data

## Launch Verification

- Complete one live low-risk Checkout flow
- Confirm `companies.stripe_customer_id` is set
- Confirm `stripe_subscription_id`, status, price, and plan key are set
- Confirm `stripe_processed_events` records webhook events
- Confirm dashboard billing status updates after webhook delivery
