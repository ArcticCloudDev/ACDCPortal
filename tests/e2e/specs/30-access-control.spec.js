// Who can see and change what: client-side gates on admin pages and the server-side
// object-level checks behind them. BUG tests pin confirmed security defects.
const { test, expect, f } = require('../fixtures');
const { buildWorld, mergeSeeds } = require('../support/world');
const db = require('../harness/db');

async function rows(query, params = {}) {
    const pool = await db.getPool();
    const req = pool.request();
    for (const [k, v] of Object.entries(params)) req.input(k, v);
    return (await req.query(query)).recordset;
}
test.afterAll(async () => { await db.closePool(); });

function worldWithStaff() {
    const w = buildWorld();
    w.judge = f.user({ firstName: 'Judy', lastName: 'Judge', email: 'judy.judge@e2e.test' });
    w.committee = f.user({ firstName: 'Cato', lastName: 'Committee', email: 'cato.committee@e2e.test' });
    const seed = w.seed();
    seed.users.push(w.judge, w.committee);
    seed.participations.push(
        f.participation(w.judge, w.event, { roles: ['judge'] }),
        f.participation(w.committee, w.event, { roles: ['committee'] })
    );
    return { w, seed };
}

test.describe('admin page gates', () => {
    test('anonymous visitors are sent to sign in', async ({ page }) => {
        await page.goto('/admin-dashboard.html');
        await expect(page).toHaveURL(/\/register\.html$/);
    });

    test('a plain participant is denied every admin page', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.member);
        for (const p of ['admin-dashboard.html', 'admin-users.html', 'admin-events.html', 'admin-badges.html']) {
            await page.goto(`/${p}`);
            await expect(page.getByText(/Access denied/i).first()).toBeVisible();
        }
    });

    test('a judge reaches judge pages only', async ({ page, harness, loginAs }) => {
        const { w, seed } = worldWithStaff();
        await harness.seed(seed);
        await loginAs(w.judge);
        await page.goto('/admin-badges.html');
        // Judges get the claims queue only, not the badge library.
        await expect(page.locator('.tab-btn[data-tab="claims"]')).toBeVisible();
        await expect(page.locator('.tab-btn[data-tab="master"]')).toBeHidden();
        await expect(page.getByText('No badge claims found')).toBeVisible();
        await page.goto('/admin-users.html');
        await expect(page.getByText(/Access denied/i).first()).toBeVisible();
    });

    // Committee members are full admins: every admin page and every event. Only the portal-admin
    // flag (the bootstrap super admin) is out of their reach, and no endpoint sets it.
    test('a committee member is a full admin across pages and events', async ({ page, harness, loginAs, apiAs }) => {
        const { w, seed } = worldWithStaff();
        const draft = f.event({ name: 'Next Year Draft', status: 'draft', isActive: false, registrationOpen: false });
        await harness.seed(mergeSeeds(seed, { events: [draft] }));
        await loginAs(w.committee);
        await page.goto('/admin-events.html');
        await expect(page.locator('#events-table-body')).toContainText('Next Year Draft');
        await page.goto('/admin-users.html');
        await expect(page.locator('#main-tbody')).toContainText('mats.member@e2e.test');
        await page.goto(`/admin-person.html?email=${encodeURIComponent(w.member.email)}`);
        await expect(page.locator('#results-container')).toContainText('Mats Member');

        const api = await apiAs(w.committee);
        expect((await api.put(`/api/events/${draft.id}`, { data: { name: 'Next Year' } })).status()).toBe(200);
        expect((await api.get('/api/interest/leads')).status()).toBe(200);
        const [u] = await rows('SELECT IsPortalAdmin FROM Users WHERE Id = @id', { id: w.committee.id });
        expect(u.IsPortalAdmin).toBe(false);
    });

    test('a judge runs their own event: names, teams and the participant list', async ({ page, harness, loginAs }) => {
        const { w, seed } = worldWithStaff();
        const jon = f.user({ firstName: 'Jon', lastName: 'Judge', email: 'jon.judge@e2e.test' });
        const common = f.badge({ name: 'Best demo' });
        const exclusive = f.badge({ name: 'Grand prize', claimType: 'exclusive' });
        const jonsBadge = f.eventBadge(w.event, common, { judgeUserId: jon.id });
        const judysBadge = f.eventBadge(w.event, exclusive, { judgeUserId: w.judge.id });
        const claim = { id: f.id(), eventBadgeId: jonsBadge.id, badgeId: common.id, teamId: w.team.id, eventId: w.event.id,
            status: 'pending', evidence: 'https://example.com/demo', claimedBy: w.leader.id, claimedAt: new Date().toISOString() };
        await harness.seed(mergeSeeds(seed, {
            users: [jon], participations: [f.participation(jon, w.event, { roles: ['judge'] })],
            badges: [common, exclusive], 'event-badges': [jonsBadge, judysBadge], 'badge-claims': [claim]
        }));
        await loginAs(w.judge);

        await page.goto('/admin-badges.html');
        await expect(page.locator('.claims-group .panel-title', { hasText: 'Jon Judge' })).toBeVisible();
        await expect(page.locator('.award-team-select option', { hasText: 'Power Rangers' })).toBeAttached();

        await page.goto(`/admin-event-participants.html?id=${w.event.id}`);
        await expect(page.locator('#participants-body')).toContainText('Mats');
        await expect(page.locator('#participants-body')).toContainText('mats.member@e2e.test');
        await page.goto('/admin-users.html');
        await expect(page.getByText(/Access denied/i).first()).toBeVisible();
    });

    test('the header shows the admin link only to staff', async ({ page, harness, loginAs }) => {
        const { w, seed } = worldWithStaff();
        await harness.seed(seed);
        await loginAs(w.member);
        await page.goto('/events.html');
        await expect(page.locator('#header-user-btn')).toBeVisible();
        await expect(page.locator('#header-dashboard-link')).toBeHidden();
        await loginAs(w.committee);
        await page.goto('/events.html');
        await expect(page.locator('#header-dashboard-link')).toBeAttached();
        await expect(page.locator('#header-dashboard-link')).not.toHaveClass(/hidden/);
    });
});

test.describe('object-level authorization in the API', () => {
    test('users can read themselves and teammates they administer, nobody else', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const leader = await apiAs(w.leader);
        const loner = await apiAs(w.loner);
        expect((await leader.get(`/api/users/${w.leader.id}`)).status()).toBe(200);
        expect((await leader.get(`/api/users/${w.member.id}`)).status()).toBe(200);
        expect((await loner.get(`/api/users/${w.member.id}`)).status()).toBe(403);
        expect((await loner.get(`/api/users?email=${encodeURIComponent(w.member.email)}`)).status()).toBe(403);
        expect((await loner.get('/api/participations/all')).status()).toBe(403);
    });

    test('profile updates cannot grant portal admin', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const res = await (await apiAs(w.loner)).put(`/api/users/${w.loner.id}`, { data: { firstName: 'Sneaky', isPortalAdmin: true } });
        expect(res.status()).toBe(200);
        const [u] = await rows('SELECT FirstName, IsPortalAdmin FROM Users WHERE Id = @id', { id: w.loner.id });
        expect(u).toEqual({ FirstName: 'Sneaky', IsPortalAdmin: false });
    });

    test('participants cannot give themselves roles or move into other teams', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const loner = await apiAs(w.loner);
        const roles = await loner.post('/api/participations', { data: { eventId: w.event.id, userId: w.loner.id, roles: ['committee'] } });
        expect(roles.status()).toBe(403);
        const move = await loner.put(`/api/participations/${w.participations.loner.id}/team`, { data: { teamId: w.team.id } });
        expect(move.status()).toBe(403);
    });

    test('only admins can delete teams', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        expect((await (await apiAs(w.leader)).delete(`/api/teams/${w.team.id}`)).status()).toBe(403);
        expect(await rows('SELECT Id FROM Teams WHERE Id = @id', { id: w.team.id })).toHaveLength(1);
    });

    test('non-members cannot read a team or its invitations', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const loner = await apiAs(w.loner);
        expect((await loner.get(`/api/teams/${w.team.id}`)).status()).toBe(403);
        expect((await loner.get(`/api/invitations?teamId=${w.team.id}`)).status()).toBe(403);
    });

    test('event rosters are projected for participants (no emails)', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const roster = await (await (await apiAs(w.loner)).get(`/api/participations/event/${w.event.id}`)).json();
        expect(roster.length).toBeGreaterThan(0);
        for (const p of roster) expect(p.email).toBeUndefined();
    });

    test('the scheduler endpoint requires its secret', async ({ apiAs }) => {
        expect((await (await apiAs(null)).post('/api/scheduled-emails/run')).status()).toBe(401);
        expect((await (await apiAs(null, { 'x-scheduler-secret': 'wrong' })).post('/api/scheduled-emails/run')).status()).toBe(401);
    });
});

test.describe('confirmed security defects', () => {
    test('an ordinary user cannot delete another account', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const res = await (await apiAs(w.loner)).delete(`/api/members/${w.admin.id}`, { data: {} });
        expect(res.status()).toBe(403);
        expect(await rows('SELECT Id FROM Users WHERE Id = @id', { id: w.admin.id })).toHaveLength(1);
    });

    test('BUG (high): a team name cannot inject script into the event page', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        w.team.teamName = '<img src=x onerror="window.__xss=1">';
        await harness.seed(w.seed());
        await loginAs(w.member);
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#content')).toBeVisible();
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();  // <- bug
    });

    test('an interest sign-up cannot inject script into admin pages', async ({ page, harness, loginAs, apiAs }) => {
        const w = buildWorld();
        const seq = { id: f.id(), name: 'Pre-reg drip', description: null, createdAt: new Date().toISOString() };
        w.event.sequenceId = seq.id;
        w.event.sequenceEnabled = true;
        const campaign = { id: f.id(), sequenceId: seq.id, subject: 'Hello', content: '<p>x</p>', type: 'sequence', sequenceOrder: 1,
            status: 'draft', createdAt: new Date().toISOString() };
        await harness.seed({ ...w.seed(), sequences: [seq], 'email-campaigns': [campaign] });
        // interest/record requires the signed-in session of the lead (contract 4); any OTP login gets one.
        const mallory = await apiAs({ email: 'mallory@e2e.test', id: null });
        const rec = await mallory.post('/api/interest/record', {
            data: { eventId: w.event.id, email: 'mallory@e2e.test', firstName: '<img src=x onerror="window.__xss=1">', lastName: 'M' }
        });
        expect(rec.status()).toBe(200);
        await loginAs(w.admin);
        await page.goto(`/admin-events.html?event=${w.event.id}&tab=sequence`);
        await expect(page.locator('#recipient-delivery-overview')).toContainText('mallory@e2e.test');
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();  // <- bug
    });
});
