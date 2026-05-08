# Production Storage Plan (Phase 12)

- Drivers: `local` (default), `r2` (enabled when env is ready), `s3` (scaffold-only).
- Safety: driver detection falls back to `local` when external driver env is incomplete.
- Upload abstraction: adapter shape now supports `upload()` and `publicUrlFromKey()`.
- Delete abstraction: adapter shape supports `remove()` and only acts on owned URLs.
- Readiness: `getUploadReadiness()` reports effective driver, missing env keys, and fallback state.
- This readiness-first rollout keeps production behavior safe while external drivers are being phased in.
- Production guidance: keep `local` for dev/staging; enable `r2` for durable production object storage.
