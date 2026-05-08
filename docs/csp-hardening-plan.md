# CSP Hardening Plan (Staged, Non-Breaking)

## Current CSP Status

Current production policy still permits:

- `script-src 'self' 'unsafe-inline' ...`
- `style-src 'self' 'unsafe-inline' ...`

This is intentional for now to avoid breaking existing pages that still rely on inline scripts/styles.

## Target CSP

Target policy after migration:

- `script-src 'self' https://js.stripe.com` (remove `'unsafe-inline'`)
- `style-src 'self'` (remove `'unsafe-inline'`)
- keep existing non-script/style directives unless separately reviewed

## Audit Summary (public/)

- **Inline scripts (`<script>...</script>`):** present across most app pages in `public/*.html`.
- **Inline styles (`<style>...</style>` and/or style attributes):** present across most app pages in `public/*.html`.
- **Inline event handlers in HTML:** found in `public/calendar.html` (`ondragstart`), migrated in next batch.
- **Inline event handlers in JS-generated HTML:** one simple case in `public/js/legal-consent.js` (`onclick` in template string), now removed and replaced with `addEventListener`.

## Page-by-Page Status

Status legend:

- `Not ready`: contains inline script/style and would break if `'unsafe-inline'` is removed now.
- `Ready`: no inline script/style/event handlers (none yet).

All currently active top-level app pages are **Not ready** for strict CSP:

- `admin-marketplace.html`
- `analytics.html`
- `billing-plans.html`
- `calendar.html`
- `client.html`
- `clients.html`
- `companies.html`
- `company-profile.html`
- `company-public-profile.html`
- `company-service-areas.html`
- `company-services.html`
- `control.html`
- `customer-dashboard.html`
- `customer-dashboard-v2.html`
- `customer-forgot-password.html`
- `customer-login.html`
- `customer-login-v2.html`
- `customer-profile.html`
- `customer-reset-password.html`
- `customer-signup.html`
- `dashboard.html`
- `discover.html`
- `estimates.html`
- `health.html`
- `index.html`
- `invoice.html`
- `invoices.html`
- `jobs.html`
- `login.html`
- `marketplace.html`
- `marketplace-analytics.html`
- `marketplace-dashboard.html`
- `marketplace-offers.html`
- `marketplace-opportunities.html`
- `messages.html`
- `platform.html`
- `settings.html`
- `signup.html`
- `subscriptions.html`
- `users.html`
- `worker.html`
- `workers.html`
- `zip-manager.html`

Policy/legal static pages are also **Not ready** (still include inline style/script patterns):

- `billing-policy.html`
- `company-ownership.html`
- `cookie-policy.html`
- `data-processing.html`
- `privacy.html`
- `refund-policy.html`
- `terms.html`

## Blockers

1. Inline script blocks are embedded directly in many HTML pages.
2. Inline style blocks and style attributes are still used broadly.
3. At least one remaining HTML inline handler (`calendar.html` drag/drop template) still needs conversion.
4. `public/js/legal-consent.js` dynamically injects a `<style>` block, which also requires a nonce or external stylesheet strategy in strict mode.

## Migration Order (Safe, Incremental)

1. **Event-handler cleanup batch:** eliminate remaining HTML `on*=` handlers (start with `calendar.html`).
2. **Externalize inline scripts per page family:**
   - Auth pages (`login`, `signup`, customer auth pages)
   - Workflow pages (`clients`, `client`, `jobs`, `estimates`, `subscriptions`, `invoices`)
   - Marketplace pages
   - Admin/platform pages
3. **Externalize inline styles:**
   - move `<style>` blocks to CSS files
   - replace inline `style="..."` with classes
4. **Dry-run CSP tightening in staging:** deploy report-only or canary checks before production enforcement.
5. **Remove `'unsafe-inline'` from `script-src` and `style-src` only after all pages pass smoke tests.**

## Rules for Future Pages

- No inline script blocks.
- No inline event handlers (`onclick`, `onchange`, etc.).
- Prefer external JS modules/files.
- Dynamic content must use safe DOM APIs (`textContent`, `createElement`, `setAttribute`).
- Validate dynamic URLs before assigning to `href`/`src`.

## Removal Conditions Checklist

Remove `'unsafe-inline'` only when all are true:

- [ ] no `on*=` attributes in `public/*.html`
- [ ] no inline `<script>` blocks in `public/*.html`
- [ ] no inline `<style>` blocks or inline style attributes in `public/*.html`
- [ ] no JS that injects inline handler strings
- [ ] staging smoke tests pass for all major flows (auth, workflow, marketplace, platform)
