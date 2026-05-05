# Testing And Launch Gate

## Safe default

Run:

```bash
npm test
```

This runs `npm run check`, which performs JavaScript syntax checks and source-level launch-gate checks without connecting to a database.

## DB-dependent mode

Database checks are skipped unless explicitly enabled:

```bash
ALLOW_DB_TESTS=true TEST_DATABASE_URL=postgres://... npm test
```

Use a disposable test database. The launch gate maps `TEST_DATABASE_URL` to `DATABASE_URL` only for the child integrity audit process. Do not point `TEST_DATABASE_URL` at production Neon for CI tests.

## CI

GitHub Actions runs on `pull_request` and pushes to `main`.

The workflow runs:

```bash
npm ci
npm test
```

If a repository secret named `TEST_DATABASE_URL` is configured, CI also runs the strict integrity audit against that test database. Without that secret, DB-dependent checks are skipped safely.
