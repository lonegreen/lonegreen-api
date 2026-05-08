# Reputation Scoring Plan (Phase 12)

- Foundation service: `services/reputationService.js`.
- Factors included:
  - review average
  - review volume
  - response rate
  - dispute ratio
  - verification status
  - support issue ratio
- Safe refresh path: company-scoped endpoint `POST /companies/reputation/refresh`.
- Persistence:
  - updates `companies.reputation_score`
  - updates `companies.reputation_updated_at`
  - writes audit snapshots to `reputation_score_audits`.
- No fake defaults and no looped recalculation jobs in this phase.
