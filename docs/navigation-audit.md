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

## Phase 2 Control Shell Upgrade

### Shell improvements made

- `/control.html` keeps the iframe architecture and now presents grouped navigation: Main, Workflow, Operations, Company, Platform, and Support.
- The shell shows a text page title, breadcrumb (`FairLinx / Current Page`), role pill, company pill, notification count, quick actions, and the existing account menu.
- Sidebar navigation has a clearer active state and remains driven by existing `data-page` buttons.
- Mobile layouts use a drawer with hamburger open, close button, backdrop close, nav-click close, and Escape key close.
- Iframe switches show a loading state. If a page takes longer than the timeout, the shell shows Retry and a role-safe fallback button.

### currentPage validation policy

- `localStorage.currentPage` is validated before the iframe is loaded.
- Only local `.html` pages with approved query or hash fragments are allowed.
- External URLs, arbitrary paths, and unknown pages fall back safely.
- Child iframe `postMessage` navigation still flows through `loadPage(page)` and the same validation.

### Role defaults

- `platform_owner` defaults to `platform.html#overview` and can use approved platform hashes, including `platform.html#support`.
- `worker` defaults to `worker.html`.
- `owner`, `admin`, and `manager` default to `dashboard.html`.
- Company admin navigation remains visible only for owner/admin where backend routes require admin-level access.

### Manual smoke tests

- Owner/admin default should open `dashboard.html` and allow dashboard, analytics, settings, users, and billing.
- Manager default should open `dashboard.html` and keep admin-only company settings/users/billing hidden.
- Worker default should open `worker.html` and keep company admin pages hidden.
- Platform owner default should open `platform.html#overview`; platform hash navigation should remain inside the shell.
- Clicking sidebar items should update the active state, page title, breadcrumb, iframe, and `localStorage.currentPage`.
- An invalid `currentPage` should fall back to the role default without redirect loops.
- Mobile sidebar should open, close by button/backdrop/Escape, and close after selecting a nav item.
- Existing iframe `postMessage` events with `{ type: "openPage", page: "..." }` should continue to load through the shell validator.
