# Core DB Foreign Key Hardening Plan (Audit-Only)

## Scope

This pass is audit + migration planning only.

- No schema changes applied.
- No application code changes applied.
- No migrations created in this pass.

## Current State Summary

From migration audit (`db/migrations/*.sql`), legacy core tables were created without explicit foreign keys for key relationship columns.

Expected core links currently missing as DB-enforced FKs:

- `users.company_id -> companies.id`
- `clients.company_id -> companies.id`
- `jobs.company_id -> companies.id`
- `jobs.client_id -> clients.id`
- `jobs.worker_id -> workers.id`
- `estimates.company_id -> companies.id`
- `estimates.client_id -> clients.id`
- `invoices.company_id -> companies.id`
- `invoices.client_id -> clients.id`
- `invoices.job_id -> jobs.id`
- `payments.invoice_id -> invoices.id`
- `subscriptions.company_id -> companies.id`
- `subscriptions.client_id -> clients.id`
- `subscriptions.worker_id -> workers.id`

Notes:

- Newer feature tables (marketplace/reviews/favorites/etc.) already include FK constraints in many places.
- Existing `scripts/integrity-audit.js` already checks many orphan/mismatch patterns, but there is no dedicated FK preflight script focused on the core FK rollout set.
- `scripts/integrity-repair.js` is not present.

## FK Matrix (Current vs Target)

| Table | Column | Nullable now | Existing FK | Target FK | Recommended ON DELETE | Rationale |
|---|---|---:|---|---|---|---|
| users | company_id | yes | no | yes | `SET NULL` | Preserve platform users/history if company deleted |
| clients | company_id | yes | no | yes | `RESTRICT` | Prevent deleting tenant with live client records |
| jobs | company_id | yes | no | yes | `RESTRICT` | Jobs are operational/financial records |
| jobs | client_id | yes | no | yes | `SET NULL` | Historical jobs may outlive deleted/merged clients |
| jobs | worker_id | yes | no | yes | `SET NULL` | Worker reassignment and lifecycle flexibility |
| estimates | company_id | yes | no | yes | `RESTRICT` | Quote/lead records are business history |
| estimates | client_id | yes | no | yes | `SET NULL` | Leads may exist before/without stable client linkage |
| invoices | company_id | no | no | yes | `RESTRICT` | Financial integrity; do not cascade-delete invoices |
| invoices | client_id | no | no | yes | `RESTRICT` | Invoices require accountable customer relation |
| invoices | job_id | yes | no | yes | `SET NULL` | Job can be absent while invoice remains authoritative |
| payments | invoice_id | no | no | yes | `RESTRICT` | Avoid deleting invoice when payments exist |
| subscriptions | company_id | yes | no | yes | `RESTRICT` | Recurring billing/ops state must remain consistent |
| subscriptions | client_id | yes | no | yes | `SET NULL` | Operational continuity during client cleanup |
| subscriptions | worker_id | yes | no | yes | `SET NULL` | Worker turnover should not delete subscriptions |

## Dangerous Orphan Risks to Preflight

High-priority orphan checks before any FK migration:

1. `users.company_id` points to missing `companies`.
2. `clients.company_id` points to missing `companies`.
3. `jobs.company_id` points to missing `companies`.
4. `jobs.client_id` points to missing `clients`.
5. `jobs.worker_id` points to missing `workers`.
6. `estimates.company_id` points to missing `companies`.
7. `estimates.client_id` points to missing `clients`.
8. `invoices.company_id` points to missing `companies`.
9. `invoices.client_id` points to missing `clients`.
10. `invoices.job_id` points to missing `jobs`.
11. `payments.invoice_id` points to missing `invoices`.
12. `subscriptions.company_id` points to missing `companies`.
13. `subscriptions.client_id` points to missing `clients`.
14. `subscriptions.worker_id` points to missing `workers`.

## Preflight SQL (Read-Only)

Use `scripts/fk-preflight-audit.js` (added in this pass), or run equivalent SQL counts directly.

Example pattern:

```sql
SELECT COUNT(*) AS missing_refs
FROM jobs j
WHERE j.client_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = j.client_id);
```

## Repair Order (Before FK Add)

Recommended repair sequence to minimize cascading failures:

1. `companies` parent integrity (base tenant rows).
2. `users` / `clients` / `workers` company linkage cleanup.
3. `jobs` and `subscriptions` dependent references (`client_id`, `worker_id`, `company_id`).
4. `estimates` alignment to client/company.
5. `invoices` linkage to company/client/job.
6. `payments` linkage to invoices last.

## Migration Order (Future FK Rollout)

When preflight returns zero blocking rows (or accepted nullability repairs complete):

1. Add company-level FKs first:
   - `users.company_id`
   - `clients.company_id`
   - `jobs.company_id`
   - `estimates.company_id`
   - `invoices.company_id`
   - `subscriptions.company_id`
2. Add entity relationship FKs:
   - `jobs.client_id`, `jobs.worker_id`
   - `estimates.client_id`
   - `subscriptions.client_id`, `subscriptions.worker_id`
   - `invoices.client_id`, `invoices.job_id`
3. Add `payments.invoice_id` last (strict financial leaf).
4. Validate runtime behavior and integrity script outputs.

For large tables, prefer staged constraints (`NOT VALID` then `VALIDATE CONSTRAINT`) in a dedicated migration pass.

## Rollback Considerations

- Keep each FK addition isolated per migration step to allow targeted rollback.
- If rollout fails on data drift:
  - drop only newly added failing FK(s),
  - run repair,
  - re-apply.
- Do not bundle unrelated DDL with FK migrations.

## ON DELETE Strategy Guide

- **RESTRICT** (financial/core ownership):  
  `clients.company_id`, `jobs.company_id`, `estimates.company_id`, `invoices.company_id`, `invoices.client_id`, `payments.invoice_id`, `subscriptions.company_id`
- **SET NULL** (optional linkage/history retention):  
  `users.company_id`, `jobs.client_id`, `jobs.worker_id`, `estimates.client_id`, `invoices.job_id`, `subscriptions.client_id`, `subscriptions.worker_id`
- **CASCADE** in this core set: not recommended for financial/workflow tables.

## Operational Guardrail

Continue running:

- `node scripts/integrity-audit.js`
- `node scripts/fk-preflight-audit.js`

in staging/CI before introducing FK migrations.

