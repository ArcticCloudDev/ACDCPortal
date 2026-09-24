# Developer Setup Guide

This guide gets a new developer from a fresh machine to a running local copy of the ACDC Portal, and explains exactly what can and cannot be tested without access to the team's Azure resources.

The app is two pieces glued together by Azure Static Web Apps routing:
- `src/` — static HTML/CSS/JS frontend (no build step)
- `api/` — Azure Functions v4 (Node.js) backend

There is no local database, no local file storage, and no local mail server — the API talks directly to Azure SQL, Azure Key Vault, Microsoft Graph (mail + SharePoint) and reCAPTCHA. That's the main thing that makes "run it locally" different from "test it end-to-end locally."

---

## 1. Prerequisites (install these first)

| Tool | Why | Check |
|---|---|---|
| [Node.js 18+ LTS](https://nodejs.org/) | Runs the API and any scripts | `node -v` |
| [Git](https://git-scm.com/) | Clone the repo | `git --version` |
| [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local) | Runs `api/` locally (`func start`) | `func --version` (`npm i -g azure-functions-core-tools@4 --unsafe-perm true`) |
| [Azure Static Web Apps CLI](https://azure.github.io/static-web-apps-cli/) | Serves `src/` + proxies `/api/*` to Functions Core Tools, mimics production routing/`staticwebapp.config.json` | `swa --version` (`npm i -g @azure/static-web-apps-cli`) |
| [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) | Needed only if you want live-Azure secrets/data (see Tier 2/3 below) | `az --version` |
| VS Code + Azure Functions extension (optional but recommended) | Debugging the API | — |

No Docker, no local SQL Server, no local storage emulator is used by this project.

---

## 2. Clone and install

```powershell
git clone https://github.com/thomassandsor/ACDCPortal.git
cd ACDCPortal
npm install          # root - test runner only, no runtime deps
cd api
npm install           # @azure/functions, mssql, @azure/identity, @azure/keyvault-secrets, jsonwebtoken, etc.
cd ..
```

There's no `npm run build` step for the frontend — `src/` is served as-is.

---

## 3. Local configuration file (`api/local.settings.json`)

This file is gitignored (never commit real secrets to it). Create/edit `api/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "",

    "JWT_SECRET": "any-random-string-at-least-32-chars-long",
    "PORTAL_URL": "http://localhost:4280",

    "KEY_VAULT_URL": "",

    "RECAPTCHA_SECRET_KEY": "",
    "MAIL_CLIENT_ID": "",
    "MAIL_CLIENT_SECRET": "",
    "MAIL_TENANT_ID": "",
    "MAIL_SENDER": "",
    "SHAREPOINT_CLIENT_ID": "",
    "SHAREPOINT_CLIENT_SECRET": "",
    "SHAREPOINT_TENANT_ID": "",
    "SHAREPOINT_SITE_URL": "",
    "SHAREPOINT_DOC_LIBRARY": "",
    "SCHEDULER_SECRET": ""
  }
}
```

Two ways to fill this in, depending on what you need (see tiers below):

- **Tier 1/2 (no Azure access needed):** leave everything except `JWT_SECRET`/`PORTAL_URL` blank. The app boots, auth/JWT works, but SQL/mail/SharePoint/reCAPTCHA calls will fail or no-op.
- **Tier 3 (full parity):** set `KEY_VAULT_URL` to the shared dev Key Vault and run `az login` — `api/src/shared/keyvault.js` uses `DefaultAzureCredential`, so once you're logged into the Azure CLI with an account that's been granted `Key Vault Secrets User` on that vault, secrets are pulled automatically at Functions cold start. You don't need to copy secret values into `local.settings.json` by hand.

---

## 4. Running it locally

Two terminals:

```powershell
# Terminal 1 — API
cd api
func start
```

```powershell
# Terminal 2 — SWA CLI (serves frontend + proxies /api/* to func start, applies staticwebapp.config.json routing)
swa start src --api-location http://localhost:7071
```

Open **http://localhost:4280** (the SWA CLI's port) — not the raw `func start` port and not a plain static file server, or routing/rewrites from `staticwebapp.config.json` won't match production behavior.

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

## 6. What needs *some* Azure access, but can use a shared "dev" tier (Tier 2)

These require real Azure resources, but ones that can safely be shared with the whole team using a **separate dev copy**, not production:

| Feature | What's needed | Notes |
|---|---|---|
| SQL-backed data (events, users, teams, badges...) | An Azure SQL DB + Entra ID login for each dev | `api/src/shared/sql.js` authenticates via `DefaultAzureCredential` (Entra ID token), no SQL password. Each developer needs `az login` + to be added as a database user (`db_datareader`, `db_datawriter`, `EXECUTE`) on a **dev** database, not `acdc-portal-db` prod. |
| Key Vault secrets | `Key Vault Secrets User` RBAC role on a **dev** Key Vault | Recommended: clone the vault's secrets into a `acdc-portal-kv-dev` vault so nobody needs prod mail/SharePoint credentials to run the app. |

**Recommendation:** provision a `-dev` resource group (`External_Team_Portal_Dev` or similar) with its own SQL DB (seeded via `scripts/create-tables.sql` + `scripts/reset-test-data.js`) and its own Key Vault. Grant every contributor `Key Vault Secrets User` + a SQL Entra login there. This is the only "shared secret" that's safe to hand out broadly, since it's not prod data or prod mail-sending credentials.

---

## 7. What's difficult or impossible to fully test locally (Tier 3)

| Feature | Why it's hard locally | What you *can* do instead |
|---|---|---|
| **Sending real email** (OTP, invitations, announcements, sequence digests) | Uses Microsoft Graph `Mail.Send` application permission via `api/src/shared/mail.js`, which needs a real Entra app registration + admin-consented permission + a licensed mailbox (`MAIL_SENDER`) to send from. Each dev doesn't need — and shouldn't get — their own copy of this app registration. | Point `MAIL_CLIENT_ID/SECRET/TENANT_ID` at a **shared dev mail app** (separate from prod) sending from a low-stakes test mailbox. Verify the *email content/templates* by rendering them directly (`api/src/shared/email-builder.js`, `invitation-email.js`, `welcome-email.js` build HTML strings you can print/inspect without sending). For OTP flows, log the OTP server-side in dev instead of only emailing it (temporary, dev-only change — never do this in prod). |
| **SharePoint file upload/download** (`files.js`) | Needs a real SharePoint site + `Sites.ReadWrite.All`/`Files.ReadWrite.All` app permission. | Share one dev SharePoint site + app registration across the team, same reasoning as mail above. There's no local/offline file-storage fallback in this codebase (it was intentionally removed — SQL/SharePoint are the only backends). |
| **reCAPTCHA verification** (`auth-send-otp.js`, `register.js` via `captcha.js`) | Google reCAPTCHA validates the site key against the *registered domain*; it won't validate for `localhost` unless `localhost` is explicitly added to the reCAPTCHA admin console for that site key. | Register `localhost` as an allowed domain on a **dev/test reCAPTCHA site key** (Google allows multiple domains per key) and use that key's secret in local dev, not the production key. |
| **Scheduled email jobs** (`scheduled-emails.js` / sequence digests) | In production this is invoked by an external Logic App calling `scheduled-emails-run` with an `X-Scheduler-Secret` header. | You can invoke the endpoint manually with `curl`/Postman using a dev `SCHEDULER_SECRET`, but there's no local scheduler — you have to trigger it by hand. |
| **Managed Identity behavior** | Local dev always uses `DefaultAzureCredential` → your `az login` identity, never a Static Web Apps managed identity. Free-tier SWA doesn't support managed identity at all — prod uses a service principal (`AZURE_CLIENT_ID/SECRET/TENANT_ID`). | Not something you can validate locally at all; only verifiable after deploying to the actual SWA resource. |

**Bottom line:** auth, business logic, access control, and UI can all be fully developed and tested locally/offline via `npm test` and the SWA CLI. Actually *sending* email, *uploading* files to SharePoint, and *live* reCAPTCHA checks require a shared, non-production set of Azure/Graph/Google resources — provisioning a parallel "-dev" set of these (Key Vault, SQL DB, mail app registration, SharePoint site, reCAPTCHA key) is the standard way other contributors get a working end-to-end environment without ever touching production secrets or sending real customer emails.

---

## 8. Quick reference: minimum viable local setup

If you just want to write and test code without asking anyone for access:

1. Install prerequisites (§1), clone, `npm install` in root and `api/` (§2).
2. Create `api/local.settings.json` with only `JWT_SECRET` and `PORTAL_URL` set (§3).
3. Run `npm test` from the repo root — this is your primary feedback loop for backend logic (§5).
4. Run `func start` + `swa start src --api-location http://localhost:7071` to click through the UI; expect SQL/mail/SharePoint/reCAPTCHA-dependent features to fail until you're granted dev Azure access (§6/§7).
