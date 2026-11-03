// New-account flows through register.html: team, plain profile and interest.
const { test, expect, f } = require('../fixtures');
const db = require('../harness/db');

async function rows(query, params = {}) {
    const pool = await db.getPool();
    const req = pool.request();
    for (const [k, v] of Object.entries(params)) req.input(k, v);
    return (await req.query(query)).recordset;
}

test.afterAll(async () => { await db.closePool(); });

async function fillEmail(page, email) {
    await page.locator('#checkEmail').fill(email);
    await page.locator('#email-check-btn').click();
    await expect(page.locator('#step-form')).toBeVisible();
}

async function verifyOtp(page, harness, email) {
    await expect(page.locator('#step-otp')).toBeVisible();
    await page.locator('#otpCode').fill(await harness.otpFor(email));
    await page.locator('#verify-otp-btn').click();
}

async function registerTeamThroughUi(page, harness, event, email) {
    await page.goto(`/register.html?intent=team&eventId=${event.id}`);
    await expect(page.locator('#page-subtitle')).toContainText('Register a team');
    await fillEmail(page, email);
    await page.locator('#firstName').fill('Cora');
    await page.locator('#lastName').fill('Captain');
    await page.locator('#phone').fill('+47 911 11 111');
    await page.locator('#teamName').fill('Fjord Hackers');
    await page.locator('#numberOfParticipants').selectOption('4');
    await expect(page.locator('#willParticipate')).toBeChecked();
    await page.locator('#submit-btn').click();
    await verifyOtp(page, harness, email);
    await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${event.id}`));
}

test.describe('team registration by a newcomer', () => {
test('persists the user, the team and an admin participation', async ({ page, harness }) => {
    const event = f.event({ name: 'ACDC 2027' });
    await harness.seed({ events: [event] });
    const email = 'captain@e2e.test';
    await registerTeamThroughUi(page, harness, event, email);

    const [user] = await rows('SELECT * FROM Users WHERE Email = @e', { e: email });
    expect(user).toMatchObject({ FirstName: 'Cora', LastName: 'Captain', ProfileComplete: true, IsPortalAdmin: false });
    const [team] = await rows('SELECT * FROM Teams WHERE TeamName = @n', { n: 'Fjord Hackers' });
    expect(team).toMatchObject({ AdminUserId: user.Id, EventId: event.id, NumberOfParticipants: 4 });
    const [p] = await rows('SELECT * FROM Participations WHERE UserId = @u', { u: user.Id });
    expect(p).toMatchObject({ TeamId: team.Id, IsTeamAdmin: true, Roles: 'participant' });
    expect(await rows("SELECT * FROM PendingRegistrations WHERE Email = @e", { e: email })).toHaveLength(0);
});

test('the new captain sees their team right after registering', async ({ page, harness }) => {
    const event = f.event({ name: 'ACDC 2027' });
    await harness.seed({ events: [event] });
    await registerTeamThroughUi(page, harness, event, 'captain@e2e.test');
    await expect(page.locator('#site-header h1')).toHaveText('ACDC 2027 - Fjord Hackers', { timeout: 4000 });  // <- bug
});
});

test('a newcomer creates a plain account and returns to events', async ({ page, harness }) => {
    const event = f.event();
    await harness.seed({ events: [event] });
    const email = 'plain.person@e2e.test';

    await page.goto('/register.html');
    await fillEmail(page, email);
    await expect(page.locator('#team-fieldset')).toBeHidden();
    await page.locator('#firstName').fill('Paula');
    await page.locator('#lastName').fill('Plain');
    await page.locator('#phone').fill('+47 922 22 222');
    await page.locator('#submit-btn').click();
    await verifyOtp(page, harness, email);

    await expect(page).toHaveURL(/\/events\.html$/);
    await expect(page.locator('#header-user-btn')).toBeVisible();
    const [user] = await rows('SELECT * FROM Users WHERE Email = @e', { e: email });
    expect(user).toMatchObject({ FirstName: 'Paula', ProfileComplete: true });
});

test('a newcomer registers interest in a pre-registration event', async ({ page, harness }) => {
    const event = f.event({ name: 'ACDC 2028', status: 'pre-registration', registrationOpen: false });
    await harness.seed({ events: [event] });
    const email = 'curious@e2e.test';

    await page.goto('/events.html');
    await page.locator('.event-card', { hasText: 'ACDC 2028' }).locator('a.btn-event.interest-only').click();
    await expect(page).toHaveURL(new RegExp(`register\\.html\\?intent=interest&eventId=${event.id}`));
    await fillEmail(page, email);
    await expect(page.locator('#phone-group')).toBeHidden();
    await page.locator('#firstName').fill('Cleo');
    await page.locator('#lastName').fill('Curious');
    await page.locator('#submit-btn').click();
    await verifyOtp(page, harness, email);

    await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${event.id}`));
    await expect(page.locator('#role-confirmed-badge')).toHaveText('Interest registered');
    const leads = await rows('SELECT * FROM InterestLeads WHERE Email = @e', { e: email });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ EventId: event.id, Verified: true });
});

test('an already registered email cannot start a second registration', async ({ apiAs, harness }) => {
    const u = f.user({ email: 'taken@e2e.test' });
    await harness.seed({ users: [u] });
    const res = await (await apiAs(null)).post('/api/register/start', {
        data: { email: 'taken@e2e.test', firstName: 'Ta', lastName: 'Ken', phone: '1', captchaToken: 'x' }
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message ?? '').toMatch(/already registered/i);
});

test('registration start requires a captcha token', async ({ apiAs }) => {
    const res = await (await apiAs(null)).post('/api/register/start', {
        data: { email: 'bot@e2e.test', firstName: 'Ro', lastName: 'Bot', phone: '1' }
    });
    expect(res.status()).toBe(400);
});

test('completing a registration requires the OTP session for that email', async ({ apiAs, harness }) => {
    const someoneElse = f.user();
    await harness.seed({ users: [someoneElse] });
    const res = await (await apiAs({ email: 'other@e2e.test', id: null })).post('/api/register/complete', {
        data: { email: 'victim@e2e.test' }
    });
    expect(res.status()).toBe(403);
});
