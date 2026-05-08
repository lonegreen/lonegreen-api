# API Response Format (Safe Migration Plan)

This project currently has mixed response styles across route families.  
To avoid frontend regressions, migration must be incremental and compatibility-first.

## Target Convention (Future)

- Success (single object):
  - `{ "success": true, "data": { ... } }`
- Success (list):
  - `{ "success": true, "data": [ ... ], "pagination": { "limit": 50, "offset": 0 } }`
- Error:
  - `{ "success": false, "error": "Message" }`

## Rules for Safe Migration

1. **Do not mass-convert public/frontend endpoints** in one pass.
2. **Preserve existing response shape** for frontend-facing routes until consumer pages are updated.
3. **Prefer adapter-first rollout**:
   - Add optional support in frontend for wrapped payloads.
   - Then migrate backend route family by family.
4. Keep using HTTP status codes as source of truth.
5. Keep `error` field stable during migration for compatibility.

## Route Family Compatibility Notes

- High-risk to change immediately:
  - `/workflow/*`
  - `/marketplace/*`
  - `/billing/*`
  - `/customer/*`
  - `/companies/public*`
  - `/ops/workers`, `/ops/subscriptions`
- Medium-risk:
  - `/auth/*`
  - `/notifications/*`
  - `/ops/zip-groups-full`
- Safer early candidates (internal/admin with controlled consumers):
  - selective `/platform/*` endpoints after verifying `public/platform.html` handling
  - new internal endpoints only

## Shared Helper for New/Incremental Work

Use `utils/apiResponse.js`:

- `sendSuccess(res, data, meta?)`
- `sendError(res, status, message, details?)`
- `sendNotFound(res, message?)`
- `sendForbidden(res, message?)`
- `sendBadRequest(res, message?)`

Important: introducing these helpers does **not** imply immediate route shape changes.

## Recommended Phased Rollout

1. Add frontend compatibility adapters for wrapped `{ success, data }`.
2. Migrate one internal route family at a time.
3. Validate each page/consumer before migrating next family.
4. Keep legacy shape aliases temporarily where needed.
5. Remove aliases only after UI migration is complete.
