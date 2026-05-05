# Security Hardening Audit

## Auth Guards

- `platform_owner` is isolated to platform routes through `requirePlatformOwner`.
- Regular owner/admin/manager hierarchy uses `requireMinimumRole`.
- Workers remain scoped by `worker_id` where worker job access is supported.
- Customer portal tokens are rejected by the main app auth middleware.
- Maintenance routes remain disabled unless `ALLOW_MAINTENANCE_ROUTES=true`.

## Company Isolation

- Tenant data routes should keep `WHERE company_id = req.user.company_id`.
- Joins should include matching company IDs on both joined tables.
- Platform-owner routes are separate from tenant routes and require `platform_owner`.
- Upload photo access checks job `company_id` before writing a `job_photos` row.

## Rate Limits

- Global API limit: 300 requests per 15 minutes.
- Login limit: 20 attempts per 15 minutes.
- Password reset limit: 5 attempts per 15 minutes.
- Stripe Checkout limit: 30 attempts per 15 minutes.
- Upload limit: 60 attempts per 15 minutes.

## CORS

- Production requires `ALLOWED_ORIGINS`.
- Production CORS allows only configured origins.
- Requests without an `Origin` header remain allowed for same-origin and server-to-server traffic.

## Logging

- Shared logger redacts common secrets and database URLs.
- Health/readiness returns booleans, counts, and missing variable names only.
- Webhook logs include event IDs and resolution status, not secret headers or raw payloads.
