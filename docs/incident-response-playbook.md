# FairLinx Incident Response Playbook

## Severity Levels
- **SEV-1**: Full outage, critical data exposure risk, or auth boundary failure.
- **SEV-2**: Major feature degradation (billing, marketplace matching, support disruption).
- **SEV-3**: Partial degradation with workaround.
- **SEV-4**: Minor defect, no immediate customer harm.

## Response Principles
- Stabilize first, diagnose second, optimize third.
- Use least-risk rollback path.
- Preserve forensic evidence (logs, timestamps, affected IDs).

## Auth Incident Response
1. Restrict blast radius (disable affected surface if needed).
2. Verify token boundary behavior and role checks.
3. Rotate secrets only if compromise suspected.
4. Audit recent auth-related deploys/config changes.
5. Confirm restored login and authorization behavior via smoke checks.

## Payment Incident Response
1. Freeze manual intervention that could duplicate financial effects.
2. Validate webhook processing health and queue state.
3. Confirm invoice/payment integrity checks still pass.
4. Coordinate with billing owners before retries/backfills.
5. Resume normal flow only after reconciliation checks.

## Marketplace Abuse Incident Response
1. Use moderation controls to contain harmful content/activity.
2. Preserve evidence (report IDs, target IDs, actor IDs).
3. Apply status updates through moderation workflow (no destructive deletes).
4. Escalate repeated patterns to platform owner review.

## Data Isolation Incident Response
1. Treat as SEV-1 by default.
2. Disable affected endpoints/routes where practical.
3. Verify tenant filters and ownership checks on impacted paths.
4. Audit query scoping and role middleware behavior.
5. Perform targeted validation before re-enable.

## Downtime Incident Response
1. Check health/readiness status (DB, queue, scheduler, uploads).
2. Validate infra dependencies and recent deploy timeline.
3. Roll back to last known good version when needed.
4. Run post-recovery smoke suite before public all-clear.

## Rollback Steps (General)
1. Identify exact release window and change set.
2. Roll back app deploy to last stable artifact.
3. Do not run destructive DB rollback in incident heat.
4. Validate app health and critical user journeys.
5. Document rollback timestamp and operator.

## Communication Templates

### Internal (Initial)
`Incident declared: <SEV>. Scope: <affected systems>. Commander: <name>. Next update in 15 minutes.`

### Customer-Facing (Active)
`We are investigating a service issue affecting <feature>. We have identified the scope and are actively restoring full functionality.`

### Customer-Facing (Resolved)
`The issue affecting <feature> has been resolved. We are monitoring stability and performing a post-incident review.`

## Post-Incident Review Checklist
- [ ] Timeline reconstructed (detection, mitigation, recovery).
- [ ] Root cause and contributing factors documented.
- [ ] Customer and business impact quantified.
- [ ] Corrective actions assigned with owners/dates.
- [ ] Launch-gate/readiness checks updated if gaps found.
