# FairLinx Navigation Audit

## Active Pages

- Public marketing and discovery: `/index.html`, `/for-customers.html`, `/for-companies.html`, `/discover.html`, `/service-area.html`, `/company-profile.html`, `/trust.html`.
- Company shell: `/control.html`.
- Company iframe pages: `/dashboard.html`, `/clients.html`, `/client.html`, `/jobs.html`, `/calendar.html`, `/estimates.html`, `/invoices.html`, `/invoice.html`, `/subscriptions.html`, `/workers.html`, `/analytics.html`, `/messages.html`, `/support.html`.
- Company admin pages: `/settings.html`, `/users.html`, `/billing-plans.html`, `/company-public-profile.html`, `/company-services.html`, `/company-service-areas.html`.
- Platform owner console: `/platform.html` through `/control.html`.
- Customer flow: `/customer-login-v2.html`, `/customer-signup.html`, `/customer-forgot-password.html`, `/customer-reset-password.html`, `/customer-dashboard.html`, `/customer-profile.html`, `/marketplace.html`.

## Legacy Redirect Pages

- `/customer-login.html` redirects to `/customer-login-v2.html`.
- `/customer-dashboard-v2.html` redirects to `/customer-dashboard.html`.
- `/company-signup.html` redirects to `/signup.html`.
- `/pricing.html` redirects to `/for-companies.html`.
- `/about.html` redirects to `/index.html`.
- `/contact.html` redirects to `/index.html`.
- `/reviews.html` redirects to `/discover.html`.

## Internal / Hidden Pages

- `/health.html` remains an internal guarded health surface.
- `/admin-marketplace.html` remains hidden and guarded for admin/platform marketplace moderation.
- `/marketplace-analytics.html` remains hidden until intentionally connected.
- `/zip-manager.html` remains allowed for admin/owner access but hidden from normal navigation during Phase 1.
- `/policies.html` remains present but is not part of normal navigation; specific policy pages are active.

## Broken Links Fixed

- Added redirect shims for stale public links to `/pricing.html`, `/about.html`, `/contact.html`, and `/reviews.html`.
- Added `npm run audit:navigation` to detect missing local HTML/page targets and invalid iframe `data-page` targets.

## Remaining Known Risks

- Some older pages still contain duplicated navigation markup outside the iframe shell. Phase 1 keeps compatibility rather than rebuilding those pages.
- `zip-manager.html` is allowed internally but intentionally hidden from normal admin navigation until product ownership confirms it is active.
- Customer reset emails must include a `?token=...` link to `/customer-reset-password.html` for the reset page to complete the flow.

## Phase 2 Recommendations

- Normalize all company iframe pages to rely on one shared role guard contract.
- Add smoke tests for role-specific shell navigation with seeded owner/admin/manager/worker/platform sessions.
- Decide whether `zip-manager.html`, `admin-marketplace.html`, and `marketplace-analytics.html` should become visible platform/admin tools or permanent redirect shims.
- Replace duplicated public/legal nav snippets with a shared static include/build step if the project later gains a build process.
