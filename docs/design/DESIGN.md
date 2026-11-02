# ACDC Portal – design guide

Work in progress. The graphics are still being developed, so this document
describes the *rules* rather than a finished visual identity. Update it as
decisions are made.

## Identity

- Product: **ACDC Portal** – Arctic Cloud Developer Challenge.
- Logo: `src/images/ACDCLogo.png`. Fallback mark: 🏔️ (used in the header and favicon).
- Tone: friendly, clear, hackathon energy. Not corporate, not flashy.
- Two surfaces, one brand:
  - **Participant portal** – events, registration, my page, team admin.
  - **Admin area** – `admin-*.html`, sidebar layout.

## Tokens – one shared set

Design tokens are CSS custom properties defined **once**, in the `:root` block
of `src/css/styles.css`. Every stylesheet and every page uses these variables.

Current tokens (`src/css/styles.css`):

| Token | Role |
|---|---|
| `--primary-color` / `--primary-hover` | Brand colour, buttons, active states, links |
| `--secondary-color` | Secondary actions |
| `--success-color` / `--error-color` | Status feedback |
| `--background` / `--card-bg` | Page and card surfaces |
| `--text-color` / `--text-muted` | Text |
| `--border-color` / `--border-radius` | Borders and rounding |

Rules:

1. **Never hardcode a colour, radius or shadow** in a stylesheet or HTML.
   Use a token. If a needed token does not exist, add it to `:root` in
   `styles.css` and document it here.
2. **Change the brand by changing tokens**, not by editing dozens of rules.
3. `src/css/admin-styles.css` still carries its own `--admin-*` variables.
   This is legacy. Target state: admin uses the shared tokens above and keeps
   only layout-specific variables (sidebar width etc.). Migrate opportunistically
   when touching admin styles. Do not add new `--admin-*` colour tokens.

## Typography

System stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.
No web fonts until decided otherwise. Body 16px on the portal, 14px in admin.

## Components (where things live)

| Component | Location |
|---|---|
| Site header (title, subtitle, sign-in, info badges) | `src/js/site-header.js`, styled in `styles.css` |
| Cards, tabs, buttons, forms, badges | `src/css/styles.css` |
| Admin layout, sidebar, tables | `src/css/admin-styles.css`, `src/js/admin-sidebar.js` |

Reuse an existing component before inventing a new one.

## Pages

Participant: `events.html`, `event.html`, `register.html`, `complete-registration.html`,
`accept-invitation.html`, `login.html`, `my-page.html`, `team-admin.html`, `interest.html`.
`index.html` only redirects to `events.html`.

Admin: all `admin-*.html`.

## Responsiveness and accessibility

- Must work at 360px width and up. Check phone width for every change.
- Keep contrast at WCAG AA. Respect `prefers-reduced-motion` for any animation.
- Keep semantic HTML. Do not replace buttons and links with divs.

## Verification

1. `npm run dev`, open http://localhost:4280 (use `/dev-login` for a signed-in view).
2. Check one participant page and one admin page, desktop and phone width.
3. `npm test` (API/policy tests must still pass).

## Decisions log

- 2026-09-24: One shared token set, owned by `styles.css`. Admin `--admin-*` colours are legacy.
