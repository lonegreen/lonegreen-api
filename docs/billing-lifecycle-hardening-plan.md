# Billing Lifecycle Hardening Plan (No Stripe Logic Changes)

## Lifecycle State Expectations
- **trial / trialing**: normal product access with trial-end monitoring.
- **active**: full access within plan limits.
- **past_due / unpaid**: grace behavior applies; risk warnings active.
- **canceled / cancelled**: no new paid lifecycle operations.
- **suspended**: strict mutation blocking outside approved exceptions.

## Grace Period Expectations
- Grace windows must be explicit and observable.
- Expired grace should trigger consistent mutation blocks.
- Platform dashboards should surface grace-expiry risk clearly.

## Mutation Blocking Rules
- Enforce billing gates for staff-side mutations that create liabilities.
- Preserve exceptions needed for account recovery (e.g., support access).
- Avoid hidden bypasses in new routes/features.

## Platform Override Rules
- Platform owner override paths must be explicit and auditable.
- Override actions should not mutate payment history records.
- Override use should be logged with reason and operator.

## Webhook Recovery Checklist
1. Validate webhook endpoint health/signature checks.
2. Confirm queue and scheduler state.
3. Reconcile subscription status drift safely.
4. Verify no duplicate financial side effects.
5. Re-run readiness and smoke checks.

## Launch-Gate Checks Needed Later
- Stronger checks for billing transition consistency.
- Drift checks for billing status vs effective feature gates.
- Operational check for stale past_due accounts.
- Alerting checks for repeated webhook failure patterns.

## Phase 11 Audit Surface
- Added read-only endpoint `GET /platform/billing-lifecycle/audit`.
- Endpoint returns warning-oriented summaries only (status counts, grace window counts, missing Stripe IDs).
- Endpoint performs no Stripe API calls and no company mutations.
