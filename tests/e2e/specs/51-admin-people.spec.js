// Dashboard, teams, people, person lookup, event participants and interest lists.
const fs = require('node:fs');
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

async function asAdmin(page, harness, loginAs, path, extra = {}) {
    const w = buildWorld();
    await harness.seed(mergeSeeds(w.seed(), typeof extra === 'function' ? extra(w) : extra));
    await loginAs(w.admin);
    await page.goto(typeof path === 'function' ? path(w) : path);
    return w;
}

test('dashboard summarises the portal and exports JSON', async ({ page, harness, loginAs }) => {
    await asAdmin(page, harness, loginAs, '/admin-dashboard.html', w => ({
        invitations: [f.invitation(w.event, w.leader, { teamId: w.team.id, teamName: w.team.teamName })]
    }));
    await expect(page.locator('#stat-events')).toHaveText('1');
    await expect(page.locator('#stat-teams')).toHaveText('1');
    await expect(page.locator('#stat-pending')).toHaveText('1');
    await expect(page.locator('#teams-table-body')).toContainText('Power Rangers');

    const download = page.waitForEvent('download');
    await page.locator('#export-data').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^acdc-export-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
    expect(data.events.map(e => e.name)).toEqual(['ACDC 2027']);
    expect(data.teams.map(t => t.teamName)).toEqual(['Power Rangers']);
});

test('BUG: the dashboard "Edit" link opens the event editor', async ({ page, harness, loginAs }) => {
    const w = await asAdmin(page, harness, loginAs, '/admin-dashboard.html');
    await page.locator('#events-list .event-row').getByText('Edit').click();
    await expect(page.locator('#event-name')).toHaveValue(w.event.name, { timeout: 4000 });  // <- bug
});

test('admin teams lists members, removes one, then deletes the team', async ({ page, harness, loginAs, dialogs }) => {
    const w = await asAdmin(page, harness, loginAs, '/admin-teams.html');
    const row = page.locator('tr.team-main-row', { hasText: 'Power Rangers' });
    await expect(row).toBeVisible();
    await row.locator('.expand-btn').click();
    const members = page.locator('tr.member-details-row .member-list');
    await expect(members).toContainText('Lena Leader');
    await expect(members).toContainText('Mats Member');

    await members.locator('tr', { hasText: 'Mats Member' }).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => dialogs.last()?.message).toContain('Remove "Mats Member" from this team?');
    await expect.poll(async () => (await rows('SELECT TeamId FROM Participations WHERE Id = @id', { id: w.participations.member.id }))[0].TeamId).toBeNull();

    await page.locator('tr.team-main-row', { hasText: 'Power Rangers' }).getByRole('button', { name: 'Delete team Power Rangers' }).click();
    await expect(page.locator('tr.team-main-row', { hasText: 'Power Rangers' })).toHaveCount(0);
    expect(await rows('SELECT Id FROM Teams WHERE Id = @id', { id: w.team.id })).toHaveLength(0);
    const [leader] = await rows('SELECT TeamId, IsTeamAdmin FROM Participations WHERE Id = @id', { id: w.participations.leader.id });
    expect(leader).toEqual({ TeamId: null, IsTeamAdmin: false });
});

test('BUG: admin teams shows the committed team size', async ({ page, harness, loginAs }) => {
    await asAdmin(page, harness, loginAs, '/admin-teams.html');
    await expect(page.locator('#total-committed')).toHaveText('4', { timeout: 4000 });  // <- bug
});

test('people page filters, opens a person and exports CSV', async ({ page, harness, loginAs }) => {
    await asAdmin(page, harness, loginAs, '/admin-users.html');
    await expect(page.locator('#admin-content')).toContainText('lena.leader@e2e.test');
    await page.locator('#filter-search').fill('mats');
    await expect(page.locator('#admin-content')).not.toContainText('lena.leader@e2e.test');
    await expect(page.locator('#admin-content')).toContainText('mats.member@e2e.test');

    await page.getByText('mats.member@e2e.test').first().click();
    await expect(page.locator('#person-drawer')).toHaveClass(/open/);
    await expect(page.locator('#drawer-name')).toHaveText('Mats Member');
    await expect(page.locator('#drawer-body')).toContainText('ACDC 2027');
    await page.keyboard.press('Escape');
    await expect(page.locator('#person-drawer')).not.toHaveClass(/open/);

    await page.locator('#filter-search').fill('');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export/ }).click();
    const csv = fs.readFileSync(await (await download).path(), 'utf8');
    expect(csv).toContain('lena.leader@e2e.test');
    expect(csv).toContain('solo.sverre@e2e.test');
});

test('person lookup shows the event history for an email', async ({ page, harness, loginAs }) => {
    await asAdmin(page, harness, loginAs, '/admin-person.html?email=lena.leader%40e2e.test');
    await expect(page.locator('#results-container')).toContainText('ACDC 2027');
    await page.locator('#search-email').fill('nobody@e2e.test');
    await page.locator('#search-btn').click();
    await expect(page.locator('#results-container')).toContainText('No results found');
});

test('event participants page lists, filters and exports the roster', async ({ page, harness, loginAs }) => {
    await asAdmin(page, harness, loginAs, w => `/admin-event-participants.html?id=${w.event.id}`);
    await expect(page.locator('#participant-count')).toHaveText('3 participants');
    await expect(page.locator('.team-header-row', { hasText: 'Power Rangers' })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.locator('#export-btn').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('ACDC_2027_participants.csv');
    const csv = fs.readFileSync(await file.path(), 'utf8');
    expect(csv).toContain('Lena');
    expect(csv).toContain('Mats');
});

test('interest list shows leads recorded from the interest form', async ({ page, harness, loginAs, apiAs }) => {
    const w = buildWorld({ event: { status: 'pre-registration' } });
    await harness.seed(w.seed());
    // interest/record requires the lead's own OTP session (contract 4).
    const rec = await (await apiAs({ email: 'keen.kari@e2e.test', id: null })).post('/api/interest/record', {
        data: { eventId: w.event.id, email: 'keen.kari@e2e.test', firstName: 'Kari', lastName: 'Keen' }
    });
    expect(rec.status()).toBe(200);
    await loginAs(w.admin);
    await page.goto('/admin-interest.html');
    await expect(page.locator('#queue-table-body')).toContainText('keen.kari@e2e.test');
    await expect(page.locator('#stat-total')).toHaveText('1');
});

test('admin removes an interest lead', async ({ page, harness, loginAs, apiAs }) => {
    const w = buildWorld({ event: { status: 'pre-registration' } });
    await harness.seed(w.seed());
    await (await apiAs({ email: 'keen.kari@e2e.test', id: null })).post('/api/interest/record', {
        data: { eventId: w.event.id, email: 'keen.kari@e2e.test', firstName: 'Kari', lastName: 'Keen' }
    });
    await loginAs(w.admin);
    await page.goto('/admin-interest.html');
    await page.locator('#queue-table-body tr', { hasText: 'keen.kari@e2e.test' }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('#queue-table-body')).not.toContainText('keen.kari@e2e.test', { timeout: 4000 });
});

test('dashboard shows each event with its team count', async ({ page, harness, loginAs }) => {
    // Regression: event rows rendered before teams loaded, so every event said "0 teams".
    await asAdmin(page, harness, loginAs, '/admin-dashboard.html');
    await expect(page.locator('#events-list .event-row', { hasText: 'ACDC 2027' })).toContainText('1 team');
});
