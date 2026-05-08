# FairLinx Notification Center Plan (Future-Safe)

> Scope note: planning document only. No full notification subsystem is implemented in this phase.

## Notification Types
- Marketplace: new offer, accepted offer, request status updates.
- Support: ticket created, reply added, status/priority changes.
- Verification: status changes, review-required alerts.
- Moderation: report filed, report action updates.
- Disputes: dispute opened, status updates, resolution updates.
- Billing (non-payment mutation notices): status warnings and account notices.

## Recipients
- Customers
- Company users (role-aware)
- Platform owners (operations alerts)

## Trigger Model
- Event-driven server-side triggers from existing workflows.
- Use existing route/service events where possible.
- Avoid duplicate notifications by idempotency keys.

## Read/Unread Model
- Notification rows include read state (`read_at` nullable pattern).
- Support per-user unread counts.
- Keep immutable event payload + rendered message snapshot.

## Email vs In-App Boundaries
- **In-app**: operational awareness and activity history.
- **Email**: critical alerts, time-sensitive workflow updates.
- User-level preferences to decide channel mix (future phase).

## Marketplace Notifications
- Customer: new offers, accepted/cancelled outcomes.
- Company: new eligible opportunities, customer actions.
- Keep message payloads concise and role-scoped.

## Support/Dispute Notifications
- Support: new replies and status transitions.
- Disputes: opening, waiting-state transitions, resolution/closure.
- Platform owner receives escalation notifications for urgent cases.

## Future Migration Plan
1. Add notification schema and read indexes.
2. Add event emitters from existing route handlers.
3. Add platform visibility and diagnostics.
4. Add customer/company preference controls.
5. Add launch-gate checks for notification integrity.

## Phase 11 Foundation Status
- Notifications table + indexes are provisioned by migration `058_notifications_reputation_invites.sql`.
- Service helpers exist for create/list/mark-read/unread-count with tenant/customer scope checks.
- Read/update routes are available for company users and customers.
- No background workers or external delivery channels are required in this phase.
