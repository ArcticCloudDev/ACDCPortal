# Security Posture

Last verified: 2026-08-26. Enforced by `npm test` (see tests below) — violations fail CI.

## Enforcement model

| Layer | Mechanism | Verified by |
|---|---|---|
| Authentication | Custom email+OTP login issues a JWT (8h, `x-acdc-token` header). `requireAuth()` inside every handler — `authLevel` is not the gate. | `tests/api-auth-posture.test.js` invokes all 119 endpoints unauthenticated: everything returns 401 except 13 pinned public routes (login/registration flows, invitation accept, public event/badge reads) and the secret-guarded scheduler (503). |
| Secrets | All secrets live in Azure Key Vault (`acdc-portal-kv`), loaded at runtime. No fallback signing secret exists — missing `JWT_SECRET` fails closed. | `tests/auth-config.test.js` |
| Object-level access | Non-admins only read their own data: own participations (`by-person`, `participations-get`), own queue position, own teams. Event rosters are projected for regular participants (no emails; hotel data only within own team). Admin/judge/committee roles see full records where required. | `tests/data-access-policy.test.js` |
| Mutation authority | Self-service requests cannot assign privileged roles, alter identity fields, grant team-admin status, or move a participation across teams. Team assignment and team-role changes require the portal admin or authorized team administrator. | `tests/data-access-policy.test.js` |
| Scheduler | `POST /api/scheduled-emails/run` requires `x-scheduler-secret` (timing-safe compare); fails closed (503) if unconfigured. | posture test |
| Rate limiting | `auth-send-otp`, `auth-verify-otp`, and `auth-check-email` all have per-IP and per-email limits. | `tests/otp-rate-limit-separation.test.js` |
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

1. Call `requireAuth(request, context)` first, before touching storage or parsing beyond the body.
2. Add `{ requireAdmin: true }` for admin surfaces; otherwise apply an ownership check (`canManageUser`, `isTeamMember`, `isTeamAuthorized`, `hasEventRole`).
3. `npm test` fails if the endpoint serves unauthenticated requests — public endpoints must be explicitly added to the allowlist in `tests/api-auth-posture.test.js` with review.
