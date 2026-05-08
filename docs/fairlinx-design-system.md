# FairLinx Design System (`fx-*`)

This document defines the safe, production-ready design-system layer for FairLinx UI standardization.

## Core principles

- Use `fx-*` classes as the primary visual contract.
- Keep legacy classes for compatibility until migration is complete.
- Prefer additive migration (`legacy + fx-*`) over replacement.
- Never couple JS behavior to new presentation classes.

## Token usage

### Brand tokens (`public/css/brand.css`)

- Primary: `--brand-primary`
- Primary hover: `--brand-primary-hover`
- Primary light: `--brand-primary-light`
- Text: `--brand-black`
- Border: `--brand-border`
- Background: `--brand-bg`

### Semantic tokens

- Text: `--text-primary`, `--text-secondary`, `--text-muted`
- Surfaces: `--surface-page`, `--surface-card`, `--surface-soft`
- Borders: `--border-default`, `--border-strong`, `--border-subtle`
- State tokens: success/warning/danger/info bg/fg/border

### Legacy alias safety

Legacy “green” aliases are intentionally mapped to FairLinx brand variables for backward compatibility:

- `--legacy-green-*`
- `--app-green-*`

Do not reintroduce hardcoded green identity tokens in shared CSS.

## Component usage

### Buttons

- Base: `fx-btn`
- Variants: `fx-btn--primary`, `fx-btn--secondary`, `fx-btn--ghost`, `fx-btn--danger`
- Sizes: `fx-btn--sm`, `fx-btn--lg`

Example:

```html
<button class="btn fx-btn fx-btn--primary">Save</button>
<button class="btn fx-btn fx-btn--secondary">Cancel</button>
```

### Badges

- Base: `fx-badge`
- Variants: `fx-badge--neutral`, `--success`, `--warning`, `--danger`, `--info`

```html
<span class="badge fx-badge fx-badge--success">Active</span>
```

### Cards & stats

- Card: `fx-card` (+ `fx-card--soft`, `fx-card--elevated`)
- Stat: `fx-stat`, `fx-stat__label`, `fx-stat__value`, `fx-stat__delta`

```html
<div class="panel fx-card">
  <div class="fx-stat">
    <div class="fx-stat__label">Revenue</div>
    <div class="fx-stat__value">$12,400</div>
  </div>
</div>
```

### Alerts

- Base: `fx-alert`
- Variants: `fx-alert--info`, `--success`, `--warning`, `--danger`

### Forms

- Field wrapper: `fx-field`
- Label/hint: `fx-field__label`, `fx-field__hint`
- Controls: `fx-input`, `fx-select`, `fx-textarea`

```html
<div class="field fx-field">
  <label class="fx-field__label" for="name">Name</label>
  <input id="name" class="fx-input" />
</div>
```

### Tables

- Wrapper: `fx-table-wrap`
- Table: `fx-table` (optional `fx-table--dense`)

```html
<div class="table-wrap fx-table-wrap">
  <table class="fx-table">
    <thead>...</thead>
    <tbody>...</tbody>
  </table>
</div>
```

### Empty states

- `fx-empty`, `fx-empty__title`, `fx-empty__text`, `fx-empty__actions`

### Section headers / toolbars

- Header: `fx-section-head` (+ `fx-section-head__content`)
- Toolbar: `fx-toolbar`

## Migration rules

1. Add `fx-*` classes next to legacy classes.
2. Keep existing IDs and data attributes untouched.
3. Keep existing hook classes until migration is complete.
4. Update runtime-generated HTML strings where safe.
5. Validate with project checks after each batch.

## Do / Don’t

### Do

- Do use semantic `fx-*` variants (button, badge, alert state).
- Do rely on tokens and aliases, not per-page hardcoded colors.
- Do preserve legacy classes during migration.

### Don’t

- Don’t remove legacy classes without an explicit cleanup phase.
- Don’t introduce new backend/API/auth logic in design-system work.
- Don’t rewrite page layouts during semantic migration phases.

## Safety rules for future Cursor changes

- Scope changes to allowed files for the phase.
- Never break route/API/auth/iframe behavior during design-system tasks.
- Treat runtime template strings as first-class migration targets.
- Keep checks non-destructive; prefer warnings first, not hard failures.
- Run:
  - structural file checks
  - CSS syntax checks
  - `npm run check`
  - `npm run check:design`
