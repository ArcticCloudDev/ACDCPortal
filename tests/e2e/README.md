# End-to-end tests (Playwright)

Full-stack tests: the real `src/` frontend in Chromium, talking to the real `api/` Azure Functions handlers, backed by a real SQL Server — all on your machine. Nothing in `api/` or `src/` is modified to make this work.

```
Chromium ──► harness (Node, :4281) ──► api/src/functions/*.js (unmodified)
               │  serves src/ with staticwebapp.config.json rules        │
               │  /__test/* control endpoints                            ▼
               └──────────────────────────────────────────► SQL Server 2022 (Docker, 127.0.0.1:14333)
   Graph sendMail ─► in-memory outbox      SharePoint ─► in-memory fake
   Key Vault / Azure credentials / any other host ─► blocked (throws)
```

## Why it never touches Azure

`api/local.settings.json` points `KEY_VAULT_URL` at the **production** Key Vault, and `api/src/shared/sql.js` hard-codes the production database. `func start` with that config would read prod secrets, write prod data and send real email. The harness (`harness/server.js`) therefore:

- strips `KEY_VAULT_URL`, `AZURE_*`, `MAIL_*`, `SHAREPOINT_*`, `RECAPTCHA_*` from the environment and sets local test values;
- replaces `shared/sql.js` with a pool to the local container (and refuses any non-localhost SQL host);
- replaces `@azure/identity`, `@azure/keyvault-secrets` with versions that throw, and `@azure/msal-node` with a fake token issuer;
- patches `fetch` so Graph `sendMail` lands in an in-memory outbox and every other non-localhost request throws.

The real `mail.js` still builds the Graph payload (inline images, batching), so email content is exercised end to end.

## Running

Prerequisites: Docker Desktop running, Node 18+, `npm install` in the repo root **and** in `api/`, then once:

```powershell
npx playwright install chromium
```

| Command | What it does |
|---|---|
| `npm run test:e2e` | Full suite (~6 min). Starts the SQL container and the harness automatically. |
| `npx playwright test tests/e2e/specs/20-event-team.spec.js` | One spec file. |
| `npx playwright test -g "solo queue"` | Tests whose title matches. |
| `npm run test:e2e:ui` | Playwright UI mode (watch, time-travel debugging). |
| `npm run test:e2e:report` | Open the HTML report (traces, videos, screenshots of failures). |
| `node tests/e2e/support/audit-bug-pins.js` | Verify every BUG pin failed at its symptom line (run after a suite run). |
| `npm run e2e:harness` | Run the harness alone on :4280 to click around manually. |
| `npm run e2e:db:stop` | Stop the SQL container. |

Artifacts (report, traces, `harness.log` with every function's log output) go to `tests/e2e/.artifacts/` (gitignored).

## Layout

| Path | Purpose |
|---|---|
| `playwright.config.js` (repo root) | Serial run (`workers: 1`, one shared DB), webServer = harness on :4281. |
| `harness/server.js` | Loads every function file, routes `/api/*` with Functions-host precedence (literal segments beat `{params}`), serves `src/`, exposes `/__test/*`. |
| `harness/db.js` | Container lifecycle, schema apply, truncate. |
| `harness/schema-drift.sql` | Columns production has that `scripts/create-tables.sql` lacks (see below). |
| `harness/fake-sharepoint.js` | Same interface and error strings as `shared/sharepoint.js`, in memory. |
| `fixtures.js` | Per-test DB reset, CDN stubs, error tracking, `loginAs`, `apiAs`, `dialogs`, `harness`. |
| `support/factories.js`, `support/world.js` | Seed data builders and a standard "event + team + people" world. |
| `specs/*.spec.js` | The tests. |

### `/__test/*` control endpoints (harness only)

`POST /__test/reset`, `POST /__test/seed` (inserts through the app's own storage layer), `GET /__test/outbox?to=`, `POST /__test/mail/fail-next {count}`, `GET /__test/invocations`, `GET /__test/routes`, `GET /__test/sharepoint/files`.

## Schema drift

`scripts/create-tables.sql` cannot bootstrap a working database: every event create/update, participation insert and invitation fails on a fresh DB built from it. Production received several one-time migrations that were later deleted from the repo without updating the script. `harness/schema-drift.sql` reconstructs them from git history (each block cites its commit).

Columns that no migration, doc or DDL ever created (e.g. `Teams.CommittedParticipants`, `Events.HotelNights`) are deliberately **not** added, so the tests surface the code paths that write them.

**Recommended:** export the production schema (`INFORMATION_SCHEMA.COLUMNS`), fold it into `scripts/create-tables.sql`, and delete `schema-drift.sql`.

## Writing tests

- Every test starts from an empty database. Seed what you need: `await harness.seed(buildWorld().seed())`; combine collections with `mergeSeeds(a, b)`.
- IDs are **uppercase** GUIDs. SQL Server returns `UNIQUEIDENTIFIER` uppercase via tedious and the API compares IDs with `===`, so lowercase IDs make authorization checks fail in confusing ways.
- `loginAs(user)` puts a real signed session in `localStorage` (same token a real OTP login issues). `apiAs(user)` gives an API client with that token; `apiAs(null)` is anonymous.
- The real OTP flow is covered in `10-auth`/`11-registration`; use `harness.otpFor(email)` to read a code from the outbox.
- A test fails automatically on any uncaught page error or any API 5xx. Opt out per describe block with `test.use({ allowPageErrors: true })` / `test.use({ allowServerErrors: true })`.
- `confirm`/`alert`/`prompt` are auto-accepted and recorded; `dialogs.next('dismiss')` or `dialogs.next({ value: 'x' })` queues an answer, `dialogs.last()` reads the latest.
- CSS animations and transitions are disabled; `window.print`/`window.open` are stubbed.
- Don't assert list order unless the code sorts (most queries have no `ORDER BY` and keys are random GUIDs).

### BUG pins

Confirmed defects are pinned as tests of the **correct** behaviour, marked expected-to-fail:

```js
test('BUG: a participant can leave the solo queue', async ({ ... }) => {
    test.fail(true, 'why it fails, with file:line');
    ...
    await expect.poll(() => dialogs.last()?.message).toBe('...');  // <- bug
});
```

- When a fix lands, Playwright reports the pin as **"expected to fail, but passed"**. Remove the `test.fail(...)` line and it becomes a normal regression test.
- `test.fail` passes on *any* failure, so the `// <- bug` marker records where the symptom is. `audit-bug-pins.js` flags pins that died earlier, in setup.

## Contract for refactoring and optimisation

1. All non-BUG tests must stay green.
2. BUG pins either still fail at their marker or flip to passing because the bug was fixed. Then remove `test.fail`.
3. Run `node tests/e2e/support/audit-bug-pins.js` and `npm test` (unit/security posture) as well.
4. Behaviour changes that are intended need the test changed in the same commit, with the reason.

## What this does not cover

- The SWA edge itself (auth proxy, header rewriting). The harness mirrors `staticwebapp.config.json` routing but is not the SWA runtime.
- Real Graph/SharePoint/reCAPTCHA behaviour (throttling, permissions, scoring).
- Timer triggers (there are none; the scheduler is an HTTP endpoint and is tested).
- Cross-browser: only Chromium is configured.
