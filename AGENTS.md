# ACDC Portal – instructions for coding agents

This file is read by all coding agents (Copilot, Claude Code, Codex, Cursor, Gemini).
Keep it short. Detailed knowledge lives in the files it links to.

## What this is

Team registration portal for ACDC (Arctic Cloud Developer Challenge).

- `src/` – static HTML/CSS/JS frontend. No build step, no framework.
- `api/` – Azure Functions v4 (Node.js) backend. Azure SQL, Key Vault, Graph.
- `dev/mock-api/` – local mock server: `npm run dev` serves the site on http://localhost:4280
- `tests/` – API/policy tests: `npm test`

Setup: [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md). Security rules: [SECURITY.md](SECURITY.md).

## Design and graphics

All look-and-feel work follows [docs/design/DESIGN.md](docs/design/DESIGN.md).
One shared token set, defined in `src/css/styles.css`. Never hardcode colours.

For graphic changes, use the **acdc-designer** agent / **acdc-design** skill
(`.claude/skills/acdc-design/SKILL.md`, mirrored in `.github/skills/acdc-design/SKILL.md`).

## Rules that apply to every agent

- Graphic or content changes must never touch `api/`, `src/js/auth.js`,
  `src/js/permissions.js`, `src/data/role-permissions.json` or `staticwebapp.config.json`.
- Do not add frameworks, bundlers, CSS preprocessors or CDN libraries. The site is plain files.
- Verify visually with `npm run dev` and run `npm test` before finishing.
- Never commit secrets. `api/local.settings.json` is gitignored for a reason.
