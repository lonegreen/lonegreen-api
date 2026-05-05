# Stability Checklist

Manual stability checklist for the current cleanup phase.

## Login

- Open `login.html`
- Sign in with a real company user
- Confirm token is stored and the app routes into the control panel

## Dashboard

- Open `dashboard.html`
- Confirm cards load instead of staying on loading text
- Confirm revenue, workers, and monthly reports render without console errors

## Clients

- Open `clients.html`
- Confirm client list loads
- Add a client
- Edit a client
- Delete a test client only if safe

## Client Profile

- Open `client.html?id=[client_id]`
- Confirm timeline loads
- Confirm notes save
- Add a job
- Add a subscription
- Create an invoice

## Lead To Estimate

- Open `estimates.html`
- Create a lead
- Convert the lead to an estimate
- Confirm both lists refresh

## Estimate To Client/Job

- Approve an estimate
- Convert the estimate to a client or a job
- Confirm the created records appear in client profile and jobs

## Job To Invoice

- Open `jobs.html`
- Confirm jobs load from `/workflow/jobs`
- Update a job status
- From client profile create an invoice tied to a job

## Payment

- Open `invoice.html?id=[invoice_id]`
- Record a partial payment
- Confirm payment history and remaining balance update
- Record the final payment and confirm `PAID` badge appears

## Subscription

- Open `subscriptions.html`
- Confirm subscriptions load from `/ops/subscriptions`
- Pause and resume a subscription
- Run `Bill & Mark Paid`
- Confirm billing history and latest invoice fields refresh

## Calendar

- Open `calendar.html`
- Switch day, week, and month views
- Filter by worker
- Confirm grouped jobs still render

## Workers

- Open `workers.html`
- Add a worker
- Edit a worker
- Activate and deactivate a worker
- Confirm stats still render

## Worker View

- Open `worker.html`
- Select a worker
- Confirm today’s jobs load
- Start a job
- Complete a job
- Save notes

## Settings

- Open `settings.html`
- Confirm `/me`, `/company`, `/notifications`, and `/activity-log` load
- Update company info
- Change password
- Mark a notification read

## Server Console Checks

- Watch for `Deprecated route used:` warnings
- Confirm warnings only appear for intentional legacy pages or compatibility aliases
- Confirm no PostgreSQL type errors or missing-column errors appear during the checklist
