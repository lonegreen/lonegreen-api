# FairLinx Launch Readiness Checklist

## 1) Environment Variables
- [ ] Production `.env` values reviewed for API, DB, auth, upload, and billing keys.
- [ ] `NODE_ENV=production` in deployment target.
- [ ] Stripe keys/webhook secret present and validated in non-test context.
- [ ] Upload/storage env vars set (R2/S3/local mode explicitly known).
- [ ] Allowed origins and security headers reviewed.

## 2) Database Migrations
- [ ] All migrations applied in order on target environment.
- [ ] No pending migration drift from local/staging to production.
- [ ] Migration logs archived with timestamp and operator.
- [ ] Post-migration smoke read checks completed.

## 3) Auth And Roles
- [ ] Platform owner role access verified.
- [ ] Company role boundaries (`owner/admin/manager/worker`) verified.
- [ ] Customer auth boundaries verified for customer-only routes.
- [ ] No mixed-boundary token paths accepted.

## 4) Tenant Isolation
- [ ] Company-scoped routes block cross-company reads/writes.
- [ ] Customer-scoped routes block cross-account actions.
- [ ] Platform-only routes require platform owner.
- [ ] Support/moderation/dispute routes validated for ownership checks.

## 5) Billing And Stripe Readiness
- [ ] Billing lifecycle states validated (`trial/active/past_due/...`).
- [ ] Stripe checkout, portal, webhook health checks pass.
- [ ] Billing mutation blocking rules tested for suspended/grace-expired tenants.
- [ ] No manual payment record mutation outside approved workflows.

## 6) Upload And Storage Readiness
- [ ] Upload mode confirmed (`local` vs object storage).
- [ ] Public URL policy and path safety rules validated.
- [ ] Attachment/document upload limits and mime checks verified.
- [ ] Ephemeral storage warning reviewed before go-live.

## 7) Support Workflow
- [ ] Ticket lifecycle and transition rules verified.
- [ ] Priority updates and platform assignment path verified.
- [ ] Internal notes are platform-only.
- [ ] Attachment rules and ticket ownership checks validated.

## 8) Verification Workflow
- [ ] Verification queue and status updates tested by platform owner.
- [ ] Public exposure excludes internal verification-only fields.
- [ ] Discover/profile trust badge rendering validated from backend fields.

## 9) Moderation Workflow
- [ ] Abuse report intake endpoints tested across supported targets.
- [ ] Moderation status/priority update flow validated.
- [ ] No destructive content delete behavior introduced.

## 10) Dispute Workflow
- [ ] Marketplace and support dispute open paths validated.
- [ ] Platform dispute status/priority/resolution workflow validated.
- [ ] Dispute workflow confirms no automatic refund/reversal behavior.

## 11) Backup Readiness
- [ ] Backup strategy reviewed against RPO/RTO targets.
- [ ] Restore drill run and verification checklist completed.
- [ ] Backup/restore owners and escalation path documented.

## 12) Monitoring And Alerts
- [ ] App, DB, queue, scheduler, upload readiness checks monitored.
- [ ] Error log review cadence established.
- [ ] Alert channels and on-call rotation confirmed.

## 13) Domain And SSL Readiness
- [ ] DNS cutover plan reviewed.
- [ ] TLS certificate issuance/renewal validated.
- [ ] Redirect and CORS host config verified.

## 14) Founding Partner Launch Readiness
- [ ] Initial partner list approved.
- [ ] Onboarding script and profile setup flow validated.
- [ ] Verification + support expectations communicated.

## 15) Final Go/No-Go
- [ ] All critical checklist items complete.
- [ ] Open risks documented with owners and mitigation dates.
- [ ] Incident response contacts active.
- [ ] Formal launch approval captured.

## 16) Phase 11 Operational Hardening
- [ ] Notifications foundation migration applied (`notifications`, `company_invites`, `reputation_score` fields).
- [ ] Customer + staff notification read endpoints validated with scoped access.
- [ ] Founding partner invite management validated (create/list/cancel, hashed tokens only).
- [ ] Billing lifecycle audit endpoint validated as read-only and warning-only.
