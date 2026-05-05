# Smoke tests (`scripts/smoke-test.js`)

Lightweight checks against a running server. **No third-party paid APIs.** Optional login uses environment variables only — never commit credentials.

## Prerequisites

- Server reachable at `SMOKE_BASE_URL` (default `http://127.0.0.1:4000`).
- For full checks including `/billing/me`, create a **dedicated test staff user** in staging/local and pass credentials via env.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SMOKE_BASE_URL` | No | Base URL, default `http://127.0.0.1:4000` |
| `SMOKE_USERNAME` | No* | Staff username for `POST /auth/login` |
| `SMOKE_PASSWORD` | No* | Staff password |

\*If either username or password is unset, the script **skips** the authenticated billing probe and still passes if anonymous checks succeed.

## Run

```bash
npm run smoke:test
```

Or:

```bash
set SMOKE_USERNAME=your_test_user
set SMOKE_PASSWORD=your_test_password
node scripts/smoke-test.js
```

## What it checks

1. `GET /health` — JSON with an `ok` field.
2. `POST /auth/login` with empty body — expects `400` and JSON `error` string (login endpoint shape).
3. If credentials provided — successful login returns `token` and `user`, then `GET /billing/me` with Bearer token returns `200` and JSON.

Use this after deploys to staging or local smoke environments only; rate limits on `/auth/login` apply.
