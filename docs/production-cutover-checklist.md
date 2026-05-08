# Production Cutover Checklist

## Environment Verification
- Verify `NODE_ENV=production`.
- Verify platform, app, and storage environment variables are present.

## Secrets Verification
- Confirm Stripe, JWT, DB, and email secrets are populated and non-placeholder.
- Confirm no test-only secrets are active in production.

## Domain Verification
- Confirm production domain DNS records resolve correctly.
- Confirm canonical domain redirects are configured.

## SSL Verification
- Confirm certificates are valid and auto-renewing.
- Confirm HTTPS-only traffic policy is enforced.

## Storage Activation
- Confirm storage driver env passes activation readiness checks.
- Confirm public URL base and delete ownership checks are valid.

## Billing Verification
- Confirm billing lifecycle audit endpoint reports expected counts.
- Confirm no mutation-blocking policy changes were introduced.

## Webhook Verification
- Confirm Stripe webhook secret is present and endpoint reachable.
- Confirm webhook idempotency logs are visible.

## Backup Verification
- Confirm backup schedule, retention, and restore drill readiness pass.
- Confirm backup target and restore manifest paths are configured.

## Monitoring Verification
- Confirm alert channel readiness is green.
- Confirm log retention and uptime monitor readiness are green.

## Rollback Checklist
- Keep previous release artifact available.
- Keep DB rollback guidance and migration audit notes available.
- Revert app version if smoke checks fail post-cutover.

## Smoke Tests
- Health live/ready endpoints.
- Staff login, customer login, company dashboard load.
- Marketplace browse/request baseline.
- Invoice and payment read paths.
