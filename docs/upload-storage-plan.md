# Upload Storage Plan (Production Readiness)

## Current Local Storage Behavior

### Runtime and file path
- Default storage driver: `UPLOAD_STORAGE_DRIVER=local`.
- Uploads are handled by `multer.diskStorage` in `services/uploadService.js`.
- Files are written to `public/uploads` (`UPLOAD_DIR`).
- Public URLs are generated as `/uploads/<filename>` via `publicUploadUrl()`.
- `server.js` exposes `public/` via `express.static`, so uploaded files are web-accessible by URL path.

### Current upload routes
- `POST /uploads/job/:jobId/photo`:
  - Auth + billing guard.
  - Role/scoping checks for same `company_id` and worker/manager access.
  - Stores URL in `job_photos.image_url`.
- `GET /uploads/job/:jobId/photos`:
  - Auth + company/worker access checks.
  - Reads rows from `job_photos`.
- `DELETE /uploads/job/photos/:photoId`:
  - Manager+ with billing guard.
  - Deletes DB row, then local file via `deleteLocalUpload`.
- `POST /uploads/company/logo`:
  - Manager+ with billing guard.
  - Updates `companies.invoice_logo_url`.
  - Deletes previous local logo when URL matches safe local pattern.

### DB persistence touched by upload flow
- `job_photos.image_url` (job photo paths).
- `companies.invoice_logo_url` (invoice logo path).
- Public profile/logo usage references `companies.logo_url` and `invoice_logo_url` in read paths.

### Validation/security posture today
- Global max upload size: 8MB (`MAX_FILE_SIZE` in upload service).
- Company logo cap: 2MB route-level check.
- MIME + extension allowlist:
  - jpg/jpeg, png, webp, pdf (service-level).
  - Job/company photo routes further restrict to image MIME only.
- Dangerous filename rejection (`DANGEROUS_NAME_RE`, basename/path safety checks).
- Magic-byte signature checks (`assertUploadContentMatchesMime`) for JPEG/PNG/WEBP/PDF.
- Local delete path confinement (`assertUploadPathWithinDir` + basename URL handling).

## Production Risks (Current Design)

1. Local disk is non-durable on many production hosts (ephemeral filesystem).
2. Horizontal scaling causes file inconsistency between instances.
3. Redeploy/restart can orphan DB URL references to missing files.
4. Local-only storage complicates backup/restore and CDN distribution.
5. Delete consistency depends on local file presence on same host instance.

## Recommended Provider Options

### Cloudflare R2
- S3-compatible API, no egress fees in many cases.
- Good fit for public/static media with custom domain + CDN.

### AWS S3
- Mature ecosystem, lifecycle policies, replication, IAM tooling.
- Strong default option for enterprise operational maturity.

### Backblaze B2 (S3-compatible)
- Lower storage cost profile.
- Works well if S3 compatibility is sufficient for adapter.

## Target Architecture (Adapter-Based)

Introduce an upload storage adapter interface (no route contract changes):

```js
// proposed shape
storageAdapter.put({ key, bufferOrPath, contentType }) -> { key, url }
storageAdapter.delete({ key, url }) -> { deleted: boolean }
storageAdapter.publicUrl({ key }) -> string
storageAdapter.resolveKeyFromUrl(url) -> key | null
storageAdapter.health() -> { ok, provider, detail? }
```

### Adapters
- `localAdapter` (default for development):
  - Keep existing `public/uploads` behavior.
- `objectStorageAdapter` (production target):
  - S3-compatible client for R2/S3/B2.
  - Deterministic key scheme (example: `company/<id>/jobs/<jobId>/<ts>-<rand>.webp`).
  - In current scaffold, external adapters are intentionally not active yet.

### Public URL rules
- Persist URL-safe object location (prefer canonical HTTPS URL or stable CDN URL).
- Preserve existing API response fields (`url`, `image_url`) to avoid frontend breakage.

### Delete behavior
- Best-effort delete in object storage.
- Do not fail user mutation if remote delete returns not-found.
- Log deletion mismatches for cleanup/audit.

## Migration Strategy for Existing Uploads

No migration in this pass. Planned phased migration:

1. Add adapter abstraction while keeping local as default.
2. Enable object storage in staging; verify new uploads go remote.
3. Backfill copy of existing `public/uploads/*` to object storage.
4. Rewrite stored local URLs in DB to canonical object URLs (scripted + reversible).
5. Keep temporary fallback read compatibility for old local paths during transition window.
6. Remove fallback only after verification and backup snapshot.

## Environment Variables Needed Later (Planned)

Scaffolded now:

- `UPLOAD_STORAGE_DRIVER=local|s3|r2` (default: `local`)
  - `local`: fully active
  - `s3` / `r2`: currently scaffold-only and fail clearly with:
    - `"External upload storage driver is configured but not implemented/enabled yet."`

Planned future vars:

- `UPLOAD_PUBLIC_BASE_URL=https://cdn.example.com`
- `UPLOAD_S3_ENDPOINT=...` (R2/B2 custom endpoint or AWS endpoint)
- `UPLOAD_S3_REGION=...`
- `UPLOAD_S3_BUCKET=...`
- `UPLOAD_S3_ACCESS_KEY_ID=...`
- `UPLOAD_S3_SECRET_ACCESS_KEY=...`
- `UPLOAD_S3_FORCE_PATH_STYLE=true|false`
- `UPLOAD_S3_PREFIX=uploads/`

## Phased Implementation Plan

1. **Phase 0 (now):** audit + runtime production warning + no behavior change.
2. **Phase 1:** add adapter scaffold + local adapter parity tests (**done**).
3. **Phase 2:** add S3-compatible adapter and provider config validation.
4. **Phase 3:** route/service switch behind env flag, default local for dev.
5. **Phase 4:** controlled data migration for existing local assets.
6. **Phase 5:** observability and cleanup (orphan detection, failed delete retries).

## Guardrails

- Keep existing upload route responses and auth/tenant checks unchanged.
- Keep `multer` local support as baseline fallback.
- Do not introduce paid dependency decisions in code until provider selection is approved.
