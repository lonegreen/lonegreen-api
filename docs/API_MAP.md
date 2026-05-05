# API Map

Phase 6 cleanup status map for the LoneGreen backend. Routes are grouped by file and marked as `canonical`, `legacy`, `compatibility alias`, `duplicate`, or `unused`.

## auth.js

| Method | Route | Purpose | Status | Frontend pages using it |
| --- | --- | --- | --- | --- |
| POST | `/signup` | Create company + owner account | canonical | `signup.html` |
| POST | `/login` | Password login | canonical | `login.html` |
| POST | `/google-login` | Placeholder Google login endpoint | unused | `login.html` |

## core.js

| Method | Route | Purpose | Status | Frontend pages using it |
| --- | --- | --- | --- | --- |
| GET | `/clients` | List clients | canonical | `clients.html` |
| POST | `/clients` | Create client | canonical | `clients.html` |
| PUT | `/clients/:id` | Update client/profile notes | canonical | `clients.html`, `client.html` |
| DELETE | `/clients/:id` | Delete client | canonical | `clients.html` |
| GET | `/me` | Current user profile | canonical | `control.html`, `settings.html` |
| GET | `/company` | Company profile | canonical | `control.html`, `settings.html` |
| PUT | `/company` | Update company profile | canonical | `settings.html` |
| PUT | `/me/password` | Change password | canonical | `settings.html` |
| GET | `/notifications` | Notifications feed | canonical | `settings.html` |
| PUT | `/notifications/:id/read` | Mark notification read | canonical | `settings.html` |
| GET | `/activity-log` | Activity history | canonical | `settings.html` |
| GET | `/jobs` | Legacy job list | legacy, duplicate | none after Phase 6 |
| POST | `/jobs` | Legacy job create | legacy, duplicate | none after Phase 6 |
| PUT | `/jobs/:id/status` | Legacy job status update | legacy, duplicate | none after Phase 6 |
| GET | `/workers` | Legacy worker list | legacy, duplicate | none after Phase 6 |
| GET | `/calendar` | Legacy calendar | legacy, duplicate | none after Phase 6 |
| GET | `/dashboard` | Legacy summary counts | legacy | `index.html` |
| GET | `/money` | Legacy revenue summary | legacy | `dashboard.html` |
| GET | `/subscriptions` | Legacy subscription list | legacy, duplicate | none after Phase 6 |
| POST | `/subscriptions` | Legacy subscription create | legacy, duplicate | none after Phase 6 |
| PUT | `/subscriptions/:id/status` | Legacy subscription pause/resume | legacy, duplicate | none after Phase 6 |
| PUT | `/subscriptions/:id/mark-paid` | Legacy subscription billing action | legacy, duplicate | none after Phase 6 |
| GET | `/subscriptions/:id` | Subscription detail | unused | none |
| PUT | `/subscriptions/:id` | Full subscription update | unused | none |
| DELETE | `/subscriptions/:id` | Delete subscription | unused | none |
| GET | `/worker-jobs/:workerId` | Old worker jobs view | duplicate | none after Phase 6 |
| GET | `/zip-groups-full` | Legacy ZIP group list | legacy, duplicate | none after Phase 6 |
| POST | `/zip-groups` | Legacy ZIP group create | legacy, duplicate | none after Phase 6 |
| DELETE | `/zip-groups/:id` | Legacy ZIP group delete | legacy, duplicate | none after Phase 6 |
| POST | `/zip-codes` | Legacy ZIP create | legacy, duplicate | none after Phase 6 |
| DELETE | `/zip-codes/:id` | Legacy ZIP delete | legacy, duplicate | none after Phase 6 |
| GET | `/clients/:id/jobs` | Client jobs detail helper | unused | none |
| GET | `/clients/:id/subscriptions` | Client subscriptions detail helper | unused | none |
| GET | `/estimates` | Legacy estimate list | legacy, duplicate | none after Phase 6 |
| POST | `/estimates` | Legacy estimate create | legacy, duplicate | none after Phase 6 |
| PUT | `/estimates/:id` | Legacy estimate update | legacy, duplicate | none after Phase 6 |
| PUT | `/estimates/:id/status` | Legacy estimate status update | legacy, duplicate | none after Phase 6 |
| DELETE | `/estimates/:id` | Legacy estimate delete | legacy, duplicate | none after Phase 6 |
| POST | `/estimates/:id/convert-to-job` | Old estimate-to-job conversion | legacy, duplicate | none after Phase 6 |
| POST | `/estimates/:id/convert-to-subscription` | Old estimate-to-subscription conversion | legacy | none |
| GET/POST | `/jobs/:id/photos` | Job photos | unused | none |
| PUT | `/jobs/update/:id` | Full job update | unused | none |
| DELETE | `/workers/:id` | Worker delete | unused | none |

## workflow.js

| Method | Route | Purpose | Status | Frontend pages using it |
| --- | --- | --- | --- | --- |
| GET | `/workflow/leads` | List leads | canonical | `estimates.html` |
| POST | `/workflow/leads` | Create lead | canonical | `estimates.html` |
| PUT | `/workflow/leads/:id` | Update lead | canonical | `estimates.html` |
| POST | `/workflow/leads/:id/convert-to-estimate` | Lead to estimate | canonical | `estimates.html` |
| POST | `/workflow/leads/:id/convert-to-client` | Lead to client | canonical | `estimates.html` |
| POST | `/workflow/leads/:id/convert-to-job` | Lead to job | canonical | `estimates.html` |
| GET | `/workflow/estimates` | List estimates | canonical | `estimates.html`, `dashboard.html` |
| PUT | `/workflow/estimates/:id` | Update estimate | canonical | `estimates.html` |
| POST | `/workflow/estimates/:id/convert-to-client` | Approved estimate to client | canonical | `estimates.html` |
| POST | `/workflow/estimates/:id/convert-to-job` | Approved estimate to job | canonical | `estimates.html` |
| GET | `/workflow/jobs` | List jobs | canonical | `jobs.html`, `clients.html`, `dashboard.html`, `index.html` |
| POST | `/workflow/jobs` | Create job | canonical | `jobs.html`, `clients.html`, `client.html` |
| PUT | `/workflow/jobs/:id` | Update job | canonical | `jobs.html` |
| PUT | `/workflow/jobs/:id/status` | Update job status | canonical | `jobs.html`, `dashboard.html` |
| DELETE | `/workflow/jobs/:id` | Delete job | canonical | `jobs.html` |
| GET | `/workflow/clients/:id/timeline` | Full client timeline | canonical | `client.html` |
| POST | `/workflow/invoices` | Create invoice | canonical | `client.html` |
| GET | `/workflow/invoices/:id` | Invoice detail | canonical | `invoice.html` |
| PUT | `/workflow/invoices/:id` | Update invoice | canonical | none |
| PUT | `/workflow/invoices/:id/status` | Update invoice status | canonical | `client.html` |
| POST | `/workflow/invoices/:id/payments` | Record payment | canonical | `invoice.html` |

## operations.js

| Method | Route | Purpose | Status | Frontend pages using it |
| --- | --- | --- | --- | --- |
| GET | `/ops/workers` | Worker list + stats | canonical | `calendar.html`, `jobs.html`, `workers.html`, `worker.html`, `client.html`, `clients.html`, `zip-manager.html` |
| POST | `/ops/workers` | Create worker | canonical | `workers.html` |
| PUT | `/ops/workers/:id` | Update worker | canonical | `workers.html` |
| GET | `/ops/calendar` | Calendar jobs feed | canonical | `calendar.html` |
| GET | `/ops/subscriptions` | Subscription operations list | canonical | `subscriptions.html` |
| POST | `/ops/subscriptions` | Subscription create alias | canonical compatibility | `client.html`, `clients.html` |
| PUT | `/ops/subscriptions/:id/status` | Subscription status alias | canonical compatibility | `subscriptions.html` |
| PUT | `/ops/subscriptions/:id/mark-paid` | Subscription billing alias | canonical compatibility | `subscriptions.html` |
| GET | `/ops/zip-groups-full` | ZIP groups + worker links | canonical compatibility | `zip-manager.html` |
| POST | `/ops/zip-groups` | ZIP group create alias | canonical compatibility | `zip-manager.html` |
| DELETE | `/ops/zip-groups/:id` | ZIP group delete alias | canonical compatibility | `zip-manager.html` |
| POST | `/ops/zip-codes` | ZIP create alias | canonical compatibility | `zip-manager.html` |
| DELETE | `/ops/zip-codes/:id` | ZIP delete alias | canonical compatibility | `zip-manager.html` |
| PUT | `/ops/zip-groups/:id/workers` | Link workers to ZIP group | canonical compatibility | `zip-manager.html` |
| GET | `/ops/worker-suggestion` | ZIP-based worker suggestion | canonical compatibility | `jobs.html` |
| GET | `/ops/unassigned-jobs` | Unassigned jobs list | canonical compatibility | `jobs.html` |
| GET | `/ops/worker-jobs/:workerId` | Worker mobile jobs view | canonical compatibility | `worker.html` |
| PUT | `/ops/worker-jobs/:jobId` | Worker mobile job update | canonical compatibility | `worker.html` |
| GET | `/operations/workers` | Old health-check alias | compatibility alias | none |
| GET | `/operations/calendar` | Old health-check alias | compatibility alias | none |

## Notes

- Canonical route families in this phase are:
  - `/workflow/jobs`
  - `/workflow/leads`
  - `/workflow/estimates`
  - `/workflow/invoices`
  - `/ops/workers`
  - `/ops/calendar`
  - `/ops/subscriptions`
  - `/clients`
  - `/company`
  - `/me`
  - `/notifications`
- Legacy routes are still live and now log a deprecation warning in the server console when used.
- `dashboard.html` and `index.html` still depend on legacy summary-style endpoints (`/money`, `/dashboard`) because those summaries do not yet have a canonical replacement in this cleanup phase.
