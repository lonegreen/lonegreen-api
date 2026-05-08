# Abuse Detection Plan (Lightweight Phase)

## Current Controls (Audited)

### Marketplace
- `POST /marketplace/requests` has customer-side rate limiting.
- `POST /marketplace/requests/:id/offers` has company-side rate limiting.
- `POST /marketplace/offers/:id/accept` has customer-side rate limiting.
- `POST /marketplace/requests/:id/convert` has company-side rate limiting.
- Existing auth/role/billing checks are in place.

### Reviews
- `POST /reviews` validates ownership/completed-job relationship and rating bounds.
- No dedicated content-abuse filter existed before this pass.

### Messages
- `POST /conversations/:id/messages` validates participant access and non-empty text.
- No dedicated anti-spam content screen existed before this pass.

### Customer/Auth flows
- Auth/customer login/reset endpoints are protected by route-level rate limits in `routes/auth.js` (`authAttemptLimiter`, `passwordResetLimiter`, `passwordResetSubmitLimiter`).

## Gaps Identified

1. No shared lightweight content screening for obvious script payloads.
2. No conservative link-spam guard on core user-generated text fields.
3. No consistent rejection response for suspicious payload patterns across marketplace/messages/reviews.
4. No DB-backed abuse event ledger yet (by design for this phase).

## Lightweight Rules Added (This Phase)

Implemented in `middleware/abuseGuards.js` and applied only to required mutation routes:

- Reject obvious script payload patterns (e.g. `<script>`, `javascript:`, `onerror=`, `onload=`).
- Reject excessive links in one payload (default threshold tuned conservatively).
- Reject extremely long text payloads per context (conservative max lengths).
- Return consistent `400`:
  - `{ "error": "Content failed safety validation" }`

## Routes Protected in This Phase

- `POST /marketplace/requests`
- `POST /marketplace/requests/:id/offers`
- `POST /reviews`
- `POST /conversations/:id/messages`

No GET routes were modified.

## Conservative Threshold Notes

- Marketplace title: short cap.
- Marketplace description/message: moderate cap.
- Message text: higher cap to preserve normal conversation use.
- Review text: moderate cap.
- Link threshold allows normal usage but blocks obvious link flooding.

## False-Positive Strategy

1. Keep patterns narrow and conservative.
2. Start with script/link/length checks only (no NLP/profanity model).
3. Monitor 400 rejection rate by route in logs.
4. Adjust limits incrementally if real users are impacted.

## Future Stronger Abuse Layer (Planned, Not Implemented)

### DB-backed `abuse_events` table idea
- Capture event type, actor, route, payload hash, reason code, timestamp.
- Supports trends, escalations, and safer tuning.

### Moderation queue idea
- Queue suspicious-but-not-certain content for human review.
- Keep hard-block only for high-confidence malicious patterns.

## Rollout Phases

1. **Phase 1 (current):** lightweight in-process guards + existing rate limits.
2. **Phase 2:** add read-only abuse telemetry counters/log aggregation.
3. **Phase 3:** add DB-backed abuse event persistence + operator dashboard.
4. **Phase 4:** optional moderation queue and risk scoring.

## Explicit Non-Goals in This Pass

- No schema changes.
- No third-party paid moderation dependency.
- No marketplace business logic changes.
- No moderation states/workflows added.
- No blocking based on user identity reputation yet.

