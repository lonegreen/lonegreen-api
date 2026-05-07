# Stripe Webhook Local Testing

Use the same Stripe account and mode as the Checkout session you are testing.

1. Start the app:

```bash
npm start
```

2. In a second terminal, forward Stripe events to the raw webhook route:

```bash
stripe listen --forward-to localhost:4000/billing/stripe/webhook
```

3. Copy the `whsec_...` value printed by `stripe listen` into `.env` as `STRIPE_WEBHOOK_SECRET`, then restart the app.

4. Complete a real app Checkout flow. The server should log:

```text
Stripe webhook: event received
Stripe webhook: company resolution result
Stripe webhook: synced subscription
```

5. For a synthetic smoke test:

```bash
stripe trigger checkout.session.completed
```

Synthetic trigger events may not include a FairLinx `company_id` or matching `client_reference_id`, so a `COMPANY_NOT_RESOLVED` webhook retry is expected unless you override fixture metadata or test through the app Checkout flow.
