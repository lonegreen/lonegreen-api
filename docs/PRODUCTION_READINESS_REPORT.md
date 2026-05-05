# Production Readiness Report

## Ready

- Auth roles and platform-owner protections are in place.
- Tenant company isolation is consistently used across core tenant data routes.
- Worker upload access checks the job company and worker assignment.
- Stripe Checkout, webhooks, subscription sync, and payment automation are implemented.
- Billing warning mode remains enabled; automation does not delete company data.
- Health checks report database, migrations, billing, Stripe, email, uploads, queue, scheduler, and environment readiness.
- Backup and restore helpers exist through `npm run backup:db` and `npm run restore:db`.
- Uploads validate extension, MIME type, file count, filename safety, and size.

## Optional Before Scale

- Move uploads from local disk to durable object storage.
- Add external uptime monitoring against `/health`.
- Add centralized log aggregation.
- Add scheduled production backup automation outside the app process.
- Add Stripe Customer Portal for self-service payment method updates.

## Monitor After Launch

- Stripe webhook delivery failures and retries.
- Companies in `past_due`, `suspended`, or `cancelled`.
- Queue `failed` count.
- Scheduler `last_error`.
- Database connection pool errors.
- Password reset email delivery.
- Upload storage growth and host storage persistence.
