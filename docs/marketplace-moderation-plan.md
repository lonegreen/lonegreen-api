# Marketplace Moderation Plan (Lightweight v1)

## Current Protections

- Existing route auth, tenant scoping, and billing guards remain unchanged.
- Marketplace mutation rate limits are active (`request create`, `offer create`, `offer accept`, `convert`).
- Abuse hard-block middleware is active for:
  - `POST /marketplace/requests`
  - `POST /marketplace/requests/:id/offers`
  - `POST /reviews`
  - `POST /conversations/:id/messages`
- Hard-block response stays:
  - `400 { "error": "Content failed safety validation" }`

## Abuse Guard Integration (v1)

`middleware/abuseGuards.js` now supports:

- `hasSuspiciousContent(value)` → hard-block threshold
- `hasBorderlineContent(value)` → soft moderation signal
- `getModerationSignals(value)` → computed indicators

Signal categories:

- hard-block:
  - obvious script payload (`<script>`, `javascript:`, inline handler patterns)
  - links above hard limit
  - content length above hard limit
- borderline:
  - repeated-word density (spam-like repetition)
  - links at the threshold
  - suspicious keyword burst
  - near length limit

## Soft Moderation Strategy

No schema changes, no manual approval gate, no queue persistence in this pass.

When payload is borderline (but not blocked):

- route sets `res.locals.moderationFlagged = true` in middleware
- success response appends:
  - `"moderation_flagged": true`

Normal content returns existing success response shape unchanged.

## Response Compatibility Notes

- Applied only on object-shaped success payloads in current routes:
  - marketplace request create
  - marketplace offer create
  - review create
  - message create
- No GET route changes.
- No raw payloads or secrets are returned.

## Future Moderation Tables (Concept)

Potential future schema (not implemented now):

- `abuse_events`:
  - actor type/id, route, reason codes, signal snapshot, timestamp
- `moderation_cases`:
  - status, severity, reviewer assignment, resolution metadata

## Moderation Queue Concept

- Queue only medium/high-risk borderline events for operator review.
- Keep high-confidence malicious payloads auto-blocked.
- Maintain reversible decisions and auditability.

## Report System Concept

- Add user/company reporting endpoints for:
  - abusive request
  - abusive offer
  - abusive review
  - abusive message
- Feed reports into moderation cases with deduping.

## Trust Scoring Concept

Future score inputs (no implementation yet):

- account age / verified identity
- prior abuse_event frequency
- sustained rate-limit hits
- cross-route abuse correlation
- successful transaction history

## Escalation Rules (Future)

- Level 0: soft-flag only (`moderation_flagged`)
- Level 1: telemetry + case creation for repeated soft flags
- Level 2: temporary stricter limits for repeated offenders
- Level 3: operator-enforced restrictions (manual decision)

## Non-Goals in v1

- No moderation table persistence.
- No admin moderation UI.
- No change to marketplace conversion/acceptance business flow.
- No heavy third-party moderation dependency.

