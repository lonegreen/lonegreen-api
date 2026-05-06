# Local Setup

## Database URL

The backend reads `DATABASE_URL` from the project root `.env` file.

When running this app locally, use your Neon pooled `DATABASE_URL` (or a local PostgreSQL URL).

Do not use private/internal hostnames locally. They only resolve inside the hosting provider network.

For example, private hostnames can fail on your local computer with:

```text
getaddrinfo ENOTFOUND ...-a.ohio-postgres.render.com
```

For local development, keep `DATABASE_URL` pointed at Neon (or local Postgres) in your local `.env`.
