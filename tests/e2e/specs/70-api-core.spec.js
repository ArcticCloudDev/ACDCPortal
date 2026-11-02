// API core & security: authorization matrices, input validation, rate limiting and
// session refresh for the account/team/invitation endpoints. Pure API tests (no page).
const { test, expect, f, signToken } = require('../fixtures');
const { buildWorld, mergeSeeds } = require('../support/world');
const jwt = require('../../../api/node_modules/jsonwebtoken');
const { JWT_SECRET } = require('../fixtures');
const db = require('../harness/db');

async function rows(query, params = {}) {
    const pool = await db.getPool();
    const req = pool.request();
    for (const [k, v] of Object.entries(params)) req.input(k, v);
    return (await req.query(query)).recordset;
}
test.afterAll(async () => { await db.closePool(); });

const BOGUS = 'not-a-guid';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

test.describe('members-remove authorization', () => {
    test('an outsider cannot remove anyone, an admin and the person themselves can', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const loner = await apiAs(w.loner);
        expect((await loner.delete(`/api/members/${w.member.id}`, { data: {} })).status()).toBe(403);
        expect((await loner.delete(`/api/members/${w.admin.id}`, { data: {} })).status()).toBe(403);
        expect(await rows('SELECT Id FROM Users WHERE Id IN (@a, @b)', { a: w.member.id, b: w.admin.id })).toHaveLength(2);

        expect((await loner.delete(`/api/members/${w.loner.id}`, { data: {} })).status()).toBe(200);
        expect(await rows('SELECT Id FROM Users WHERE Id = @id', { id: w.loner.id })).toHaveLength(0);
        expect(await rows('SELECT Id FROM Participations WHERE UserId = @id', { id: w.loner.id })).toHaveLength(0);

        const admin = await apiAs(w.admin);
        expect((await admin.delete(`/api/members/${w.member.id}`, { data: {} })).status()).toBe(200);
        expect(await rows('SELECT Id FROM Users WHERE Id = @id', { id: w.member.id })).toHaveLength(0);
    });

    test('a team admin removes a member from their own team only, keeping the account', async ({ apiAs, harness }) => {
        const w = buildWorld();
        const other = f.user({ email: 'other.olga@e2e.test' });
        const otherTeam = f.team(w.event, other, { teamName: 'Other Team' });
        await harness.seed(mergeSeeds(w.seed(), {
            users: [other], teams: [otherTeam],
            participations: [f.participation(other, w.event, { teamId: otherTeam.id, isTeamAdmin: true, roles: ['participant'] })]
        }));
        const leader = await apiAs(w.leader);
        // Not on the leader's team.
        expect((await leader.delete(`/api/members/${other.id}`, { data: {} })).status()).toBe(403);
        // Bogus or non-member team id in the body is refused.
        expect((await leader.delete(`/api/members/${w.member.id}`, { data: { teamId: BOGUS } })).status()).toBe(400);
        expect((await leader.delete(`/api/members/${w.member.id}`, { data: { teamId: otherTeam.id } })).status()).toBe(400);
        expect((await leader.delete(`/api/members/${BOGUS}`, { data: {} })).status()).toBe(400);
        expect((await leader.delete(`/api/members/${UNKNOWN}`, { data: {} })).status()).toBe(404);

        const res = await leader.delete(`/api/members/${w.member.id}`, { data: { teamId: w.team.id } });
        expect(res.status()).toBe(200);
        const [p] = await rows('SELECT TeamId, IsTeamAdmin FROM Participations WHERE Id = @id', { id: w.participations.member.id });
        expect(p).toEqual({ TeamId: null, IsTeamAdmin: false });
        expect(await rows('SELECT Id FROM Users WHERE Id = @id', { id: w.member.id })).toHaveLength(1);
    });
});

test.describe('invitations', () => {
    test('create: authorization, validation and capacity', async ({ apiAs, harness }) => {
        const w = buildWorld({ event: { maxTeamSize: 4 } });
        w.team.numberOfParticipants = 4;
        await harness.seed(w.seed());
        const loner = await apiAs(w.loner);
        const leader = await apiAs(w.leader);

        // Only team admins invite to a team; event-level/role invitations are admin-only.
        expect((await loner.post('/api/invitations', { data: { email: 'x@e2e.test', teamId: w.team.id } })).status()).toBe(403);
        expect((await loner.post('/api/invitations', { data: { email: 'x@e2e.test', eventId: w.event.id } })).status()).toBe(403);
        expect((await loner.post('/api/invitations', { data: { email: 'x@e2e.test', eventId: w.event.id, role: 'judge' } })).status()).toBe(403);
        expect((await leader.post('/api/invitations', { data: { email: 'x@e2e.test', eventId: w.event.id, role: 'judge' } })).status()).toBe(403);

        // Validation.
        expect((await leader.post('/api/invitations', { data: { email: 'not-an-email', teamId: w.team.id } })).status()).toBe(400);
        expect((await leader.post('/api/invitations', { data: { email: 'x@e2e.test', teamId: w.team.id, role: 'overlord' } })).status()).toBe(400);
        expect((await leader.post('/api/invitations', { data: { email: 'x@e2e.test', teamId: BOGUS } })).status()).toBe(400);
        expect((await leader.post('/api/invitations', { data: { email: 'x@e2e.test', teamId: UNKNOWN } })).status()).toBe(404);
        expect((await leader.post('/api/invitations', { data: { email: 'x@e2e.test', teamId: w.team.id, inviteeFirstName: 'a'.repeat(101) } })).status()).toBe(400);

        // Capacity: 2 members + 2 invitations fill a team of 4.
        expect((await leader.post('/api/invitations', { data: { email: 'third@e2e.test', teamId: w.team.id } })).status()).toBe(201);
        expect((await leader.post('/api/invitations', { data: { email: 'fourth@e2e.test', teamId: w.team.id } })).status()).toBe(201);
        const full = await leader.post('/api/invitations', { data: { email: 'fifth@e2e.test', teamId: w.team.id } });
        expect(full.status()).toBe(400);
        expect((await full.json()).error).toMatch(/full/i);
    });

    test('an HTML team name arrives escaped in the invitation email', async ({ apiAs, harness }) => {
        const w = buildWorld();
        w.team.teamName = '<b>Bold</b> & "Brave"';
        await harness.seed(w.seed());
        const res = await (await apiAs(w.leader)).post('/api/invitations', {
            data: { email: 'escaped.erik@e2e.test', teamId: w.team.id, inviteeFirstName: '<i>Erik</i>', inviteeLastName: 'E' }
        });
        expect(res.status()).toBe(201);
        const mail = await harness.waitForMail('escaped.erik@e2e.test');
        expect(mail.html).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;Brave&quot;');
        expect(mail.html).not.toContain('<b>Bold</b>');
        expect(mail.html).not.toContain('<i>Erik</i>');
        expect(mail.html).toMatch(/accept-invitation\.html\?invite=[0-9a-f-]{36}/i);
    });

    test('resend has a cooldown and reports a failed send as 502 JSON', async ({ apiAs, harness }) => {
        const w = buildWorld();
        const sentAt = Date.now() - 5 * 60_000;
        const inv = f.invitation(w.event, w.leader, { teamId: w.team.id, teamName: w.team.teamName, email: 'pending.pia@e2e.test',
            createdAt: new Date(sentAt).toISOString(), expiresAt: new Date(sentAt + 7 * 24 * 3600e3).toISOString() });
        await harness.seed({ ...w.seed(), invitations: [inv] });
        const leader = await apiAs(w.leader);

        await harness.failNextMail(1);
        const failed = await leader.post(`/api/invitations/${inv.id}/resend`);
        expect(failed.status()).toBe(502);
        expect((await failed.json()).error).toMatch(/could not be sent/i);
        // A failed send does not extend the expiry, so the next attempt is still allowed.
        expect((await leader.post(`/api/invitations/${inv.id}/resend`)).status()).toBe(200);
        expect((await leader.post(`/api/invitations/${inv.id}/resend`)).status()).toBe(429);
        expect((await (await apiAs(w.loner)).post(`/api/invitations/${inv.id}/resend`)).status()).toBe(403);
    });

    test('judge invitation links point at accept-invitation.html and accepting creates the judge', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const res = await (await apiAs(w.admin)).post('/api/invitations', {
            data: { email: 'jo.judge@e2e.test', eventId: w.event.id, role: 'judge' }
        });
        expect(res.status()).toBe(201);
        const inv = await res.json();
        const mail = await harness.waitForMail('jo.judge@e2e.test');
        expect(mail.html).toContain(`/accept-invitation.html?invite=${inv.id}`);

        // The invitee has no account yet: the OTP session carries userId null.
        const jo = await apiAs({ email: 'jo.judge@e2e.test', id: null });
        expect((await jo.post(`/api/invitations/${inv.id}/accept`)).status()).toBe(400);
        const accepted = await jo.post(`/api/invitations/${inv.id}/accept`, { data: { profile: { firstName: 'Jo', lastName: 'Judge' } } });
        expect(accepted.status()).toBe(200);
        const body = await accepted.json();
        expect(body.user).toMatchObject({ email: 'jo.judge@e2e.test', firstName: 'Jo', isPortalAdmin: false });
        const claims = jwt.verify(body.token, JWT_SECRET, { issuer: 'acdc-portal' });
        expect(claims).toMatchObject({ email: 'jo.judge@e2e.test', userId: body.user.id, isPortalAdmin: false });
        const [p] = await rows('SELECT Roles FROM Participations WHERE UserId = @u', { u: body.user.id });
        expect(p.Roles).toBe('judge');
        // The fresh token works immediately.
        const fresh = await apiAs(null, { 'x-acdc-token': body.token });
        expect((await fresh.get(`/api/participations?userId=${body.user.id}&eventId=${w.event.id}`)).status()).toBe(200);
    });

    test('cancel only applies to pending invitations and removes the provisional stub', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const leader = await apiAs(w.leader);
        const created = await (await leader.post('/api/invitations', {
            data: { email: 'stub.stina@e2e.test', teamId: w.team.id, inviteeFirstName: 'Stina', inviteeLastName: 'Stub' }
        })).json();
        expect(await rows("SELECT Id FROM Users WHERE Email = 'stub.stina@e2e.test'")).toHaveLength(1);

        expect((await leader.delete(`/api/invitations/${created.id}`)).status()).toBe(200);
        expect(await rows("SELECT Id FROM Users WHERE Email = 'stub.stina@e2e.test'")).toHaveLength(0);
        expect(await rows("SELECT Id FROM Participations WHERE Email = 'stub.stina@e2e.test'")).toHaveLength(0);
        expect((await leader.delete(`/api/invitations/${created.id}`)).status()).toBe(400);
        expect((await leader.get(`/api/invitations/${BOGUS}`)).status()).toBe(404);
    });
});

test.describe('OTP endpoint hardening', () => {
    test('a spoofed X-Forwarded-For cannot bypass the per-IP limit', async ({ apiAs }) => {
        // The SWA edge appends the real client IP as the right-most hop; everything a client
        // puts before it is ignored, so varying it does not open a fresh bucket.
        const api = await apiAs(null);
        let last;
        for (let i = 0; i < 12; i++) {
            last = await api.post('/api/auth/send-otp', {
                data: { email: `probe${i}@e2e.test` },
                headers: { 'x-forwarded-for': `10.0.${i}.${i}, 198.51.100.7:4${i}000` }
            });
            if (i < 10) expect(last.status(), `request ${i}`).toBe(200);
        }
        expect(last.status()).toBe(429);
        // A different real client (different right-most hop) is unaffected.
        const other = await api.post('/api/auth/send-otp', {
            data: { email: 'someone@e2e.test' }, headers: { 'x-forwarded-for': '203.0.113.9' }
        });
        expect(other.status()).toBe(200);
    });

    test('the per-email cooldown is enforced from the database, and malformed input is 400', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const api = await apiAs(null);
        expect((await api.post('/api/auth/send-otp', { data: { email: w.leader.email } })).status()).toBe(200);
        // Fresh in-memory state (as another Function instance would have) must still honour the cooldown.
        const otpModule = require('../../../api/src/functions/auth-send-otp');
        otpModule.rateLimits.byEmail.clear();
        expect((await api.post('/api/auth/send-otp', { data: { email: w.leader.email } })).status()).toBe(429);
        expect(await harness.outbox(w.leader.email)).toHaveLength(1);

        expect((await api.post('/api/auth/send-otp', { data: { email: 'nope' } })).status()).toBe(400);
        expect((await api.post('/api/auth/verify-otp', { data: { email: w.leader.email, code: 'abc' } })).status()).toBe(400);
        expect((await api.post('/api/auth/check-email', { data: { email: 'nope' } })).status()).toBe(400);
        expect((await api.post('/api/auth/send-otp', { data: 'garbage' })).status()).toBe(400);
    });
});

test.describe('interest/record requires the lead\'s own session', () => {
    test('401 anonymous, 403 for another email, 200 for self, 400 for bad input', async ({ apiAs, harness }) => {
        const w = buildWorld({ event: { status: 'pre-registration' } });
        const closed = f.event({ status: 'completed' });
        await harness.seed(mergeSeeds(w.seed(), { events: [closed] }));
        const data = { eventId: w.event.id, email: 'keen.kari@e2e.test', firstName: 'Kari', lastName: 'Keen' };
        expect((await (await apiAs(null)).post('/api/interest/record', { data })).status()).toBe(401);
        expect((await (await apiAs(w.loner)).post('/api/interest/record', { data })).status()).toBe(403);
        const kari = await apiAs({ email: 'Keen.Kari@e2e.test', id: null });
        expect((await kari.post('/api/interest/record', { data: { ...data, eventId: BOGUS } })).status()).toBe(400);
        expect((await kari.post('/api/interest/record', { data: { ...data, eventId: UNKNOWN } })).status()).toBe(404);
        expect((await kari.post('/api/interest/record', { data: { ...data, eventId: closed.id } })).status()).toBe(400);
        expect((await kari.post('/api/interest/record', { data: { ...data, firstName: 'x'.repeat(101) } })).status()).toBe(400);
        expect((await kari.post('/api/interest/record', { data })).status()).toBe(200);
        expect(await rows("SELECT Verified FROM InterestLeads WHERE Email = 'keen.kari@e2e.test'")).toEqual([{ Verified: true }]);
    });
});

test.describe('users', () => {
    test('PUT honours an allow-list and validates lengths', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const loner = await apiAs(w.loner);
        const res = await loner.put(`/api/users/${w.loner.id}`, {
            data: { firstName: 'Sol', isPortalAdmin: true, teamId: w.team.id, invitationPending: true, bogusColumn: 'x', email: 'hijack@e2e.test' }
        });
        expect(res.status()).toBe(200);
        const [u] = await rows('SELECT FirstName, IsPortalAdmin, TeamId, InvitationPending, Email FROM Users WHERE Id = @id', { id: w.loner.id });
        expect(u).toEqual({ FirstName: 'Sol', IsPortalAdmin: false, TeamId: null, InvitationPending: false, Email: w.loner.email });

        expect((await loner.put(`/api/users/${w.loner.id}`, { data: { firstName: 'x'.repeat(101) } })).status()).toBe(400);
        expect((await loner.put(`/api/users/${w.loner.id}`, { data: { phone: 12345 } })).status()).toBe(400);
        expect((await loner.put(`/api/users/${BOGUS}`, { data: { firstName: 'x' } })).status()).toBe(404);
        expect((await loner.get(`/api/users/${BOGUS}`)).status()).toBe(404);
        expect((await loner.put(`/api/users/${w.member.id}`, { data: { firstName: 'x' } })).status()).toBe(403);
    });

    test('POST creates only the caller\'s own record', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const newcomer = await apiAs({ email: 'new.nora@e2e.test', id: null });
        expect((await newcomer.post('/api/users', { data: { email: 'someone.else@e2e.test', firstName: 'N' } })).status()).toBe(403);
        const res = await newcomer.post('/api/users', { data: { email: 'new.nora@e2e.test', firstName: 'Nora', isPortalAdmin: true, teamId: w.team.id } });
        expect(res.status()).toBe(201);
        const [u] = await rows("SELECT IsPortalAdmin, TeamId FROM Users WHERE Email = 'new.nora@e2e.test'");
        expect(u).toEqual({ IsPortalAdmin: false, TeamId: null });
        expect((await newcomer.post('/api/users', { data: { email: 'new.nora@e2e.test' } })).status()).toBe(409);
    });
});

test.describe('teams', () => {
    test('names are unique per event and sizes stay within the event bounds', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const leader = await apiAs(w.leader);
        const loner = await apiAs(w.loner);

        expect((await loner.post('/api/teams', { data: { teamName: 'power rangers', committedParticipants: 3 } })).status()).toBe(409);
        expect((await loner.post('/api/teams', { data: { teamName: 'X', committedParticipants: 3 } })).status()).toBe(400);
        expect((await loner.post('/api/teams', { data: { teamName: 'Too Big', committedParticipants: 6 } })).status()).toBe(400);
        expect((await loner.post('/api/teams', { data: { teamName: 'Too Small', committedParticipants: 2 } })).status()).toBe(400);
        expect((await loner.post('/api/teams', { data: { teamName: 'Elsewhere', committedParticipants: 3, eventId: BOGUS } })).status()).toBe(400);
        const created = await loner.post('/api/teams', { data: { teamName: '  Aurora  ', committedParticipants: 3 } });
        expect(created.status()).toBe(201);
        expect((await created.json()).teamName).toBe('Aurora');
        expect((await loner.post('/api/teams', { data: { teamName: 'Second', committedParticipants: 3 } })).status()).toBe(400);

        // committedParticipants is an alias for numberOfParticipants (contract 6).
        const upd = await leader.put(`/api/teams/${w.team.id}`, { data: { committedParticipants: 5 } });
        expect(upd.status()).toBe(200);
        expect((await upd.json()).numberOfParticipants).toBe(5);
        expect((await leader.put(`/api/teams/${w.team.id}`, { data: { numberOfParticipants: 1 } })).status()).toBe(400);
        expect((await leader.put(`/api/teams/${w.team.id}`, { data: { teamName: 'aurora' } })).status()).toBe(409);
        expect((await leader.put(`/api/teams/${w.team.id}`, { data: { presentationFile: 'x' } })).status()).toBe(200);
        expect((await loner.put(`/api/teams/${w.team.id}`, { data: { teamName: 'Hijacked' } })).status()).toBe(403);
        expect((await leader.put(`/api/teams/${BOGUS}`, { data: { teamName: 'x' } })).status()).toBe(404);
    });

    test('members are derived from participations and the count is members-only', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const members = await (await (await apiAs(w.member)).get(`/api/teams/${w.team.id}/members`)).json();
        expect(members.map(m => m.email).sort()).toEqual([w.leader.email, w.member.email].sort());
        expect(members.find(m => m.id === w.leader.id).isTeamAdmin).toBe(true);
        expect(members[0].phone).toBeUndefined();

        const loner = await apiAs(w.loner);
        expect((await loner.get(`/api/participations/team/${w.team.id}/count`)).status()).toBe(403);
        const count = await (await (await apiAs(w.leader)).get(`/api/participations/team/${w.team.id}/count`)).json();
        expect(count).toMatchObject({ participantCount: 2, adminCount: 1, maxParticipants: 5 });
        expect((await loner.get(`/api/participations/team/${BOGUS}/count`)).status()).toBe(404);
    });
});

test.describe('solo queue', () => {
    test('validation, real position and self-only visibility', async ({ apiAs, harness }) => {
        const w = buildWorld();
        const closed = f.event({ status: 'completed', registrationOpen: false });
        await harness.seed(mergeSeeds(w.seed(), { events: [closed] }));
        const loner = await apiAs(w.loner);
        const member = await apiAs(w.member);

        expect((await loner.post('/api/solo-queue', { data: { userId: w.loner.id, eventId: BOGUS } })).status()).toBe(400);
        expect((await loner.post('/api/solo-queue', { data: { userId: w.loner.id, eventId: UNKNOWN } })).status()).toBe(404);
        expect((await loner.post('/api/solo-queue', { data: { userId: w.loner.id, eventId: closed.id } })).status()).toBe(400);
        expect((await loner.post('/api/solo-queue', { data: { userId: w.member.id, eventId: w.event.id } })).status()).toBe(403);
        expect((await member.post('/api/solo-queue', { data: { userId: w.member.id, eventId: w.event.id } })).status()).toBe(400);
        expect((await loner.post('/api/solo-queue', { data: { userId: w.loner.id, eventId: w.event.id, note: 'x'.repeat(501) } })).status()).toBe(400);

        const joined = await loner.post('/api/solo-queue', { data: { userId: w.loner.id, eventId: w.event.id, note: 'hi' } });
        expect(joined.status()).toBe(201);
        expect(await joined.json()).toMatchObject({ position: 1, totalCount: 1, status: 'waiting' });
        expect((await loner.post('/api/solo-queue', { data: { userId: w.loner.id, eventId: w.event.id } })).status()).toBe(400);

        const pos = await (await loner.get(`/api/solo-queue/position/${w.event.id}/${w.loner.id}`)).json();
        expect(pos).toMatchObject({ inQueue: true, position: 1, totalCount: 1 });
        expect(pos.entry).toMatchObject({ eventId: w.event.id, userId: w.loner.id, note: 'hi', status: 'waiting' });
        expect((await member.get(`/api/solo-queue/position/${w.event.id}/${w.loner.id}`)).status()).toBe(403);
        expect(await (await member.get(`/api/solo-queue/position/${w.event.id}/${w.member.id}`)).json()).toEqual({ inQueue: false });
        expect((await loner.get(`/api/solo-queue/position/${BOGUS}/${w.loner.id}`)).status()).toBe(200);

        // Joining a team removes the queue entry.
        const admin = await apiAs(w.admin);
        expect((await admin.put(`/api/participations/${w.participations.loner.id}/team`, { data: { teamId: w.team.id } })).status()).toBe(200);
        expect(await rows('SELECT Id FROM SoloQueue WHERE UserId = @u', { u: w.loner.id })).toHaveLength(0);
    });
});

test.describe('registration', () => {
    test('register/complete returns a session token that works immediately', async ({ apiAs, harness }) => {
        const event = f.event({ name: 'ACDC 2027' });
        await harness.seed({ events: [event] });
        const anon = await apiAs(null);
        const start = await anon.post('/api/register/start', {
            data: { email: 'captain@e2e.test', firstName: 'Cora', lastName: 'Captain', phone: '+47 911 11 111',
                registrationType: 'team', teamName: 'Fjord Hackers', numberOfParticipants: 4, eventId: event.id, captchaToken: 'x' }
        });
        expect(start.status()).toBe(200);
        // Session as verify-otp issues it before the account exists.
        const preAccount = await apiAs({ email: 'captain@e2e.test', id: null });
        const done = await preAccount.post('/api/register/complete', { data: { email: 'captain@e2e.test' } });
        expect(done.status()).toBe(200);
        const body = await done.json();
        expect(body).toMatchObject({ success: true, registrationType: 'team', isParticipant: true, eventId: event.id });
        expect(body.user).toMatchObject({ id: body.userId, email: 'captain@e2e.test', firstName: 'Cora', profileComplete: true, isPortalAdmin: false });
        expect(jwt.verify(body.token, JWT_SECRET, { issuer: 'acdc-portal' })).toMatchObject({ email: 'captain@e2e.test', userId: body.userId });

        const fresh = await apiAs(null, { 'x-acdc-token': body.token });
        const teams = await (await fresh.get('/api/teams')).json();
        expect(teams.map(t => t.id)).toEqual([body.teamId]);
        expect((await (await fresh.get(`/api/participations?userId=${body.userId}&eventId=${event.id}`)).json()).teamId).toBe(body.teamId);
    });

    test('register/start validates team registrations against the event', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const anon = await apiAs(null);
        const base = { email: 'new.nils@e2e.test', firstName: 'Nils', lastName: 'New', phone: '1', registrationType: 'team', captchaToken: 'x' };
        expect((await anon.post('/api/register/start', { data: { ...base, teamName: 'Power Rangers', numberOfParticipants: 4, eventId: w.event.id } })).status()).toBe(409);
        expect((await anon.post('/api/register/start', { data: { ...base, teamName: 'New Team', numberOfParticipants: 9, eventId: w.event.id } })).status()).toBe(400);
        expect((await anon.post('/api/register/start', { data: { ...base, teamName: 'New Team', numberOfParticipants: 4, eventId: BOGUS } })).status()).toBe(400);
        expect((await anon.post('/api/register/start', { data: { ...base, teamName: 'New Team', numberOfParticipants: 4 } })).status()).toBe(400);
        expect((await anon.post('/api/register/start', { data: { ...base, email: 'nope', teamName: 'New Team', numberOfParticipants: 4, eventId: w.event.id } })).status()).toBe(400);
    });
});

test.describe('malformed ids never produce a 500', () => {
    test('route and body GUIDs are rejected with 4xx', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const admin = await apiAs(w.admin);
        const checks = [
            ['get', `/api/teams/${BOGUS}`], ['delete', `/api/teams/${BOGUS}`], ['get', `/api/teams/${BOGUS}/members`],
            ['get', `/api/teams?eventId=${BOGUS}`], ['get', `/api/users/${BOGUS}`],
            ['get', `/api/participations/${BOGUS}/hotel`], ['put', `/api/participations/${BOGUS}/hotel`, { hotelNights: {} }],
            ['put', `/api/participations/${BOGUS}/roles`, { add: ['participant'] }], ['delete', `/api/participations/${BOGUS}`],
            ['put', `/api/participations/${BOGUS}/team`, { teamId: w.team.id }],
            ['put', `/api/participations/${w.participations.loner.id}/team`, { teamId: BOGUS }],
            ['get', `/api/participations/event/${BOGUS}`], ['get', `/api/participations?userId=${BOGUS}`],
            ['get', `/api/participations?userId=${w.loner.id}&eventId=${BOGUS}`],
            ['post', '/api/participations', { eventId: BOGUS, userId: w.loner.id }],
            ['get', `/api/invitations/${BOGUS}`], ['delete', `/api/invitations/${BOGUS}`], ['post', `/api/invitations/${BOGUS}/resend`],
            ['post', `/api/invitations/${BOGUS}/accept`, {}], ['get', `/api/invitations?teamId=${BOGUS}`],
            ['delete', `/api/solo-queue/${BOGUS}`], ['get', `/api/solo-queue?eventId=${BOGUS}`],
            ['get', `/api/interest/leads?eventId=${BOGUS}`], ['delete', `/api/interest/leads/${BOGUS}`],
            ['delete', `/api/members/${BOGUS}`]
        ];
        for (const [method, url, data] of checks) {
            const res = await admin[method](url, data !== undefined ? { data } : undefined);
            expect(res.status(), `${method.toUpperCase()} ${url}`).toBeGreaterThanOrEqual(200);
            expect(res.status(), `${method.toUpperCase()} ${url}`).toBeLessThan(500);
            if (res.status() >= 400) expect(JSON.stringify(await res.json())).not.toMatch(/at .*\.js:\d+|SELECT|UNIQUEIDENTIFIER|conversion/i);
        }
    });
});

test('forged admin claims are rejected and sessions are issuer-bound', async ({ apiAs, harness }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    const wrongIssuer = jwt.sign({ email: w.admin.email, userId: w.admin.id, isPortalAdmin: true }, JWT_SECRET, { expiresIn: '1h', issuer: 'someone-else' });
    expect((await (await apiAs(null, { 'x-acdc-token': wrongIssuer })).get('/api/users/all')).status()).toBe(401);
    expect((await (await apiAs(null, { 'x-acdc-token': signToken(w.admin, { secret: 'guess' }) })).get('/api/users/all')).status()).toBe(401);
});
