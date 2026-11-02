// Email + OTP sign-in, session handling, and the server-side guards around it.
const { test, expect, f, signToken, sessionUser, JWT_SECRET } = require('../fixtures');
const jwt = require('../../../api/node_modules/jsonwebtoken');
const { buildWorld } = require('../support/world');

async function signInThroughUi(page, harness, email) {
    await page.locator('#checkEmail').fill(email);
    await page.locator('#email-check-btn').click();
    await expect(page.locator('#step-otp')).toBeVisible();
    await page.locator('#otpCode').fill(await harness.otpFor(email));
    await page.locator('#verify-otp-btn').click();
}

test.describe('sign in through the UI', () => {
    test('existing user signs in with the emailed code and lands on events', async ({ page, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());

        await page.goto('/register.html');
        await page.locator('#checkEmail').fill('LENA.Leader@e2e.test ');
        await page.locator('#email-check-btn').click();
        await expect(page.locator('#otp-welcome-back')).toBeVisible();
        await expect(page.locator('#otp-email-display')).toHaveText('lena.leader@e2e.test');

        const mail = await harness.waitForMail(w.leader.email, { subject: 'Your ACDC Portal Verification Code' });
        expect(mail.sender).toBe('no-reply@e2e.test');
        await page.locator('#otpCode').fill(await harness.otpFor(w.leader.email));
        await page.locator('#verify-otp-btn').click();

        await expect(page).toHaveURL(/\/events\.html$/);
        await expect(page.locator('#header-user-btn')).toContainText('Lena Leader');
        const session = await page.evaluate(() => ({
            token: localStorage.getItem('acdc_token'),
            user: JSON.parse(localStorage.getItem('acdc_user'))
        }));
        const claims = jwt.verify(session.token, JWT_SECRET, { issuer: 'acdc-portal' });
        expect(claims).toMatchObject({ email: w.leader.email, userId: w.leader.id, isPortalAdmin: false });
        expect(session.user).toMatchObject({ email: w.leader.email, firstName: 'Lena' });
    });

    test('wrong code is rejected with remaining attempts', async ({ page, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await page.goto('/register.html');
        await page.locator('#checkEmail').fill(w.leader.email);
        await page.locator('#email-check-btn').click();
        const code = await harness.otpFor(w.leader.email);
        const wrong = code === '111111' ? '222222' : '111111';

        await page.locator('#otpCode').fill(wrong);
        await page.locator('#verify-otp-btn').click();
        await expect(page.locator('#otp-error')).toContainText('Invalid code. 4 attempts remaining.');
        await expect(page).toHaveURL(/register\.html/);

        await page.locator('#otpCode').fill(code);
        await page.locator('#verify-otp-btn').click();
        await expect(page).toHaveURL(/\/events\.html$/);
    });

    test('the redirect parameter is honoured after sign-in', async ({ page, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await page.goto(`/register.html?redirect=${encodeURIComponent(`/event.html?id=${w.event.id}`)}`);
        await signInThroughUi(page, harness, w.leader.email);
        await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${w.event.id}$`));
        await expect(page.locator('#content')).toBeVisible();
    });

    test('an unknown email is routed to account creation', async ({ page, harness }) => {
        await page.goto('/register.html');
        await page.locator('#checkEmail').fill('newcomer@e2e.test');
        await page.locator('#email-check-btn').click();
        await expect(page.locator('#step-form')).toBeVisible();
        await expect(page.locator('#regEmail')).toHaveValue('newcomer@e2e.test');
        expect(await harness.outbox('newcomer@e2e.test')).toHaveLength(0);
    });

    test('log out clears the session', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.leader);
        await page.goto('/events.html');
        if (!(await page.locator('#header-logout-menuitem').isVisible())) await page.locator('#header-user-btn').click();
        await page.locator('#header-logout-menuitem').click();
        await expect(page).toHaveURL(/\/events\.html$/);
        await expect(page.locator('#header-signin-btn')).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('acdc_token'))).toBeNull();
    });

    test('BUG: the user menu should start closed', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.leader);
        await page.goto('/events.html');
        await expect(page.locator('#header-user-btn')).toBeVisible();
        await expect(page.locator('#header-user-dropdown')).toBeHidden({ timeout: 1500 });  // <- bug
    });
});

test.describe('session lifecycle', () => {
    test('an expired token is discarded on page load', async ({ page, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const expired = jwt.sign(
            { email: w.leader.email, userId: w.leader.id, isPortalAdmin: false, exp: Math.floor(Date.now() / 1000) - 60 },
            JWT_SECRET, { issuer: 'acdc-portal' });
        await page.goto('/__test/blank');
        await page.evaluate(([t, u]) => { localStorage.setItem('acdc_token', t); localStorage.setItem('acdc_user', JSON.stringify(u)); },
            [expired, sessionUser(w.leader)]);
        await page.goto('/events.html');
        await expect(page.locator('#header-signin-btn')).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('acdc_token'))).toBeNull();
    });

    test('a token the server rejects clears the session and reloads signed out', async ({ page, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const forged = signToken(w.admin, { secret: 'not-the-server-secret' });
        await page.goto('/__test/blank');
        await page.evaluate(([t, u]) => { localStorage.setItem('acdc_token', t); localStorage.setItem('acdc_user', JSON.stringify(u)); },
            [forged, sessionUser(w.admin)]);
        await page.goto('/events.html');
        await expect(page.locator('#header-signin-btn')).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('acdc_token'))).toBeNull();
    });
});

test.describe('OTP endpoint guards', () => {
    test('unknown emails get the same answer and no email (no enumeration)', async ({ apiAs, harness }) => {
        const api = await apiAs(null);
        const res = await api.post('/api/auth/send-otp', { data: { email: 'nobody@e2e.test' } });
        expect(res.status()).toBe(200);
        expect((await res.json()).message).toBe('If this email is registered, a verification code has been sent.');
        expect(await harness.outbox()).toHaveLength(0);
    });

    test('a second code inside the 60s cooldown is refused', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const api = await apiAs(null);
        expect((await api.post('/api/auth/send-otp', { data: { email: w.leader.email } })).status()).toBe(200);
        const again = await api.post('/api/auth/send-otp', { data: { email: w.leader.email } });
        expect(again.status()).toBe(429);
        expect(await harness.outbox(w.leader.email)).toHaveLength(1);
    });

    test('five wrong codes burn the code, even the right one is then refused', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const api = await apiAs(null);
        await api.post('/api/auth/send-otp', { data: { email: w.leader.email } });
        const code = await harness.otpFor(w.leader.email);
        const wrong = code === '111111' ? '222222' : '111111';
        for (let i = 0; i < 5; i++) {
            expect((await api.post('/api/auth/verify-otp', { data: { email: w.leader.email, code: wrong } })).status()).toBe(400);
        }
        const res = await api.post('/api/auth/verify-otp', { data: { email: w.leader.email, code } });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toContain('Too many incorrect attempts');
    });

    test('the API rejects missing, forged and non-admin tokens', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        expect((await (await apiAs(null)).get('/api/users/all')).status()).toBe(401);
        expect((await (await apiAs(null, { 'x-acdc-token': signToken(w.admin, { secret: 'wrong' }) })).get('/api/users/all')).status()).toBe(401);
        expect((await (await apiAs(w.leader)).get('/api/users/all')).status()).toBe(403);
        expect((await (await apiAs(w.admin)).get('/api/users/all')).status()).toBe(200);
    });
});
