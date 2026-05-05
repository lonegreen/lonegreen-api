# Local Setup

## Database URL

The backend reads `DATABASE_URL` from the project root `.env` file.

When running this app locally, use the Render **External Database URL** or a local PostgreSQL URL.

Do not use the Render **Internal Database URL** locally. Internal Render database hosts look like:

```text
dpg-...-a.ohio-postgres.render.com
```

Those internal hostnames only resolve from services running inside Render. On your local computer they can fail with:

```text
getaddrinfo ENOTFOUND ...-a.ohio-postgres.render.com
```

Use the Internal Database URL only for hosted Render services. Use the External Database URL in local `.env`.
