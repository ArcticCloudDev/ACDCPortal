// Who can see and change what: client-side gates on admin pages and the server-side
// object-level checks behind them. BUG tests pin confirmed security defects.
const { test, expect, f } = require('../fixtures');
const { buildWorld } = require('../support/world');
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
            await expect(page.getByText(/Access Denied/).first()).toBeVisible();
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
        await expect(page.getByText(/Access Denied/).first()).toBeVisible();
    });

    test('a committee member reaches event admin but not people admin', async ({ page, harness, loginAs }) => {
        const { w, seed } = worldWithStaff();
        await harness.seed(seed);
        await loginAs(w.committee);
        await page.goto('/admin-events.html');
        await expect(page.locator('#events-table-body')).toContainText('ACDC 2027');
        await page.goto('/admin-users.html');
        await expect(page.getByText(/Access Denied/).first()).toBeVisible();
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

    test('only portal admins can delete teams', async ({ apiAs, harness }) => {
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
    test('BUG (critical): an ordinary user cannot delete another account', async ({ apiAs, harness }) => {
        test.fail(true, 'members.js skips the authorization check when no team resolves (body has no teamId and the '
            + 'legacy Users.TeamId is null, which registration never sets), so any signed-in user can delete any user');
        const w = buildWorld();
        await harness.seed(w.seed());
        const res = await (await apiAs(w.loner)).delete(`/api/members/${w.admin.id}`, { data: {} });
        expect(res.status()).toBe(403);  // <- bug
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

    test('BUG (high): an anonymous interest sign-up cannot inject script into admin pages', async ({ page, harness, loginAs, apiAs }) => {
        test.fail(true, 'admin-events.js recipient overview renders lead names unescaped; names come from the public interest/record endpoint');
        const w = buildWorld();
        const seq = { id: f.id(), name: 'Pre-reg drip', description: null, createdAt: new Date().toISOString() };
        w.event.sequenceId = seq.id;
        w.event.sequenceEnabled = true;
        const campaign = { id: f.id(), sequenceId: seq.id, subject: 'Hello', content: '<p>x</p>', type: 'sequence', sequenceOrder: 1,
            status: 'draft', createdAt: new Date().toISOString() };
        await harness.seed({ ...w.seed(), sequences: [seq], 'email-campaigns': [campaign] });
        const anon = await apiAs(null);
        const rec = await anon.post('/api/interest/record', {
            data: { eventId: w.event.id, email: 'mallory@e2e.test', firstName: '<img src=x onerror="window.__xss=1">', lastName: 'M' }
        });
        expect(rec.status()).toBe(200);
        await loginAs(w.admin);
        await page.goto(`/admin-events.html?event=${w.event.id}&tab=sequence`);
        await expect(page.locator('#recipient-delivery-overview')).toContainText('mallory@e2e.test');
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();  // <- bug
    });
});
