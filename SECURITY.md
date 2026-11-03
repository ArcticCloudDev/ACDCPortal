# Security Posture

Last verified: 2026-11-03. Enforced by `npm test` (see tests below) — violations fail CI.

## Enforcement model

| Layer | Mechanism | Verified by |
|---|---|---|
| Roles | Portal admin (`Users.IsPortalAdmin`) is the bootstrap super admin; it is set in the database only, no endpoint grants it. Committee members are full admins on every event: `requireAuth()` looks up the caller's participations on every request and sets `user.isAdmin` for portal admins and anyone holding the committee role, so a role change applies immediately. Judges are local admins of their own event: the full event roster with names and contact details, all of that event's teams, and badge review/award; no global people list or person lookup. Only admins grant judge or committee roles. | `tests/data-access-policy.test.js`, `tests/e2e/specs/30-access-control.spec.js` |
| Authentication | Custom email+OTP login issues a JWT (8h, `x-acdc-token` header, issuer `acdc-portal`). `await requireAuth()` inside every handler — `authLevel` is not the gate. `register/complete` and `invitations/{id}/accept` re-issue the session so a token minted before the account existed is replaced. | `tests/api-auth-posture.test.js` invokes all 103 endpoints unauthenticated: everything returns 401 except 11 pinned public routes (login/registration flows, invitation read/accept, public event/badge reads) and the secret-guarded scheduler (503). `interest/record` requires the lead's own session (401/403). |
| Secrets | All secrets live in Azure Key Vault (`acdc-portal-kv`), loaded at runtime. No fallback signing secret exists — missing `JWT_SECRET` fails closed. | `tests/auth-config.test.js` |
| Object-level access | Non-admins only read their own data: own participations (`by-person`, `participations-get`), own queue position, own teams. Event rosters are projected for regular participants (no emails; hotel data only within own team). Admins see full records; judges see full records for their own event only. | `tests/data-access-policy.test.js` |
| Mutation authority | Self-service requests cannot assign privileged roles, alter identity fields, grant team-admin status, or move a participation across teams. Team assignment and team-role changes require an admin or the authorized team administrator. | `tests/data-access-policy.test.js` |
| Scheduler | `POST /api/scheduled-emails/run` requires `x-scheduler-secret` (timing-safe compare); fails closed (503) if unconfigured. | posture test |
| Team deletion | Destructive team deletion is admin-only (portal admin or committee). Team owners and participants cannot delete teams, even with a valid or guessed team ID. | `tests/team-delete-cascade.test.js` |
| Account removal | `DELETE /members/{id}`: self or an admin removes the account (child rows first, in one transaction); a team administrator can only detach a member of their own team. | `tests/e2e/specs/70-api-core.spec.js` |
| Rate limiting | `auth-send-otp`, `auth-verify-otp`, and `auth-check-email` all have per-IP and per-email limits. The client IP is the right-most `X-Forwarded-For` hop (appended by the SWA edge); client-written hops and `x-client-ip` are ignored (`shared/auth.js getClientIp`). The OTP row's `CreatedAt` gives a 60 s per-email cooldown that holds across Function instances. Verification codes are never logged outside `AZURE_FUNCTIONS_ENVIRONMENT=Development`, and a failed send is reported as 502, never as success. | `tests/otp-rate-limit-separation.test.js`, `70-api-core.spec.js` |
| Input validation | Route/body IDs are checked with `isGuid()` (malformed → 4xx, never a SQL conversion 500); profile/team/invitation fields are allow-listed and length-limited (`shared/validate.js`); error responses carry fixed messages only. | `70-api-core.spec.js` |
| Email templating | `processTemplate()` HTML-escapes merged values; only `RAW_HTML_KEYS` (pre-built fragments) are inserted raw. Subjects are rendered with `{ html: false }`. | `70-api-core.spec.js` (escaped team name in invitation) |
| Injection | All SQL goes through `mssql` parameterized `.input()` bindings. | audited 2026-08 |

## Accepted risks (reviewed, deliberate)

1. **Invitation links are capability URLs.** `invitations-get`/`invitations-accept` are reachable with the invitation GUID from the email link. Accept additionally requires a logged-in session whose JWT email matches the invitation email, so the link alone cannot be used to join as someone else.
2. **Service principal credentials are portable.** The SWA Free tier has no managed identity; the "ACDC Portal App" SP secret in SWA app settings can read Key Vault from anywhere. Mitigation: only two identities hold Key Vault data-plane roles (admin account + SP). Fix requires SWA Standard + managed identity.
3. **Key Vault has public network access.** A firewall would break free-tier SWA managed functions (no stable egress IPs). Access is gated by Entra RBAC only.

## Rotation expectations

- `JWT-SECRET`: rotate after any suspected token compromise; invalidates all sessions instantly.
- SP client secret ("ACDC Portal App"): expires 2028-01; rotate earlier if SWA config viewers change.
- `SCHEDULER-SECRET`: created 2026-04, no expiry set — rotate annually.

## Adding a new endpoint

1. Call `await requireAuth(request, context)` first, before touching storage or parsing beyond the body.
2. Add `{ requireAdmin: true }` for admin surfaces (portal admin or committee); check `auth.user.isAdmin`, never `isPortalAdmin`, for admin rights; otherwise apply an ownership check (`canManageUser`, `isTeamMember`, `isTeamAuthorized`, `hasEventRole`).
3. `npm test` fails if the endpoint serves unauthenticated requests — public endpoints must be explicitly added to the allowlist in `tests/api-auth-posture.test.js` with review.
