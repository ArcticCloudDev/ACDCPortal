# ACDC Portal — Security Remediation Task List

## Status: Completed

All remediation items in this document have been completed and validated.

- [x] Task 1 — team list filtering
- [x] Task 2 — team detail authorization
- [x] Task 3 — badge claim access restrictions
- [x] Task 4 — participation privacy guard
- [x] Task 5 — solo queue response minimization
- [x] Task 6 — stack trace disclosure removal
- [x] Task 7 — repo-wide 500 response cleanup
- [x] Task 8 — timing-safe scheduler secret comparison
- [x] Task 9 — invitation record minimization
- [x] Task 10 — invite acceptance requires verified session
- [x] Task 11 — check-email rate limiting
- [x] Task 12 — public endpoint review
- [x] Task 13 — `authLevel` semantics clarification
- [x] Task 14 — security smoke regression script
- [x] Task 15 — localStorage/token lifetime review

> **Verification:** the edited JavaScript files passed `node --check`, and the final response-surface scan returned: `OK: no 500 response block returns raw error internals`.

> **Audience:** an AI coding agent executing tasks one at a time.
> **Rule:** Do ONE task per commit. After each task, run `node --check` on every file you edited. Do not refactor anything not named in the task.

## Background you MUST read before starting

Auth helpers live in [api/src/shared/auth.js](api/src/shared/auth.js) and are already exported:

| Helper | Signature | Returns true when |
|---|---|---|
| `requireAuth` | `requireAuth(request, context, { requireAdmin })` | returns `{authorized:true, user}` or `{authorized:false, status, jsonBody}` |
| `isTeamMember` | `isTeamMember(user, teamId, participations)` | caller is portal admin OR any-role member of that team |
| `isTeamAuthorized` | `isTeamAuthorized(user, team, participations)` | caller is portal admin OR that team's admin |
| `canManageUser` | `canManageUser(callerUser, targetUserId, participations)` | caller is self, portal admin, or team admin sharing a team |
| `hasEventRole` | `hasEventRole(user, eventId, role, participations)` | caller is portal admin OR holds role (`judge`/`committee`) for that event |

`auth.user` shape: `{ email, userId, isPortalAdmin, iat, exp, iss }`.

**Standard authorization pattern used in this codebase** — copy this shape exactly:

```js
const auth = requireAuth(request, context);
if (!auth.authorized) {
    return { status: auth.status, jsonBody: auth.jsonBody };
}
// ...load participations, then object-level check...
if (!isTeamMember(auth.user, teamId, participations)) {
    return { status: 403, jsonBody: { message: 'You do not have permission to view this resource' } };
}
```

**Never** return `error.message` or `error.stack` to the client. Use `await logError(context, error)` then return a generic message.

---

## SEVERITY 1 — BROKEN OBJECT-LEVEL AUTHORIZATION (IDOR)
*Any logged-in user can read other people's data today. These are the real data-breach risks. Fix these first.*

---

### TASK 1 — `GET /api/teams` returns every team to every authenticated user

- **File:** [api/src/functions/teams.js](api/src/functions/teams.js)
- **Function:** `app.http('teams-list', ...)`
- **Problem:** After `requireAuth`, the handler calls `Storage.teams.getAll()` and returns all teams with no filtering. Any authenticated user enumerates every team in the system.

**Fix:**
1. Change the import on line 5 to include `isTeamMember`:
   ```js
   const { requireAuth, isTeamAuthorized, isTeamMember } = require('../shared/auth');
   ```
2. In the `teams-list` handler, after the existing `eventId` filter and before returning, add team-scope filtering:
   ```js
   // Object-level authorization: non-admins only see teams they belong to.
   if (!auth.user.isPortalAdmin) {
       const participations = await new GenericStorage('participations').getAll();
       teams = teams.filter(t => isTeamMember(auth.user, t.id, participations));
   }
   ```

**Acceptance criteria:**
- Portal admin still receives all teams.
- A non-admin user receives only teams they are a member of.
- An authenticated user with no team membership receives `[]`, not a 500.

---

### TASK 2 — `GET /api/teams/{id}` returns any team to any authenticated user

- **File:** [api/src/functions/teams.js](api/src/functions/teams.js)
- **Function:** `app.http('teams-get', ...)`
- **Problem:** Loads `Storage.teams.getById(teamId)` and returns it with **zero** ownership check.

**Fix:** After the `if (!team) { ...404... }` block and before the `return { status: 200, jsonBody: team }`, insert:
```js
const participations = await new GenericStorage('participations').getAll();
if (!isTeamMember(auth.user, teamId, participations)) {
    return {
        status: 403,
        jsonBody: { message: 'You do not have permission to view this team' }
    };
}
```

**Acceptance criteria:**
- Member of the team → `200`.
- Portal admin → `200`.
- Authenticated non-member → `403`.
- Unknown team id → still `404` (do not leak existence to non-members; returning 404 for non-members is also acceptable and preferred).

---

### TASK 3 — `GET /api/badge-claims` returns every badge claim of every team

- **File:** [api/src/functions/badges.js](api/src/functions/badges.js)
- **Function:** `app.http('badge-claims-list', ...)`
- **Problem:** `badgeClaimsStorage.getAll()` is filtered only by optional query params (`eventId`, `teamId`, `status`, `badgeId`) — never by who is asking. Any authenticated user reads all teams' submissions.
- **Note:** imports on line 5 already include `isTeamMember` and `hasEventRole`. No import change needed.

**Fix:** After the four query-param filters and **before** the "Enrich with badge details" block, insert:
```js
// Object-level authorization: restrict to claims the caller may see.
if (!auth.user.isPortalAdmin) {
    const participations = await participationsStorage.getAll();
    claims = claims.filter(c => {
        // Judges/committee for that event may review claims in their event.
        if (c.eventId && (hasEventRole(auth.user, c.eventId, 'judge', participations)
            || hasEventRole(auth.user, c.eventId, 'committee', participations))) {
            return true;
        }
        // Otherwise only claims belonging to a team the caller is a member of.
        return c.teamId && isTeamMember(auth.user, c.teamId, participations);
    });
}
```

**Acceptance criteria:**
- Portal admin → all claims.
- Judge/committee of event X → claims for event X.
- Regular team member → only their own team's claims.
- User with no team and no role → `[]`.

---

### TASK 4 — `GET /api/participations?email=…` lets any user look up any person

- **File:** [api/src/functions/participations.js](api/src/functions/participations.js)
- **Function:** `app.http('participations-get', ...)`
- **Problem:** Accepts `userId` **or** `email` query param and returns that person's participation record (roles, team memberships, hotel nights) with no check that the caller is allowed to see it. This is a direct personal-data leak.

**Fix:** After the participation is found and before the migration-support lines, insert:
```js
// Object-level authorization: caller must be self, portal admin, or a team
// admin who shares a team with the target user.
const isSelf =
    (participation.userId && participation.userId === auth.user.userId) ||
    (participation.email && auth.user.email &&
     participation.email.toLowerCase() === auth.user.email.toLowerCase());

if (!isSelf && !canManageUser(auth.user, participation.userId, participations)) {
    return {
        status: 403,
        jsonBody: { error: 'You do not have permission to view this participation' }
    };
}
```
Ensure `canManageUser` is present in the `require('../shared/auth')` destructuring at the top of the file; add it if missing.

**Acceptance criteria:**
- Querying your own email/userId → `200`.
- Portal admin querying anyone → `200`.
- Team admin querying a member of their team → `200`.
- Any other authenticated user querying a stranger → `403`.
- Not-found case must still return `200` with `null` **before** the auth check runs (do not turn a miss into a 403 that confirms non-existence).

---

### TASK 5 — Solo queue exposes the full participant list

- **File:** [api/src/functions/solo-queue.js](api/src/functions/solo-queue.js)
- **Functions:** `app.http('solo-queue-get', ...)` and `app.http('solo-queue-position', ...)`
- **Problem:** Both call `soloQueueStorage.getAll()` and return the whole queue (all `userId`s, notes, positions) to any authenticated user.

**Fix for `solo-queue-get`:** after the existing filtering, restrict what non-admins see:
```js
// Non-admins may only see their own entry, plus an aggregate count.
if (!auth.user.isPortalAdmin) {
    const own = queue.filter(e => e.userId === auth.user.userId);
    return {
        status: 200,
        jsonBody: { entries: own, totalCount: queue.length }
    };
}
```
**Fix for `solo-queue-position`:** return only the caller's own position number and the total, never the array:
```js
if (!auth.user.isPortalAdmin) {
    const index = queue.findIndex(e => e.userId === auth.user.userId);
    return {
        status: 200,
        jsonBody: { position: index === -1 ? null : index + 1, totalCount: queue.length }
    };
}
```

**Acceptance criteria:**
- Admin behaviour unchanged.
- Non-admin cannot obtain another user's queue entry or userId.
- **Frontend follow-up:** check [src/js/](src/js) and [src/](src) pages for callers of `API.soloQueue.get` / `getPosition` and update them to read the new `{ entries, totalCount }` / `{ position, totalCount }` shape. Do not skip this — verify the solo-queue UI still renders.

---

## SEVERITY 2 — INFORMATION DISCLOSURE

---

### TASK 6 — Stack trace returned to the browser

- **File:** [api/src/functions/email.js](api/src/functions/email.js)
- **Location:** the `catch` in the `email-preview` handler, currently:
  ```js
  return { status: 500, jsonBody: { error: error.message, stack: error.stack } };
  ```
- **Problem:** Leaks absolute file paths, internal module names, and often fragments of config/connection data.

**Fix:** replace that line with:
```js
await logError(context, error);
return { status: 500, jsonBody: { error: 'Failed to generate preview' } };
```

**Then sweep the same file:** replace every `jsonBody: { error: error.message }` in a `500` handler with a static string (`'Internal server error'`). Keep `400`/`404` messages that are intentional validation text (e.g. `'templateId is required'`).

**Acceptance criteria:** `grep -rn "error.stack" api/src` returns no results inside a response body.

---

### TASK 7 — Repo-wide sweep for leaked error internals

- **Scope:** all files in [api/src/functions/](api/src/functions)
- **Problem:** Several handlers return `{ error: error.message }` on `500`, which can surface driver/SQL/SMTP internals.

**Fix:** For every `catch` block returning HTTP `500`, ensure the shape is:
```js
await logError(context, error);
context.error('<Endpoint name> error:', error);
return { status: 500, jsonBody: { message: 'Internal server error' } };
```
Files known to need this: [api/src/functions/email.js](api/src/functions/email.js), [api/src/functions/interest.js](api/src/functions/interest.js), [api/src/functions/system-emails.js](api/src/functions/system-emails.js), [api/src/functions/invitations.js](api/src/functions/invitations.js).

**Acceptance criteria:** no `500` response in `api/src/functions/` contains `error.message` or `error.stack`.

---

### TASK 8 — Timing-unsafe scheduler secret comparison

- **File:** [api/src/functions/scheduled-emails.js](api/src/functions/scheduled-emails.js)
- **Problem:** `if (!provided || provided !== expectedSecret)` — plain `!==` on a secret.

**Fix:**
```js
const crypto = require('crypto');

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}
```
Then use `if (!provided || !safeEqual(provided, expectedSecret))`.
Also confirm the handler returns `401` with a generic body and never echoes the expected secret.

---

## SEVERITY 3 — UNAUTHENTICATED SURFACE HARDENING

---

### TASK 9 — Invitation record over-disclosure

- **File:** [api/src/functions/invitations.js](api/src/functions/invitations.js)
- **Function:** `app.http('invitations-get', ...)` — `authLevel: 'anonymous'`, no `requireAuth`
- **Problem:** Anyone holding (or guessing) an invitation UUID receives the **entire** invitation row spread into the response (`...invitation`), including invitee email and internal fields. The UUID is the only secret.

**Fix:** Return an explicit allow-list instead of spreading the record:
```js
return {
    status: 200,
    jsonBody: {
        id: invitation.id,
        role: invitation.role,
        teamId: invitation.teamId,
        teamName: invitation.teamName || null,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        isExpired,
        emailHint: invitation.email
            ? invitation.email.replace(/^(.).*(@.*)$/, '$1***$2')
            : null,
        eventName, eventStartDate, eventEndDate, eventLocation
    }
};
```
Do **not** return the raw `email`, any `createdBy` internal ids, or tokens.

**Acceptance criteria:** response no longer contains a full plaintext invitee email address; the accept-invitation page still works (it should compare emails server-side, not client-side).

---

### TASK 10 — Invitation acceptance trusts a client-supplied email

- **File:** [api/src/functions/invitations.js](api/src/functions/invitations.js)
- **Function:** `app.http('invitations-accept', ...)` — `authLevel: 'anonymous'`
- **Problem:** The caller POSTs `userEmail`; the server only checks it equals `invitation.email`. Possession of the invite URL is therefore sufficient to create/claim an account — no proof the caller controls that mailbox.

**Fix (preferred):** require a verified session. At the top of the handler:
```js
const auth = requireAuth(request, context);
if (!auth.authorized) {
    return { status: auth.status, jsonBody: auth.jsonBody };
}
if (!auth.user.email ||
    auth.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    return { status: 403, jsonBody: { error: 'Email does not match invitation' } };
}
```
…and ignore the body's `userEmail`/`userId`, deriving them from `auth.user` instead.

**Frontend follow-up:** [src/accept-invitation.html](src/accept-invitation.html) must send the user through the existing OTP flow **before** calling accept, then call it with the session token. Confirm the invite → OTP → accept path works end to end before closing this task.

---

### TASK 11 — Account enumeration on `check-email`

- **File:** [api/src/functions/auth-check-email.js](api/src/functions/auth-check-email.js)
- **Problem:** Returns `isNewUser: true/false`, which lets anyone test whether an address is registered. `send-otp` already has rate limiting; this endpoint does not.

**Fix:** Add the same IP + email rate limiting used in [api/src/functions/auth-send-otp.js](api/src/functions/auth-send-otp.js) (reuse that module's limiter rather than writing a new one). Cap at e.g. 10 attempts / 15 min / IP and return `429` beyond that.

**Note:** the `isNewUser` flag drives the registration UX, so keep the field — mitigate with rate limiting rather than removing it.

---

### TASK 12 — Confirm public read endpoints are intentional

- **Files:** [api/src/functions/events.js](api/src/functions/events.js), [api/src/functions/badges.js](api/src/functions/badges.js)
- **Anonymous, unauthenticated today:** `events-list`, `events-active`, `events-get`, `badges-list`, `badges-get`, `event-badges-list`, `event-badge-summary`.
- **Action:** For each, verify the returned object contains **no** personal data. Specifically check `event-badge-summary` and `event-badges-list` — if either returns judge names, judge user ids, or per-participant claim details, add `requireAuth` + `hasEventRole` gating. Event marketing metadata may stay public.

**Acceptance criteria:** no endpoint reachable without a token returns any person's name, email, or user id.

---

## SEVERITY 4 — DEFENCE IN DEPTH

---

### TASK 13 — Re-verify `authLevel` semantics

- **Files:** [api/src/functions/users.js](api/src/functions/users.js) (all five handlers now `authLevel: 'anonymous'`)
- **Context:** `authLevel` is the Azure Functions **host key** gate, not app auth. `'anonymous'` here is correct/necessary; the real gate is `requireAuth` inside each handler.
- **Action:** Confirm every handler in `users.js` still begins with a `requireAuth` call and that `users-get-all` passes `{ requireAdmin: true }`. Add a one-line comment above each `authLevel: 'anonymous'` noting the handler enforces JWT internally, so nobody "fixes" it later by deleting the auth check.

---

### TASK 14 — Automated authorization regression test

- **Create:** `api/scripts/security-smoke.ps1`
- **Purpose:** prove no regression. The script must, against a supplied base URL:
  1. Call each sensitive route with **no** token → assert `401`.
  2. Call each sensitive route with a **valid non-admin** token → assert `200` only for own-data routes and `403`/filtered results for others.
  3. Print a PASS/FAIL table.
- **Routes to cover:** `/users`, `/users/all`, `/users/{id}`, `/teams`, `/teams/{id}`, `/participations`, `/participations/all`, `/badge-claims`, `/solo-queue`, `/invitations/{id}`, `/email/campaigns`, `/sequences`, `/errors`, `/interest`.
- **Acceptance criteria:** script exits non-zero if any sensitive route returns `200` without a token.

---

### TASK 15 — Token storage & lifetime review

- **Files:** [src/js/auth.js](src/js/auth.js), [api/src/functions/auth-verify-otp.js](api/src/functions/auth-verify-otp.js)
- **Findings to address:**
  1. JWT is stored in `localStorage` → readable by any XSS. Document the risk; if feasible, move to a `Secure; HttpOnly; SameSite=Strict` cookie.
  2. Token lifetime is 24h with no server-side revocation. Consider shortening to 8h.
  3. Add a `Content-Security-Policy` header via `globalHeaders` in [staticwebapp.config.json](staticwebapp.config.json) to reduce XSS impact — start in report-only mode.

---

## Verified NON-issues (do not "fix", no action needed)

- **SQL injection:** all queries in the storage layer use `mssql` parameterised `.input()` bindings. Table names are interpolated but come from internal constants, never user input.
- **Privilege escalation via profile update:** `users-update` and `users-create` already `delete updates.isPortalAdmin`.
- **Admin-only surfaces:** email campaigns, sequences, deliveries, interest lists, errors, system-emails, event financials, sponsors, and `participations/all` all correctly pass `{ requireAdmin: true }`.
- **Mutation endpoints:** every POST/PUT/PATCH/DELETE calls `requireAuth`.

---

## Suggested execution order

1. Tasks 1–5 (active IDOR data leaks) — **do these today**
2. Tasks 6–8 (information disclosure)
3. Tasks 9–11 (unauthenticated surface)
4. Task 14 (regression test to lock the fixes in)
5. Tasks 12, 13, 15 (hardening)
