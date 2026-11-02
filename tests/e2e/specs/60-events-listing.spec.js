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
    const w = buildWorld({ event: { status: 'live' } });
    await harness.seed(w.seed());
    await loginAs(w.member);
    await page.goto('/events.html');
    await expect(card(page, 'ACDC 2027')).toBeVisible({ timeout: 4000 });  // <- bug
});

// Every invitation link (participant, judge, committee) lands on accept-invitation.html, which
// handles profile -> OTP -> accept for all roles. The old role page on events.html looped forever.
test('BUG: an invited judge can accept the invitation', async ({ page, harness }) => {
    const w = buildWorld();
    const inv = f.invitation(w.event, w.admin, { role: 'judge', email: 'jo.judge@e2e.test' });
    await harness.seed(mergeSeeds(w.seed(), { invitations: [inv], allowedEmails: ['jo.judge@e2e.test'] }));

    await page.goto(`/?invite=${inv.id}`);
    await expect(page).toHaveURL(new RegExp(`/accept-invitation\\.html\\?invite=${inv.id}`));
    await expect(page.locator('#invite-heading')).toHaveText('Judge Invitation');
    await expect(page.locator('#invite-team-name')).toHaveText('ACDC 2027');
    await page.locator('#next-to-profile-btn').click();
    await page.locator('#profile-firstName').fill('Jo');
    await page.locator('#profile-lastName').fill('Judge');
    await page.locator('#profile-phone').fill('+47 955 55 555');
    await page.locator('#profile-email').fill('jo.judge@e2e.test');
    await page.locator('#continue-to-verify-btn').click();
    await page.locator('#send-otp-btn').click();
    await page.locator('#otp-code').fill(await harness.otpFor('jo.judge@e2e.test'));
    await page.locator('#verify-otp-btn').click();
    await expect(page.locator('#step-profile')).toBeVisible();
    await page.locator('#continue-to-verify-btn').click();

    await expect(page.locator('#success-title')).toHaveText('Welcome to the Jury!');
    await expect.poll(async () => (await rows("SELECT Status FROM Invitations WHERE Email = 'jo.judge@e2e.test'"))[0].Status,  // <- bug
        { timeout: 6000 }).toBe('accepted');
    const [user] = await rows("SELECT * FROM Users WHERE Email = 'jo.judge@e2e.test'");
    expect(user).toMatchObject({ FirstName: 'Jo', ProfileComplete: true });
    const [p] = await rows('SELECT Roles FROM Participations WHERE UserId = @u AND EventId = @e', { u: user.Id, e: w.event.id });
    expect(p.Roles).toContain('judge');
    await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${w.event.id}`), { timeout: 10000 });
    await expect(page.locator('#role-confirmed-badge')).toHaveText('✓ Judge — Confirmed');
});
