# Group 6C Payment Automation Testing

Use Stripe test mode and the same account as the app Checkout keys.

## Failed Payment

1. Start the app and Stripe CLI listener:

```bash
npm start
stripe listen --forward-to localhost:4000/billing/stripe/webhook
```

2. Use a Stripe failed-card test payment method during Checkout or on a renewal invoice.

Expected webhook flow:

- `invoice.payment_failed`
- company resolves by subscription metadata or customer fallback
- company `billing_status` becomes `past_due`
- `billing_last_payment_failed_at` is set
- `billing_grace_until` is set to now plus `BILLING_GRACE_PERIOD_DAYS`
- `billing_failure_reason` is set
- `billing_suspended_at` stays unchanged

## Successful Recovery

Use a successful Stripe test card and pay/retry the invoice.

Expected webhook flow:

- `invoice.payment_succeeded`
- company `billing_status` becomes `active`
- `billing_last_payment_succeeded_at` is set
- `billing_grace_until`, `billing_failure_reason`, and `billing_suspended_at` are cleared

## Cancellation

Cancel the subscription in Stripe test mode.

Expected webhook flow:

- `customer.subscription.deleted` or `customer.subscription.updated` with `status=canceled`
- company `billing_status` becomes `cancelled`
- `billing_cancelled_at` is set
- company, client, job, invoice, subscription, and workflow data remains intact

## Grace Evaluation

Set a past-due company with `billing_grace_until` in the past, then run the platform owner action:

```text
POST /platform/billing/evaluate-suspensions
```

Expected database result:

- `billing_status` becomes `suspended`
- `billing_suspended_at` is set
- no company data is deleted or archived

Inspect these fields on `companies`:

```sql
SELECT id, billing_status, billing_grace_until,
       billing_last_payment_failed_at, billing_last_payment_succeeded_at,
       billing_suspended_at, billing_cancelled_at, billing_failure_reason
FROM companies
ORDER BY id DESC;
```
