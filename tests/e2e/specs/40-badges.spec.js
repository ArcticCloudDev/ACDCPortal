// Badge library -> event assignment -> team claim -> judge review / award.
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

test('admin adds a badge to the library', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.admin);
    await page.goto('/admin-badges.html');

    await page.locator('#add-badge-btn').click();
    await expect(page.locator('#badge-modal')).toHaveClass(/visible/);
    await page.locator('#badge-name').fill('Dataverse Wizard');
    await page.locator('#badge-category').selectOption('low-code');
    await page.locator('#badge-claimType').selectOption('common');
    await page.locator('#badge-description').fill('Built something clever on Dataverse');
    await page.locator('#badge-points').fill('25');
    await page.locator('#badge-save-btn').click();

    await expect(page.locator('#badges-container .badge-card', { hasText: 'Dataverse Wizard' })).toBeVisible();
    const [b] = await rows("SELECT * FROM Badges WHERE Name = 'Dataverse Wizard'");
    expect(b).toMatchObject({ Category: 'low-code', ClaimType: 'common', Points: 25 });
});

test('admin assigns library badges to an event', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    const b1 = f.badge({ name: 'Early Bird' });
    const b2 = f.badge({ name: 'Bug Hunter', category: 'pro-code' });
    await harness.seed({ ...w.seed(), badges: [b1, b2] });
    await loginAs(w.admin);
    await page.goto('/admin-badges.html');

    await page.locator('.tab-btn[data-tab="event-badges"]').click();
    await page.locator('#event-badge-selector').selectOption(w.event.id);
    await page.locator(`.event-badge-toggle[data-badge-id="${b1.id}"]`).check();
    await page.locator(`.event-badge-toggle[data-badge-id="${b2.id}"]`).check();
    await page.locator('#save-event-badges-btn').click();
    await expect(page.locator('#save-event-badges-btn')).toContainText('Saved');

    const assigned = await rows('SELECT BadgeId FROM EventBadges WHERE EventId = @e ORDER BY BadgeId', { e: w.event.id });
    expect(assigned.map(r => r.BadgeId).sort()).toEqual([b1.id, b2.id].sort());
});

test('a team claims a badge during the live event and the admin approves it', async ({ page, harness, loginAs }) => {
    const w = buildWorld({ event: { status: 'live' } });
    const b = f.badge({ name: 'Early Bird', category: 'soft' });
    const eb = f.eventBadge(w.event, b);
    await harness.seed({ ...w.seed(), badges: [b], 'event-badges': [eb] });

    await loginAs(w.member);
    await page.goto(`/event.html?id=${w.event.id}#badges`);
    const row = page.locator('.badge-row', { hasText: 'Early Bird' });
    await row.locator('.btn-badge-claim').click();
    await expect(page.locator('#badge-claim-title')).toHaveText('Claim: Early Bird');
    await page.locator('#badge-claim-url').fill('not a url');
    await page.locator('#badge-claim-submit-btn').click();
    await expect(page.locator('#badge-claim-error')).toContainText('valid URL');
    await page.locator('#badge-claim-url').fill('https://acdc.blog/power-rangers/early-bird');
    await page.locator('#badge-claim-submit-btn').click();
    await expect(row.locator('.badge-claim-status')).toHaveText('Submitted');

    const [claim] = await rows('SELECT * FROM BadgeClaims WHERE EventBadgeId = @eb', { eb: eb.id });
    expect(claim).toMatchObject({ TeamId: w.team.id, Status: 'pending', BlogUrl: 'https://acdc.blog/power-rangers/early-bird' });

    await loginAs(w.admin);
    await page.goto('/admin-badges.html');
    await page.locator('.tab-btn[data-tab="claims"]').click();
    await page.getByRole('button', { name: 'Review' }).click();
    await page.locator('#review-decision').selectOption('approved');
    await page.locator('#review-modal .modal-footer .primary').click();
    await expect.poll(async () => (await rows('SELECT Status FROM BadgeClaims WHERE Id = @id', { id: claim.Id }))[0].Status).toBe('approved');

    await loginAs(w.member);
    await page.goto(`/event.html?id=${w.event.id}#badges`);
    await expect(page.locator('.badge-row', { hasText: 'Early Bird' }).locator('.badge-claim-status')).toHaveText('Approved');
});

test('claims are refused outside the team, and duplicates conflict', async ({ apiAs, harness }) => {
    const w = buildWorld({ event: { status: 'live' } });
    const b = f.badge();
    const eb = f.eventBadge(w.event, b);
    await harness.seed({ ...w.seed(), badges: [b], 'event-badges': [eb] });
    const body = { eventBadgeId: eb.id, teamId: w.team.id, blogUrl: 'https://acdc.blog/x' };
    expect((await (await apiAs(w.loner)).post('/api/badge-claims', { data: body })).status()).toBe(403);
    const member = await apiAs(w.member);
    expect((await member.post('/api/badge-claims', { data: body })).status()).toBe(201);
    expect((await member.post('/api/badge-claims', { data: body })).status()).toBe(409);
});

test('a judge awards an exclusive badge, which cannot be claimed', async ({ apiAs, harness }) => {
    const w = buildWorld({ event: { status: 'live' } });
    const judge = f.user({ email: 'judy.judge@e2e.test' });
    const b = f.badge({ name: 'Best in Show', claimType: 'exclusive', category: 'sponsor' });
    const eb = f.eventBadge(w.event, b);
    const seed = w.seed();
    seed.users.push(judge);
    seed.participations.push(f.participation(judge, w.event, { roles: ['judge'] }));
    await harness.seed({ ...seed, badges: [b], 'event-badges': [eb] });

    const res = await (await apiAs(judge)).post('/api/badge-claims/award', { data: { eventBadgeId: eb.id, teamId: w.team.id, awardedBy: judge.id } });
    expect(res.status()).toBe(201);
    expect((await res.json()).status).toBe('approved');
    expect((await (await apiAs(w.member)).post('/api/badge-claims/award', { data: { eventBadgeId: eb.id, teamId: w.team.id } })).status()).toBe(403);
});

test('BUG: badge search survives a badge without a description', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed({ ...w.seed(), badges: [f.badge({ name: 'Plain', description: null }), f.badge({ name: 'Fancy' })] });
    await loginAs(w.admin);
    await page.goto('/admin-badges.html');
    await page.locator('#filter-search').fill('fan');
    await expect(page.locator('#badges-container .badge-card')).toHaveCount(1);  // <- bug
});

test('soft badges sort first in the library API', async ({ apiAs, harness }) => {
    await harness.seed({ badges: [f.badge({ name: 'Zeta', category: 'pro-code' }), f.badge({ name: 'Alpha', category: 'soft' })] });
    const list = await (await (await apiAs(null)).get('/api/badges')).json();
    expect(list[0].category).toBe('soft');
});
