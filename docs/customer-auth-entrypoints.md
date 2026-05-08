# Customer Auth Entry Points

## Current launch posture

- `customer-login-v2.html` is the canonical customer sign-in entrypoint.
- `customer-login.html` is a legacy compatibility shim/redirect path and should remain in place for launch stability.
- Staff authentication remains separate via staff login flow and staff tokens.

## Why this remains split

- Customer and staff auth boundaries are intentionally separate for role isolation.
- Keeping the legacy customer page as a shim avoids breaking bookmarked links and older navigation paths right before launch.

## Post-launch cleanup path

- Keep both pages during launch stabilization.
- After launch, monitor customer login traffic and confirm shim usage drops.
- Then retire/redirect legacy entrypoint in a planned cleanup release with explicit comms and regression checks.
