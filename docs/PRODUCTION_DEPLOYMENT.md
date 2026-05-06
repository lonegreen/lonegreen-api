# Production Deployment Guide

## Purpose
This document captures the production readiness requirements and deployment guidance for the LoneGreen SaaS application. It is intended to help ensure a safe, repeatable, and secure rollout of the application to production.

## Required Environment Variables
- `NODE_ENV=production`
- `DATABASE_URL`
- `JWT_SECRET`
- `ALLOWED_ORIGINS`
- `PORT`

## Hosting Deployment Notes
- Use `NODE_ENV=production` for the deployed service.
- Set `DATABASE_URL` to the managed PostgreSQL database connection string.
- Set `JWT_SECRET` to a strong, unguessable secret.
- Set `ALLOWED_ORIGINS` to a comma-separated list of allowed frontend origins, for example:
  - `https://app.example.com,https://www.example.com`
- Configure `PORT` if your hosting provider requires a specific port value; otherwise the app defaults to `4000`.
- Ensure the `.env` file is never committed to source control.

## CORS Setup Example
In production, CORS should only allow configured frontend origins via `ALLOWED_ORIGINS`.
Example value:

```text
ALLOWED_ORIGINS=https://app.example.com,https://www.example.com
```

Requests without an `Origin` header are still allowed for server-to-server or same-origin traffic.

## Rate Limiting Note
The application includes basic rate limiting to reduce automated spam and brute-force abuse.
- Default policy: 300 requests per IP per 15 minutes
- Excess requests receive a `429 Too Many Requests` response with a JSON error message

## Health Check URL
- `GET /health`

Use this endpoint to verify the application is running and able to respond to requests.

## Pre-deploy Checklist
- Backup database
- Verify required environment variables are present
- Run `npm install`
- Start the app with `npm start`
- Verify login functionality
- Verify dashboard loads correctly
- Verify jobs pages and operations work
- Verify invoices and payments functionality

## Post-deploy Checklist
- Confirm the production service is responding on the expected URL
- Confirm `/health` returns a successful response
- Confirm CORS behavior allows only the configured frontend origins
- Confirm rate limiting does not block normal application usage
- Confirm logs do not contain sensitive environment details
- Monitor application errors and performance closely for the first deployment window

## Rollback Checklist
- If deployment causes failures, revert to the previous release or commit
- Restore the last known good database backup if data inconsistencies occurred
- Reset any changed environment variables to their prior values if needed
- Re-run smoke tests for login, dashboard, jobs, invoices, and payments after rollback

## Security Notes
- Never commit `.env` to source control
- Use a strong `JWT_SECRET` and rotate it if compromised
- Restrict `ALLOWED_ORIGINS` to only trusted frontend hosts
- Keep `NODE_ENV=production` set in production environments
