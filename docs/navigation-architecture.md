# FairLinx Navigation Architecture

Phase 1 documentation only. This document defines the intended public, customer,
company, worker, and platform owner navigation architecture without changing
routes, files, schemas, or application behavior.

## 1. Navigation Principles

FairLinx is a hybrid product with four visible surfaces:

- Public marketplace and marketing layer
- Customer marketplace layer
- Business SaaS layer
- Platform owner operations layer

Canonical entrypoints should be clear, role-specific, and stable. Legacy pages
and redirect shims may remain for compatibility, but new links should point to
the canonical destinations in this document.

## 2. Roles

### Visitor

Unauthenticated public user. Visitors can learn about FairLinx, browse public
company/service surfaces, and enter either the customer marketplace flow or the
business signup/login flow.

Canonical visitor destinations:

- `/`
- `/index.html`
- `/discover.html`
- `/marketplace.html`
- `/company-profile.html`
- `/service-area.html`
- `/trust.html`
- legal pages

### Customer

Marketplace/customer account user. Customers use the customer auth flow and
customer-owned marketplace/social surfaces.

Canonical customer destinations:

- `/customer-login-v2.html`
- `/customer-signup.html`
- `/customer-dashboard.html`
- `/marketplace.html`
- `/discover.html`
- `/messages.html`
- `/customer-profile.html`
- `/customer-forgot-password.html`
- `/customer-reset-password.html`

### Company

Business SaaS user with owner/admin/manager permissions. Company users enter
through business auth and operate inside the company app shell.

Canonical company destinations:

- `/login.html`
- `/signup.html`
- `/control.html`
- iframe pages owned by the company shell, especially `/dashboard.html`,
  `/jobs.html`, `/clients.html`, `/estimates.html`, `/invoices.html`,
  `/subscriptions.html`, `/calendar.html`, `/settings.html`, `/support.html`,
  and marketplace setup/operations pages.

### Worker

Restricted company user. Workers authenticate through the business login flow
but should only see worker-appropriate work surfaces.

Canonical worker destinations:

- `/login.html`
- `/control.html`
- `/worker.html`

Worker navigation must preserve assigned-work restrictions enforced by backend
authorization. Worker users should not be routed into admin/company management
pages.

### Platform Owner

FairLinx operator role. Platform owners authenticate through `/login.html` and
are redirected into platform operations.

Canonical platform owner destinations:

- `/login.html`
- `/control.html`
- `/platform.html#overview`
- `/platform.html`
- `/support.html` when acting on support operations

The public homepage should not expose a platform-owner-specific login CTA.
Platform owner separation is role-based, not a separate public login surface.

## 3. Canonical Entrypoints

### Public

- `/` serves `public/index.html`
- `/index.html` serves `public/index.html`

Primary public calls to action:

- Customer discovery: `/discover.html`
- Customer service request: `/marketplace.html`
- Customer login: `/customer-login-v2.html`
- Customer signup: `/customer-signup.html`
- Business login: `/login.html`
- Business signup: `/signup.html`

### Business SaaS

- `/login.html` is the business/company login page.
- `/signup.html` is the business/company signup page.
- `/control.html` is the company app shell and iframe container.

Business roles should land in `/control.html`, with the shell selecting the
correct internal page based on role and stored navigation state.

### Customer Marketplace

- `/customer-login-v2.html` is the canonical customer login page.
- `/customer-signup.html` is the canonical customer signup page.
- `/discover.html` is the canonical marketplace discovery page.
- `/marketplace.html` is the canonical customer service request flow.
- `/customer-dashboard.html` is the canonical customer application dashboard.

### Platform Owner

- Platform owners use `/login.html`.
- Successful platform owner auth should route to `/control.html` with current
  page set to `/platform.html#overview`, or directly to `/platform.html#overview`
  where existing flow requires it.
- `/platform.html` owns platform owner operations views.

## 4. Final Page Ownership

### Public-Owned Pages

These pages are intended to be reachable without company login:

- `index.html`
- `discover.html`
- `marketplace.html`
- `company-profile.html`
- `service-area.html`
- `trust.html`
- `privacy.html`
- `terms.html`
- `cookie-policy.html`
- `data-processing.html`
- `billing-policy.html`
- `refund-policy.html`
- `company-ownership.html`

### Customer-Owned Pages

These pages belong to the customer marketplace/account experience:

- `customer-login-v2.html`
- `customer-signup.html`
- `customer-dashboard.html`
- `customer-profile.html`
- `customer-forgot-password.html`
- `customer-reset-password.html`
- `marketplace.html`
- `discover.html`
- `messages.html`

`marketplace.html` and `discover.html` are public/customer bridge pages. They
may be visible to visitors but should route authenticated customer actions
through customer auth.

### Company-Owned Pages

These pages belong to the business SaaS app shell:

- `control.html`
- `dashboard.html`
- `jobs.html`
- `calendar.html`
- `clients.html`
- `client.html`
- `estimates.html`
- `invoices.html`
- `invoice.html`
- `payments` surfaces where embedded by existing pages
- `subscriptions.html`
- `workers.html`
- `worker.html`
- `users.html`
- `settings.html`
- `analytics.html`
- `billing-plans.html`
- `support.html`

Company marketplace setup/operations pages:

- `marketplace-dashboard.html`
- `marketplace-opportunities.html`
- `marketplace-offers.html`
- `marketplace-analytics.html`
- `admin-marketplace.html`
- `company-public-profile.html`
- `company-profile.html` when used as public preview
- `company-services.html`
- `company-service-areas.html`
- `company-availability` surface if added later
- `zip-manager.html`

### Platform-Owned Pages

These pages belong to platform owner operations:

- `platform.html`
- `support.html` when platform owner is acting on platform support queues
- `health.html` if retained as an internal/system page

## 5. Final Marketplace Placement

FairLinx marketplace has two placements:

### Customer/Public Marketplace

Customer-facing marketplace placement lives outside the company shell:

- `/discover.html` for browsing companies and public profiles
- `/marketplace.html` for creating and managing service requests
- `/company-profile.html` for public company detail
- `/service-area.html` for location/service landing surfaces
- `/messages.html` for customer-company messaging

This surface is visitor/customer oriented. It should not require business SaaS
navigation.

### Company Marketplace Operations

Company marketplace operations live inside `/control.html`:

- Marketplace dashboard
- Opportunities
- Offers
- Analytics
- Public profile setup
- Services
- Service areas
- Trust and verification setup

Company setup mutations must remain company-authenticated, role-gated, and
billing-gated where required.

## 6. Sidebar and Menu Architecture

### Public Header

The public header should route users into role-appropriate flows:

- Find/request service: `/discover.html` or `/marketplace.html`
- Customer account: `/customer-login-v2.html` or `/customer-signup.html`
- Business account: `/login.html` or `/signup.html`

No platform owner CTA should appear in public navigation.

### Customer Navigation

Customer navigation should be compact and marketplace-oriented:

- Dashboard: `/customer-dashboard.html`
- Marketplace/request flow: `/marketplace.html`
- Discover: `/discover.html`
- Messages: `/messages.html`
- Profile/account: `/customer-profile.html`

Customer pages should not link into `/control.html`, `/dashboard.html`, or
platform owner pages.

### Company App Shell Navigation

`control.html` is the canonical company shell. It owns the business sidebar and
loads internal pages by iframe.

Core company menu:

- Dashboard: `dashboard.html`
- Jobs: `jobs.html`
- Calendar: `calendar.html`
- Clients: `clients.html`
- Estimates: `estimates.html`
- Invoices: `invoices.html`
- Subscriptions: `subscriptions.html`
- Workers: `workers.html`
- Analytics: `analytics.html`
- Marketplace: `marketplace-dashboard.html`
- Settings: `settings.html`
- Support: `support.html`

Admin/owner-only company menu items:

- Users: `users.html`
- Billing/plans: `billing-plans.html`
- Company public profile/setup pages
- Trust/verification setup pages

Worker menu:

- Worker page only, currently `worker.html`, unless future worker-specific
  surfaces are added.

### Platform Owner Navigation

Platform owner navigation is owned by `platform.html`, typically loaded through
`control.html`.

Canonical platform sections:

- Overview: `platform.html#overview`
- Companies: `platform.html#companies`
- Plans & billing: `platform.html#billing`
- Platform users: `platform.html#users`
- System health: `platform.html#health`
- Activity logs: `platform.html#activity`
- Settings: `platform.html#settings`
- Support queues: `support.html` or future platform support route/section

Platform owner navigation must remain separate from normal company navigation.

## 7. Redirect Shims

Redirect shims exist for compatibility and should remain until usage data shows
they can be removed.

Current known shims:

- `customer-login.html` redirects to `/customer-login-v2.html`.
- `customer-dashboard-v2.html` redirects to `/customer-dashboard.html`.

Shim rules:

- Do not link to shims from normal navigation.
- Keep shims lightweight.
- Preserve them for legacy bookmarks and external links.
- Remove only after analytics/logs confirm low or zero usage.

## 8. Internal Pages

Pages marked internal should not be primary public destinations. They may be
loaded inside the app shell, used by operators, or retained for diagnostics.

Internal/company shell pages:

- `dashboard.html`
- `jobs.html`
- `calendar.html`
- `clients.html`
- `client.html`
- `estimates.html`
- `invoices.html`
- `invoice.html`
- `subscriptions.html`
- `workers.html`
- `worker.html`
- `users.html`
- `settings.html`
- `analytics.html`
- `billing-plans.html`
- `marketplace-dashboard.html`
- `marketplace-opportunities.html`
- `marketplace-offers.html`
- `marketplace-analytics.html`
- `admin-marketplace.html`
- `company-public-profile.html`
- `company-services.html`
- `company-service-areas.html`
- `zip-manager.html`
- `support.html`

Internal/platform pages:

- `platform.html`
- `health.html`

Public/legal pages currently include "Back to dashboard" links in some places.
Those links should be treated as navigation risk until cleaned up because public
or legal visitors may not have a company dashboard session.

## 9. Legacy Pages

Legacy pages are retained for compatibility or because they are still referenced
by the existing shell.

Known legacy or compatibility-sensitive pages:

- `customer-login.html`
- `customer-dashboard-v2.html`
- `dashboard.html`
- `admin-marketplace.html`
- `health.html`

`dashboard.html` is still the company shell default and should not be removed
until a replacement dashboard is fully canonical. Legacy status here means it
has older endpoint dependencies and naming, not that it is unused.

## 10. Future Cleanup Plan

### Phase 1: Freeze and Document

- Keep canonical route structure stable.
- Stop adding new navigation links to shims.
- Treat this document as the source of truth for page ownership.
- Keep public, customer, company, worker, and platform owner surfaces separate.

### Phase 2: Navigation Hygiene

- Replace remaining normal links to `customer-dashboard-v2.html` with
  `customer-dashboard.html`.
- Replace any normal links to `customer-login.html` with
  `customer-login-v2.html`.
- Review legal/public "Back to dashboard" links and replace them with safer
  context-neutral links such as `/`, `/login.html`, or `/customer-dashboard.html`
  where appropriate.
- Confirm customer pages never link into company shell pages.
- Confirm company shell pages never expose platform owner sections to non-
  platform roles.

### Phase 3: Shell Simplification

- Keep `/control.html` as the company app shell.
- Keep `/platform.html` as the platform owner operations page.
- Decide whether platform owner pages should always be loaded inside
  `/control.html` or may be accessed directly after auth.
- Create a small page registry for shell-owned pages so role/page ownership is
  declarative and auditable.

### Phase 4: Legacy Retirement

- Use server logs or analytics to measure shim usage.
- Retire redirect shims only after external usage is negligible.
- Remove or rename legacy pages only in a dedicated migration/cleanup phase.
- Update docs, launch gate, and smoke tests whenever page ownership changes.

### Phase 5: Production Navigation Checks

- Add automated checks that root serves `index.html`.
- Add automated checks that public CTAs route to public/customer/business
  canonical destinations.
- Add automated checks that shims are not referenced by normal navigation.
- Add automated checks that platform pages are guarded and not publicly linked.

