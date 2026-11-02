---
name: acdc-design
description: Make graphic and visual changes to the ACDC Portal (colours, layout, spacing, typography, components, pages) in line with the shared design guide and token set. Use whenever a task mentions design, look, style, CSS, theme, colours, branding, layout, header, cards, buttons or "make it look better" in this repo.
---

# ACDC Portal design skill

You are making a visual change to the ACDC Portal, a plain HTML/CSS/JS site.
Read `docs/design/DESIGN.md` first. It is the source of truth and this skill
only tells you how to apply it.

## Procedure

1. **Read the guide.** Open `docs/design/DESIGN.md`. Note the token table and the
   component locations.
2. **Find the existing thing.** Before writing CSS, grep `src/css/` for a rule or
   token that already does what you need. Reuse it.
3. **Work through tokens.**
   - Colour, radius, shadow: use a `var(--...)` from the `:root` block in `src/css/styles.css`.
   - Need a new one? Add it to `:root` in `src/css/styles.css`, then add a row
     to the token table in `DESIGN.md`.
   - Do not add new `--admin-*` colour tokens. If you touch admin styles, swap
     hardcoded or `--admin-*` colours for the shared tokens.
4. **Keep the change small and in scope.** Files you may edit:
   - `src/css/*.css`
   - `src/*.html` (markup and classes only, no logic)
   - `src/js/site-header.js`, `src/js/admin-sidebar.js` (presentation only)
   - `src/images/`

   Files you must not edit for a graphic change: anything in `api/`,
   `src/js/auth.js`, `src/js/permissions.js`, `src/js/api.js`,
   `src/data/role-permissions.json`, `staticwebapp.config.json`.
5. **No new dependencies.** No frameworks, CDN scripts, web fonts, preprocessors
   or build steps unless the user explicitly asks and DESIGN.md is updated.
6. **Verify.**
   - `npm run dev` and open http://localhost:4280 (`/dev-login` for a signed-in view).
   - Check at least one participant page and one admin page at desktop and ~360px width.
     Use a browser tool or screenshot if available.
   - Run `npm test`.
7. **Record decisions.** If you made a design decision that others should follow
   (a new token, a new component pattern), add a line to the decisions log in
   `DESIGN.md`.

## Quality bar

- Consistent with the existing pages. A change to one button style applies to all.
- WCAG AA contrast, visible focus states, semantic HTML.
- Respect `prefers-reduced-motion`. Animate only `transform` and `opacity`.
- Works at 360px and up without horizontal scrolling.

## When done

Report which files changed, which tokens were added or changed, and what you
verified visually. Point out anything in DESIGN.md that is now out of date.
