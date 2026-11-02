# Developer Setup Guide

This guide gets a new developer running the ACDC Portal locally and explains what can and cannot be tested without access to the team's Azure resources.

The app is two pieces glued together by Azure Static Web Apps routing:
- `src/` — static HTML/CSS/JS frontend (no build step)
- `api/` — Azure Functions v4 (Node.js) backend

For safe local full-stack work, use the E2E harness: it runs the real frontend and API handlers against a local SQL Server and substitutes local fakes for cloud services. Do not start the Functions API directly with `func start` in this checkout: the normal SQL client is hard-coded to the production database, and local settings may load production Key Vault secrets.

---

## 0. Fastest path: mock dev server (frontend work, no Azure at all)

If you only need to work on HTML/CSS/JS, skip everything below and run the mock server. It serves `src/` and answers every `/api/*` call from in-memory sample data.

```powershell
npm install
npm run dev
```

Open **http://localhost:4280/dev-login** and pick a user (portal admin, team admin, participant, judge). Or use the normal login page with any of those emails and the OTP code `123456`.

- Edit anything in `src/`, refresh the browser. No build step.
- Sample data lives in `dev/mock-api/fixtures.js`. Change it freely; it resets on restart and never reaches Azure.
- Endpoints the mock does not implement return an empty list, so pages never crash. The server logs each unmocked call.
- Not covered: sending mail, SharePoint uploads, reCAPTCHA, real OTP. Use the tiers below for those.

The `dev/` folder is not part of the Static Web App build (`app_location` is `/src`), so nothing here is deployed.

---

## 1. Prerequisites (install these first)

| Tool | Why | Check |
|---|---|---|
| [Node.js 22 LTS](https://nodejs.org/) | Runs the API and scripts (production runs `node:22`, pinned in `src/staticwebapp.config.json`) | `node -v` |
| [Git](https://git-scm.com/) | Clone the repo | `git --version` |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Runs the isolated SQL Server used by local full-stack tests | `docker info` |
| VS Code (optional) | Editing and debugging | — |

Azure Functions Core Tools, SWA CLI, and Azure CLI are not required for the safe local workflow below.

---

## 2. Clone and install

```powershell
git clone https://github.com/thomassandsor/ACDCPortal.git
cd ACDCPortal
npm ci               # root - test runner and local harness tooling
cd api
npm ci               # @azure/functions, mssql, @azure/identity, @azure/keyvault-secrets, jsonwebtoken, etc.
cd ..
```

There's no `npm run build` step for the frontend — `src/` is served as-is.

---

## 3. Local settings and production safety

`api/local.settings.json` is gitignored and is not used by the E2E harness. Do not copy production secrets into it or assume that blanking its values makes `func start` safe: `api/src/shared/sql.js` currently hard-codes the production SQL server and database. The regular Functions startup can also load secrets from the configured Key Vault and send real mail.

Until the API has an explicit, validated non-production SQL configuration, use the local harness below for all local full-stack work. It clears Azure-related environment variables, substitutes the SQL client, blocks outbound cloud requests from the API, captures email in memory, and uses an in-memory SharePoint fake.

---

## 4. Running the full system locally

Install dependencies from the repository root and in `api/` (see §2), then start the safe local harness:

```powershell
npm run e2e:harness
```

The harness starts the local SQL Server container if needed, runs the API handlers and serves `src/` on **http://127.0.0.1:4280**. It does not read `api/local.settings.json`. Email is captured in the harness outbox (`GET /__test/outbox?to=...`), SharePoint is simulated in memory, and reCAPTCHA is allowed in the local development environment. The database is the local `acdc_e2e` database; do not point the harness at production or a forwarded remote database.

To populate a demo event, team, participants, and admin, and receive a local login code, run this from the repository root while the harness is running:

```powershell
npm run e2e:seed-demo
```

Use the printed email and one-time code to sign in through the normal login page. Each seed uses unique test email addresses. The test-control endpoints are local harness features and must never be deployed.

To run the automated browser suite instead, use `npm run test:e2e`. Playwright starts an isolated harness on port 4281 and resets its test database before each test. See [tests/e2e/README.md](tests/e2e/README.md) for the suite, test data helpers, and harness controls.

---

## 5. What's testable without any Azure access (Tier 1)

Run the automated test suite — it's fully self-contained, mocks `@azure/functions`, storage, SQL, mail, Key Vault, and SharePoint via `require.cache` substitution:

```powershell
npm test
```

This covers: every endpoint requires auth as expected (`api-auth-posture.test.js`), object-level access control / IDOR checks (`data-access-policy.test.js`), cascade deletes, JWT session handling, rate limiting logic, capacity/commitment rules, etc. No Azure login, no secrets, no network calls.

Also fully testable offline:
- Frontend UI/UX, static routing, CSS/JS changes
- JWT issuing/verification logic (just needs any `JWT_SECRET` value)
- Business logic that doesn't touch SQL/Graph directly (best exercised via the mocked test suite above, not by clicking through the UI)

---

### End-to-end tests (Docker, still no Azure access)

`npm run test:e2e` runs a Playwright suite against the real frontend and the real API handlers on a throwaway local SQL Server container, with mail, SharePoint and reCAPTCHA faked and all Azure access blocked. It needs Docker Desktop. See [tests/e2e/README.md](tests/e2e/README.md).

---

## 6. What needs a separate Azure development environment

Some integration behavior requires real Azure resources. Use a separate development environment, never production. Note that the current SQL client is hard-coded to production, so merely provisioning a dev database or granting access to it does not make `func start` safe or redirect the API to that database. A configurable, validated non-production SQL target must be implemented before using the regular Functions host against Azure.

| Feature | What's needed | Notes |
|---|---|---|
| SQL-backed data (events, users, teams, badges...) | A separate Azure SQL DB, plus an implemented non-production connection target | Do not connect this branch's normal API to SQL until the target is configurable and guarded against production. |
| Key Vault secrets | `Key Vault Secrets User` RBAC role on a **dev** Key Vault | Use only dev credentials and a dev Key Vault; never point local settings at the production vault. |

Do not grant developers production database or Key Vault access for local work. The local harness is the supported path while the API's Azure SQL target remains hard-coded.

---

## 7. What's difficult or impossible to fully test locally (Tier 3)

| Feature | Why it's hard locally | What you *can* do instead |
|---|---|---|
| **Sending real email** (OTP, invitations, announcements, sequence digests) | Uses Microsoft Graph `Mail.Send` application permission via `api/src/shared/mail.js`. | The local harness captures messages in memory. Use a separately approved dev mail app only for verifying live delivery; never use production mail credentials for local testing. |
| **SharePoint file upload/download** (`files.js`) | Needs a real SharePoint site and app permissions. | The local harness uses an in-memory fake. Use a separate dev SharePoint site for live integration checks. |
| **reCAPTCHA verification** (`auth-send-otp.js`, `register.js` via `captcha.js`) | Live verification depends on Google configuration for the site/domain. | The harness allows local requests in Development. Use a separate dev/test key for live integration checks, not the production key. |
| **Scheduled email jobs** (`scheduled-emails.js` / sequence digests) | In production this is invoked by an external Logic App calling `scheduled-emails-run` with an `X-Scheduler-Secret` header. | You can invoke the endpoint manually with `curl`/Postman using a dev `SCHEDULER_SECRET`, but there's no local scheduler — you have to trigger it by hand. |
| **Managed Identity behavior** | Local dev always uses `DefaultAzureCredential` → your `az login` identity, never a Static Web Apps managed identity. Free-tier SWA doesn't support managed identity at all — prod uses a service principal (`AZURE_CLIENT_ID/SECRET/TENANT_ID`). | Not something you can validate locally at all; only verifiable after deploying to the actual SWA resource. |

**Bottom line:** the unit tests and local harness cover business logic, access control, UI flows, SQL-backed behavior, and email content without production access. Live Graph, SharePoint, and reCAPTCHA integrations require separately configured development resources.

---

## 8. Quick reference: minimum viable local setup

If you just want to write and test code without asking anyone for access:

1. Install Node 22 and Docker Desktop (§1), then run `npm ci` in the root and `api/` (§2).
2. Run `npm test` for the fast unit/security feedback loop (§5).
3. Run `npm run e2e:harness` and open http://127.0.0.1:4280 for interactive full-stack work (§4).
4. Run `npm run test:e2e` to exercise browser flows against isolated local SQL and fake cloud services.
5. Do not use `func start` with production settings or push changes to `main` unless you intend to deploy to production.
