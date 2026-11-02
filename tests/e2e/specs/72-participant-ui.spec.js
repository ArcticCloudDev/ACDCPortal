// Participant-facing frontend hardening: strict CSP compliance, escaping of user-supplied text,
// validated redirects, invitation routing for every role, and register/event page flow fixes.
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

const XSS = '<img src=x onerror="window.__xss=1">';
const noXss = async (page) => expect(await page.evaluate(() => window.__xss)).toBeUndefined();
// Report-only and enforced policies both raise securitypolicyviolation events, so this holds
// in either E2E_CSP mode. Admin pages are another team's responsibility and are filtered out.
const participantCsp = (context) => (context.__cspViolations || []).filter(v => !/^\/admin-/.test(v.page));

function newUserSeed(overrides = {}) {
    return f.user({ profileComplete: false, firstName: '', lastName: '', phone: '', ...overrides });
}

test.describe('strict CSP: participant pages load without violations', () => {
    test('events list, anonymous and signed in', async ({ page, context, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await page.goto('/events.html');
        await expect(page.locator('.event-card h3')).toHaveText(['ACDC 2027']);
        await loginAs(w.member);
        await page.goto('/events.html');
        await expect(page.locator('.my-status-pill.team')).toBeVisible();
        await page.locator('#header-user-btn').click();
        await expect(page.locator('#header-user-dropdown')).toBeVisible();
        expect(participantCsp(context)).toEqual([]);
    });

    test('event page as team admin, member and loner', async ({ page, context, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        for (const [user, marker] of [[w.leader, '.add-member-slot'], [w.member, '.participant-card'], [w.loner, '#create-team-btn']]) {
            await loginAs(user);
            await page.goto(`/event.html?id=${w.event.id}`);
            await expect(page.locator('#content')).toBeVisible();
            await expect(page.locator(marker).first()).toBeVisible();
        }
        // Modals and tabs are wired with listeners, not inline handlers.
        await page.locator('#create-team-btn').click();
        await expect(page.locator('#create-team-modal')).toHaveClass(/active/);
        await page.locator('#close-create-team').click();
        await expect(page.locator('#create-team-modal')).not.toHaveClass(/active/);
        expect(participantCsp(context)).toEqual([]);
    });

    test('event page as judge, committee member and interest lead', async ({ page, context, harness, loginAs }) => {
        const w = buildWorld({ event: { status: 'registration', hotelEnabled: true, hotelDaysBefore: 1, hotelDaysAfter: 1 } });
        const judge = f.user({ email: 'judy.judge@e2e.test' });
        const committee = f.user({ email: 'carl.committee@e2e.test' });
        const lead = f.user({ email: 'ina.interest@e2e.test' });
        const seed = w.seed();
        seed.users.push(judge, committee, lead);
        seed.participations.push(
            f.participation(judge, w.event, { roles: ['judge'] }),
            f.participation(committee, w.event, { roles: ['committee'] }),
            f.participation(lead, w.event, { roles: ['interest'] })
        );
        await harness.seed(seed);

        await loginAs(judge);
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#role-confirmed-badge')).toHaveText('✓ Judge — Confirmed');
        await expect(page.locator('#role-confirmed-details')).toContainText('Oslo Spektrum');
        await page.locator('#edit-details-btn').click();
        await expect(page.locator('#edit-participant-modal')).toHaveClass(/active/);
        await page.keyboard.press('Escape');

        await loginAs(committee);
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#role-confirmed-badge')).toHaveText('✓ Committee Member — Confirmed');

        await loginAs(lead);
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#role-confirmed-badge')).toHaveText('✓ Interest Registered');
        await expect(page.locator('#interest-upgrade-actions')).toBeVisible();
        expect(participantCsp(context)).toEqual([]);
    });

    test('register steps: sign-in and account creation up to the code step', async ({ page, context, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await page.goto(`/register.html?intent=team&eventId=${w.event.id}`);
        await page.locator('#checkEmail').fill('cora.captain@e2e.test');
        await page.locator('#email-check-btn').click();
        await expect(page.locator('#step-form')).toBeVisible();
        await page.locator('#firstName').fill('Cora');
        await page.locator('#lastName').fill('Captain');
        await page.locator('#phone').fill('+47 911 11 111');
        await page.locator('#teamName').fill('Fjord Hackers');
        await page.locator('#numberOfParticipants').selectOption('4');
        await page.locator('#submit-btn').click();
        await expect(page.locator('#step-otp')).toBeVisible();

        await page.goto('/register.html');
        await page.locator('#checkEmail').fill(w.leader.email);
        await page.locator('#email-check-btn').click();
        await expect(page.locator('#otp-welcome-back')).toBeVisible();
        expect(participantCsp(context)).toEqual([]);
    });

    test('accept-invitation for a team and a judge invitation', async ({ page, context, harness }) => {
        const w = buildWorld();
        const teamInv = f.invitation(w.event, w.leader, { teamId: w.team.id, teamName: w.team.teamName, email: 'tina.team@e2e.test' });
        const judgeInv = f.invitation(w.event, w.admin, { role: 'judge', email: 'jo.judge@e2e.test' });
        await harness.seed(mergeSeeds(w.seed(), { invitations: [teamInv, judgeInv] }));

        await page.goto(`/accept-invitation.html?invite=${teamInv.id}`);
        await expect(page.locator('#invite-heading')).toHaveText("You've Been Invited!");
        await expect(page.locator('#invite-team-name')).toHaveText('Power Rangers');
        await expect(page.locator('#invite-email-hint')).toHaveText('Sent to t***@e2e.test');
        await page.locator('#next-to-profile-btn').click();
        await expect(page.locator('#step-profile')).toBeVisible();

        await page.goto(`/accept-invitation.html?invite=${judgeInv.id}`);
        await expect(page.locator('#invite-heading')).toHaveText('Judge Invitation');
        await expect(page.locator('#invite-team-name')).toHaveText('ACDC 2027');
        await expect(page.locator('#next-to-profile-btn')).toContainText('Accept Judge Invitation');
        expect(participantCsp(context)).toEqual([]);
    });

    test('complete-registration and the legacy redirect stubs', async ({ page, context, harness, loginAs }) => {
        const u = newUserSeed({ email: 'incomplete@e2e.test' });
        await harness.seed({ users: [u] });
        await loginAs(u);
        await page.goto('/complete-registration.html');
        await expect(page.locator('#registration-card')).toBeVisible();
        await expect(page.locator('#email')).toHaveValue('incomplete@e2e.test');

        await page.goto('/team-admin.html');
        await expect(page).toHaveURL(/\/events\.html$/);
        await page.goto('/my-page.html?x=1');
        await expect(page).toHaveURL(/\/events\.html$/);
        await page.goto('/some/deep/link?foo=bar');
        await expect(page).toHaveURL(/\/events\.html\?foo=bar$/);
        expect(participantCsp(context)).toEqual([]);
    });
});

test.describe('user-supplied text is rendered as text', () => {
    test('team name in the event header', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        w.team.teamName = XSS;
        await harness.seed(w.seed());
        await loginAs(w.leader);
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#site-header h1')).toHaveText(`ACDC 2027 - ${XSS}`);
        await page.locator('.add-member-slot').first().click();
        await expect(page.locator('#invite-teamName')).toHaveText(XSS);
        await noXss(page);
    });

    test('event name, description and location on the events list and event page', async ({ page, harness, loginAs }) => {
        const w = buildWorld({ event: { name: `Evil ${XSS}`, description: `Desc ${XSS}`, location: `Loc ${XSS}` } });
        const judge = f.user({ email: 'judy.judge@e2e.test' });
        const seed = w.seed();
        seed.users.push(judge);
        seed.participations.push(f.participation(judge, w.event, { roles: ['judge'] }));
        await harness.seed(seed);

        await page.goto('/events.html');
        const card = page.locator('.event-card').first();
        await expect(card.locator('h3')).toHaveText(`Evil ${XSS}`);
        await expect(card.locator('.description')).toHaveText(`Desc ${XSS}`);
        await expect(card.locator('.event-meta')).toContainText(`Loc ${XSS}`);
        await noXss(page);

        await loginAs(w.member);
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#event-info-strip')).toContainText(`Loc ${XSS}`);
        await expect(page.locator('#site-header h1')).toHaveText(`Evil ${XSS} - Power Rangers`);
        await noXss(page);

        await loginAs(judge);
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#role-confirmed-details')).toContainText(`Loc ${XSS}`);
        await noXss(page);
    });

    test('inviter, team and event names on the invitation page', async ({ page, harness }) => {
        const w = buildWorld({ event: { name: `Event ${XSS}`, location: `Loc ${XSS}` } });
        w.team.teamName = `Team ${XSS}`;
        const inv = f.invitation(w.event, w.leader, {
            teamId: w.team.id, teamName: w.team.teamName, inviterName: `Inviter ${XSS}`, email: 'tina.team@e2e.test'
        });
        await harness.seed(mergeSeeds(w.seed(), { invitations: [inv] }));
        await page.goto(`/events.html?invite=${inv.id}`);
        await expect(page).toHaveURL(new RegExp(`/accept-invitation\\.html\\?invite=${inv.id}`));
        await expect(page.locator('#invite-team-name')).toHaveText(`Team ${XSS}`);
        await expect(page.locator('#invite-event-line')).toHaveText(`for Event ${XSS}`);
        await expect(page.locator('#invite-meta-line')).toContainText(`Loc ${XSS}`);
        await noXss(page);
    });

    test('badge name in the badge list and claim dialog', async ({ page, harness, loginAs }) => {
        const w = buildWorld({ event: { status: 'live' } });
        const b = f.badge({ name: `Badge ${XSS}`, description: `Why ${XSS}`, imageUrl: 'javascript:window.__xss=1' });
        const eb = f.eventBadge(w.event, b);
        await harness.seed({ ...w.seed(), badges: [b], 'event-badges': [eb] });
        await loginAs(w.member);
        await page.goto(`/event.html?id=${w.event.id}#badges`);
        const row = page.locator('.badge-row').first();
        await expect(row.locator('.badge-name')).toHaveText(`Badge ${XSS}`);
        // A non-http(s) URL is never rendered as a link.
        await expect(row.locator('.btn-badge-examples')).toHaveCount(0);
        await row.locator('.btn-badge-claim').click();
        await expect(page.locator('#badge-claim-title')).toHaveText(`Claim: Badge ${XSS}`);
        await page.locator('#badge-claim-url').fill('javascript:alert(1)');
        await page.locator('#badge-claim-submit-btn').click();
        await expect(page.locator('#badge-claim-error')).toContainText('valid URL');
        await page.locator('#badge-claim-cancel').click();
        await expect(page.locator('#badge-claim-modal')).toHaveClass(/hidden/);
        await noXss(page);
    });

    test('registration terms are shown as text with line breaks', async ({ page, harness, loginAs }) => {
        const w = buildWorld({ event: { teamRegistrationTerms: `Line one\n${XSS}\nLine three`, soloQueueTerms: `Solo ${XSS}` } });
        await harness.seed(w.seed());
        await loginAs(w.loner);
        await page.goto(`/event.html?id=${w.event.id}`);
        await page.locator('#create-team-btn').click();
        await page.locator('#teamName').fill('Northern Lights');
        await page.locator('#expectedParticipants').selectOption('4');
        await page.locator('#create-team-next').click();
        const terms = page.locator('#create-team-terms-display');
        await expect(terms).toContainText(XSS);
        await expect(terms).toContainText('Line three');
        expect(await terms.evaluate(el => el.innerText.split('\n').length)).toBe(3);
        await page.locator('#close-create-team').click();
        await page.locator('#join-solo-btn').click();
        await expect(page.locator('#solo-terms-display')).toHaveText(`Solo ${XSS}`);
        await noXss(page);
    });
});

test.describe('redirect targets are validated', () => {
    test('a signed-in visitor is never sent off-site by ?redirect', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.leader);
        for (const bad of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/\\evil.example', 'events.html']) {
            await page.goto(`/register.html?redirect=${encodeURIComponent(bad)}`);
            await expect(page).toHaveURL(/\/events\.html$/);
        }
        await page.goto(`/register.html?redirect=${encodeURIComponent(`/event.html?id=${w.event.id}`)}`);
        await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${w.event.id}$`));
    });

    test('after an OTP sign-in a protocol-relative redirect falls back to events', async ({ page, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await page.goto('/register.html?redirect=%2F%2Fevil.example');
        await page.locator('#checkEmail').fill(w.leader.email);
        await page.locator('#email-check-btn').click();
        await page.locator('#otpCode').fill(await harness.otpFor(w.leader.email));
        await page.locator('#verify-otp-btn').click();
        await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/events\.html$/);
    });

    test('complete-registration ignores an off-site redirect', async ({ page, harness, loginAs }) => {
        const u = newUserSeed({ email: 'incomplete@e2e.test' });
        await harness.seed({ users: [u] });
        await loginAs(u);
        await page.goto('/complete-registration.html?redirect=https%3A%2F%2Fevil.example');
        await page.locator('#firstName').fill('Ida');
        await page.locator('#lastName').fill('Incomplete');
        await page.locator('#phone').fill('+47 900 00 001');
        await page.locator('#complete-btn').click();
        await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/events\.html$/);
        const [row] = await rows('SELECT FirstName, ProfileComplete FROM Users WHERE Email = @e', { e: u.email });
        expect(row).toMatchObject({ FirstName: 'Ida', ProfileComplete: true });
        // The account that existed was updated, not duplicated.
        expect(await rows('SELECT Id FROM Users WHERE Email = @e', { e: u.email })).toHaveLength(1);
    });

    test('a signed-out deep link signs in and returns to the event', async ({ page, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page).toHaveURL(/\/register\.html\?redirect=/);
        await page.locator('#checkEmail').fill(w.member.email);
        await page.locator('#email-check-btn').click();
        await page.locator('#otpCode').fill(await harness.otpFor(w.member.email));
        await page.locator('#verify-otp-btn').click();
        await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${w.event.id}$`));
        await expect(page.locator('#site-header h1')).toHaveText('ACDC 2027 - Power Rangers');
    });
});

test.describe('invitations', () => {
    test('every invitation link lands on accept-invitation.html', async ({ page, harness }) => {
        const w = buildWorld();
        const participant = f.invitation(w.event, w.leader, { teamId: w.team.id, teamName: w.team.teamName });
        const committee = f.invitation(w.event, w.admin, { role: 'committee' });
        await harness.seed(mergeSeeds(w.seed(), { invitations: [participant, committee] }));
        await page.goto(`/events.html?invite=${participant.id}`);
        await expect(page).toHaveURL(new RegExp(`/accept-invitation\\.html\\?invite=${participant.id}$`));
        await page.goto(`/index.html?invite=${committee.id}`);
        await expect(page).toHaveURL(new RegExp(`/accept-invitation\\.html\\?invite=${committee.id}$`));
        await expect(page.locator('#invite-heading')).toHaveText('Committee Invitation');
    });

    test('a signed-in user accepts a committee invitation without a second code', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        const inv = f.invitation(w.event, w.admin, { role: 'committee', email: w.loner.email });
        await harness.seed(mergeSeeds(w.seed(), { invitations: [inv] }));
        await loginAs(w.loner);
        await page.goto(`/?invite=${inv.id}`);
        await expect(page.locator('#invite-heading')).toHaveText('Committee Invitation');
        await page.locator('#next-to-profile-btn').click();
        await expect(page.locator('#profile-firstName')).toHaveValue('Solo');
        await expect(page.locator('#profile-email')).toHaveValue(w.loner.email);
        await page.locator('#continue-to-verify-btn').click();
        await expect(page.locator('#success-title')).toHaveText('Welcome to the Committee!');
        await expect(page.locator('#success-team-name')).toHaveText('ACDC 2027');
        await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${w.event.id}`), { timeout: 10000 });
        await expect(page.locator('#role-confirmed-badge')).toHaveText('✓ Committee Member — Confirmed');
        const [row] = await rows('SELECT Status FROM Invitations WHERE Id = @id', { id: inv.id });
        expect(row.Status).toBe('accepted');
        const [p] = await rows('SELECT Roles FROM Participations WHERE Id = @id', { id: w.participations.loner.id });
        expect(p.Roles).toContain('committee');
    });

    test('an acceptance error is shown on the visible step and the button recovers', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        // Invitation addressed to someone else: the server refuses, the page must say so.
        const inv = f.invitation(w.event, w.leader, { teamId: w.team.id, teamName: w.team.teamName, email: 'someone.else@e2e.test' });
        await harness.seed(mergeSeeds(w.seed(), { invitations: [inv] }));
        await loginAs(w.loner);
        await page.goto(`/accept-invitation.html?invite=${inv.id}`);
        await page.locator('#next-to-profile-btn').click();
        await page.locator('#continue-to-verify-btn').click();
        await expect(page.locator('#profile-error')).toBeVisible();
        await expect(page.locator('#profile-error')).toContainText('Email does not match invitation');
        await expect(page.locator('#continue-to-verify-btn')).toBeEnabled();
        const [row] = await rows('SELECT Status FROM Invitations WHERE Id = @id', { id: inv.id });
        expect(row.Status).toBe('pending');
    });
});

test.describe('events list', () => {
    test('a live event is listed with Open for its teams and no sign-up buttons for others', async ({ page, harness, loginAs }) => {
        const w = buildWorld({ event: { status: 'live' } });
        await harness.seed(w.seed());
        await page.goto('/events.html');
        const card = page.locator('.event-card', { hasText: 'ACDC 2027' });
        await expect(card.locator('.status-badge')).toContainText('Live');
        await expect(card.locator('a.btn-event')).toHaveCount(0);
        await expect(card.locator('.helper-text')).toContainText('Registration is closed');

        await loginAs(w.member);
        await page.goto('/events.html');
        await card.locator('a.btn-event.primary', { hasText: 'Open' }).click();
        await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${w.event.id}`));
        await expect(page.locator('#site-header h1')).toHaveText('ACDC 2027 - Power Rangers');
    });

    test('the header menu starts closed, opens on click and closes on an outside click', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.leader);
        await page.goto('/events.html');
        await expect(page.locator('#header-user-btn')).toContainText('Lena Leader');
        await expect(page.locator('#header-user-dropdown')).toBeHidden();
        await page.locator('#header-user-btn').click();
        await expect(page.locator('#header-user-dropdown')).toBeVisible();
        await page.locator('footer').click();
        await expect(page.locator('#header-user-dropdown')).toBeHidden();
    });
});

test.describe('register flow', () => {
    test('an error after the code is verified is shown on the visible step', async ({ page, harness }) => {
        const event = f.event();
        await harness.seed({ events: [event] });
        const email = 'doomed@e2e.test';
        await page.goto('/register.html');
        await page.locator('#checkEmail').fill(email);
        await page.locator('#email-check-btn').click();
        await page.locator('#firstName').fill('Dora');
        await page.locator('#lastName').fill('Doomed');
        await page.locator('#phone').fill('+47 900 00 002');
        await page.locator('#submit-btn').click();
        await expect(page.locator('#step-otp')).toBeVisible();
        const code = await harness.otpFor(email);
        // Simulate the pending registration vanishing between the code and completion.
        await rows("DELETE FROM PendingRegistrations WHERE Email = @e AND Id NOT LIKE 'otp_%'", { e: email });
        await page.locator('#otpCode').fill(code);
        await page.locator('#verify-otp-btn').click();
        await expect(page.locator('#completing-error')).toBeVisible();
        await expect(page.locator('#completing-error')).toContainText(/pending registration|start again/i);
        await expect(page).toHaveURL(/register\.html/);
    });

    test('resend works for the team sign-in flow', async ({ page, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await page.goto(`/register.html?intent=team&eventId=${w.event.id}`);
        await page.locator('#checkEmail').fill(w.leader.email);
        await page.locator('#email-check-btn').click();
        await expect(page.locator('#step-otp')).toBeVisible();
        const resend = page.waitForRequest(req => req.url().includes('/api/auth/send-otp') && req.method() === 'POST');
        await page.locator('#resend-otp-btn').click();
        expect((await resend).postDataJSON()).toEqual({ email: w.leader.email });
        // Inside the cooldown the server refuses; the page must show that, not swallow it.
        await expect(page.locator('#otp-error')).toBeVisible();
    });

    test('the submit button works again after going back to the email step', async ({ page, harness }) => {
        await harness.seed({ events: [f.event()] });
        await page.goto('/register.html');
        await page.locator('#checkEmail').fill('bounce@e2e.test');
        await page.locator('#email-check-btn').click();
        await page.locator('#firstName').fill('Bea');
        await page.locator('#lastName').fill('Bounce');
        await page.locator('#phone').fill('+47 900 00 003');
        await page.locator('#submit-btn').click();
        await expect(page.locator('#step-otp')).toBeVisible();
        await page.locator('#back-to-email-otp').click();
        await page.locator('#email-check-btn').click();
        await expect(page.locator('#step-form')).toBeVisible();
        await expect(page.locator('#submit-btn')).toBeEnabled();
        await expect(page.locator('#submit-btn .btn-text')).toBeVisible();
        await expect(page.locator('#submit-btn .btn-loading')).toBeHidden();
    });

    test('intent=team without an event is a plain sign-in', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await page.goto('/register.html?intent=team');
        await expect(page.locator('#page-subtitle')).toHaveText('Sign In');
        await loginAs(w.loner);
        await page.goto('/register.html?intent=team');
        await expect(page).toHaveURL(/\/events\.html$/);
    });
});

test.describe('event page', () => {
    test('?action=create-team does not open the dialog for someone who already has a team', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.leader);
        await page.goto(`/event.html?id=${w.event.id}&action=create-team`);
        await expect(page.locator('#content')).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${w.event.id}$`));
        await expect(page.locator('#create-team-modal')).not.toHaveClass(/active/);
    });

    test('a judge who is also on a team sees both the role card and the team', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        w.participations.member.roles = ['participant', 'judge'];
        await harness.seed(w.seed());
        await loginAs(w.member);
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#role-confirmed-badge')).toHaveText('✓ Judge — Confirmed');
        await expect(page.locator(`.team-card[data-team-id="${w.team.id}"]`)).toBeVisible();
    });

    test('the edit dialog never shows the previous save message', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.member);
        await page.goto(`/event.html?id=${w.event.id}`);
        const card = page.locator(`.participant-card[data-user-id="${w.member.id}"]`);
        await card.locator('.edit-participant-btn').click();
        await page.locator('#save-participant-btn').click();
        await expect(page.locator('#edit-participant-error')).toBeVisible();
        await page.locator('#edit-data-verified').check();
        await page.locator('#save-participant-btn').click();
        await expect(page.locator('#edit-participant-success')).toHaveText('Saved!');
        await expect(page.locator('#edit-participant-modal')).not.toHaveClass(/active/);
        await card.locator('.edit-participant-btn').click();
        await expect(page.locator('#edit-participant-modal')).toHaveClass(/active/);
        await expect(page.locator('#edit-participant-success')).toBeHidden();
        await expect(page.locator('#edit-participant-error')).toBeHidden();
    });

    test('a first visit records the participation without inventing hotel nights', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        const newcomer = f.user({ email: 'newbie@e2e.test' });
        const seed = w.seed();
        seed.users.push(newcomer);
        await harness.seed(seed);
        await loginAs(newcomer);
        const upsert = page.waitForRequest(req => req.url().includes('/api/participations') && req.method() === 'POST');
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#no-teams')).toBeVisible();
        expect((await upsert).postDataJSON()).toMatchObject({ userId: newcomer.id, eventId: w.event.id, hotelNights: {} });
        const [p] = await rows('SELECT HotelNight_ThuFri, HotelNight_FriSat, HotelNight_SatSun FROM Participations WHERE UserId = @u', { u: newcomer.id });
        expect(p).toEqual({ HotelNight_ThuFri: false, HotelNight_FriSat: false, HotelNight_SatSun: false });
    });
});
