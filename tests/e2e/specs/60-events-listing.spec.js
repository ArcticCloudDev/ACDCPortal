// events.html: what each visitor sees per event status, and the role-invitation entry.
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

const card = (page, name) => page.locator('.event-card', { has: page.locator('h3', { hasText: name }) });

test('each status gets the right card and calls to action', async ({ page, harness }) => {
    await harness.seed({
        events: [
            f.event({ name: 'Draft Event', status: 'draft' }),
            f.event({ name: 'Soon Event', status: 'pre-registration', registrationOpen: false }),
            f.event({ name: 'Open Event', status: 'registration' }),
            f.event({ name: 'Past Event', status: 'completed' })
        ]
    });
    await page.goto('/events.html');
    await expect(page.locator('.event-card')).toHaveCount(2);
    expect((await page.locator('.event-card h3').allInnerTexts()).sort()).toEqual(['Open Event', 'Soon Event']);

    const soon = card(page, 'Soon Event');
    await expect(soon.locator('.status-badge')).toContainText('Coming Soon');
    await expect(soon.locator('a.btn-event.interest-only')).toHaveText('Register Interest');

    const open = card(page, 'Open Event');
    await expect(open.locator('.status-badge')).toContainText('Registration Open');
    await expect(open.locator('a.btn-event.primary')).toHaveText('Register Team');
    await expect(open.locator('a.btn-event.secondary')).toHaveText('Register Interest');
});

test('no open events shows the empty state', async ({ page, harness }) => {
    await harness.seed({ events: [f.event({ status: 'completed' })] });
    await page.goto('/events.html');
    await expect(page.locator('.no-events-message')).toContainText('No events are currently open for registration.');
});

test('a signed-in team member sees their status and can open the event', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.member);
    await page.goto('/events.html');
    const c = card(page, 'ACDC 2027');
    await expect(c.locator('.my-status-pill.team')).toHaveText('✓ Team Registered');
    await c.locator('a.btn-event.primary', { hasText: 'Open' }).click();
    await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${w.event.id}`));
});

test('"Register Team" while signed in goes straight to team creation', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.loner);
    await page.goto('/events.html');
    await card(page, 'ACDC 2027').locator('a.btn-event.primary', { hasText: 'Register Team' }).click();
    await expect(page.locator('#create-team-modal')).toHaveClass(/active/);
});

test('BUG: a live event stays reachable for its teams', async ({ page, harness, loginAs }) => {
    test.fail(true, 'events.html filters to pre-registration/registration only, so during the live event (when badges can be claimed) '
        + 'teams have no link to their event page');
    const w = buildWorld({ event: { status: 'live' } });
    await harness.seed(w.seed());
    await loginAs(w.member);
    await page.goto('/events.html');
    await expect(card(page, 'ACDC 2027')).toBeVisible({ timeout: 4000 });  // <- bug
});

test('BUG: an invited judge can accept the invitation', async ({ page, harness }) => {
    test.fail(true, 'events.html ?invite= shows the role page, Accept -> login -> back to the same page in a loop; the only client '
        + 'code that calls invitations.accept for roles is js/events.js, which no page loads');
    const w = buildWorld();
    const inv = f.invitation(w.event, w.admin, { role: 'judge', email: 'jo.judge@e2e.test' });
    await harness.seed(mergeSeeds(w.seed(), { invitations: [inv], allowedEmails: ['jo.judge@e2e.test'] }));

    await page.goto(`/?invite=${inv.id}`);
    await page.locator('#accept-role-btn').click();
    await page.locator('#checkEmail').fill('jo.judge@e2e.test');
    await page.locator('#email-check-btn').click();
    await expect(page.locator('#step-form')).toBeVisible();
    await page.locator('#firstName').fill('Jo');
    await page.locator('#lastName').fill('Judge');
    await page.locator('#phone').fill('+47 955 55 555');
    await page.locator('#submit-btn').click();
    await page.locator('#otpCode').fill(await harness.otpFor('jo.judge@e2e.test'));
    await page.locator('#verify-otp-btn').click();
    await expect.poll(async () => (await rows("SELECT Status FROM Invitations WHERE Email = 'jo.judge@e2e.test'"))[0].Status,  // <- bug
        { timeout: 6000 }).toBe('accepted');
});
