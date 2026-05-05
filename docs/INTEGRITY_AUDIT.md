# Database integrity audit (`scripts/integrity-audit.js`)

## Purpose

This is a **read-only** script that queries PostgreSQL for common orphan and cross-tenant consistency problems: missing parent rows (jobs/clients, invoices/jobs, payments/invoices), `company_id` mismatches between related tables, subscription visit jobs without valid subscriptions, and workers/users pointing at non-existent companies.

It **never** updates, deletes, or fixes data.

## How to run

From the project root (with `DATABASE_URL` set in `.env`):

```bash
node scripts/integrity-audit.js
```

- Exit code **0** always, unless you pass `--strict` and at least one check returns rows.
- `--strict`: exit **1** if any check finds one or more rows (optional CI gate).

```bash
node scripts/integrity-audit.js --strict
```

## How to review results

1. **OK vs REVIEW** — Each section prints `[OK]` when the query returns zero rows, or `[REVIEW]` when rows were found.
2. **Samples** — Up to five example rows are printed as JSON for quick inspection (queries are capped at 100 IDs).
3. **ERROR** — Usually means a table/column is missing or the database is unreachable; fix connectivity/schema before interpreting orphan counts.
4. **Total flagged rows** — Sum of row counts across checks (not deduplicated across checks).

## Interpreting findings

- **Orphans** (e.g. job with invalid `client_id`) often come from manual SQL, partial deletes, or legacy imports. Resolve by **restoring** missing parents or **relinking** in a controlled migration — not by running destructive constraints blindly.
- **Company mismatches** can indicate **tenant isolation risk**; investigate which table is authoritative for `company_id` before changing data.
- Use application logs and Stripe/subscription history alongside these queries when planning fixes.

See also `docs/OPERATIONS_LAUNCH.md` for production monitoring after launch.
