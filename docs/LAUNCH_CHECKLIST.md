# Launch Checklist

## Ready Before Launch

- Production database backup completed and stored securely
- `/health` returns healthy
- Migrations are current
- Stripe live Checkout and webhooks are configured
- Stripe Customer Portal is configured in the same mode as the live keys
- Billing lifecycle automation is enabled
- Email password reset delivery is configured
- Platform owner account exists and can access platform dashboard
- Tenant owner/admin/manager/worker smoke tests pass
- CORS is restricted to production origins
- Upload file validation works for allowed and rejected files

## Launch Day

- Freeze schema changes during launch window
- Deploy production build
- Run smoke tests
- Complete one billing flow in the intended Stripe mode
- Confirm `/billing/me` reconciles plan, Stripe customer, subscription, billing status, and current period dates
- Monitor logs for webhook sync errors
- Monitor queue and scheduler status
- Confirm no secrets appear in logs

## After Launch

- Review `/health` daily during the first launch week
- Monitor Stripe failed webhook attempts
- Monitor companies in `past_due` or `suspended`
- Confirm backups are being created on schedule
- Rotate any credential that was exposed during setup or debugging
