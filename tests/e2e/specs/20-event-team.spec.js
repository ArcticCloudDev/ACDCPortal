// Team life on event.html: create, invite, accept, confirm details, roles, queue.
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

const teamCard = (page, team) => page.locator(`.team-card[data-team-id="${team.id}"]`);

test('a participant without a team creates one from the event page', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.loner);
    await page.goto(`/event.html?id=${w.event.id}`);

    await expect(page.locator('#no-teams')).toContainText('not part of any team');
    await page.locator('#create-team-btn').click();
    await expect(page.locator('#create-team-modal')).toHaveClass(/active/);
    await page.locator('#create-team-next').click();
    await expect(page.locator('#create-team-step1-error')).toHaveText('Please fill in all fields.');

    await page.locator('#teamName').fill('Northern Lights');
    await page.locator('#expectedParticipants').selectOption('4');
    await page.locator('input[name="creatorParticipates"][value="yes"]').check();
    await page.locator('#create-team-next').click();
    await expect(page.locator('#create-team-step-2')).toBeVisible();
    await page.locator('#create-team-submit').click();
    await expect(page.locator('#create-team-error')).toHaveText('Please acknowledge to proceed.');
    await page.locator('#create-team-ack').check();
    await page.locator('#create-team-submit').click();
    await expect(page.locator('#create-team-success')).toContainText('Team created successfully!');

    await expect(page.locator('#site-header h1')).toHaveText('ACDC 2027 - Northern Lights');
    const [team] = await rows('SELECT * FROM Teams WHERE TeamName = @n', { n: 'Northern Lights' });
    expect(team).toMatchObject({ AdminUserId: w.loner.id, EventId: w.event.id, NumberOfParticipants: 4 });
    const [p] = await rows('SELECT * FROM Participations WHERE Id = @id', { id: w.participations.loner.id });
    expect(p).toMatchObject({ TeamId: team.Id, IsTeamAdmin: true, Roles: 'participant' });
});

test('team admin invites a member, who accepts with a code and joins the team', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.leader);
    await page.goto(`/event.html?id=${w.event.id}`);

    await teamCard(page, w.team).locator('.add-member-slot').first().click();
    await expect(page.locator('#invite-teamName')).toHaveText('Power Rangers');
    await page.locator('#invite-firstName').fill('Ingrid');
    await page.locator('#invite-lastName').fill('Invitee');
    await page.locator('#invite-email').fill('ingrid.invitee@e2e.test');
    await page.locator('#invite-phone').fill('+47 933 33 333');
    await page.locator('#send-invite-btn').click();
    await expect(page.locator('#invite-success')).toContainText('Ingrid Invitee is now a pending team member');
    // Invitees are provisional members: a participant card flagged "Confirm information".
    const invitee = teamCard(page, w.team).locator('.participant-card', { hasText: 'Ingrid Invitee' });
    await expect(invitee.locator('.role-tag.verify-needed')).toBeVisible();
    // A teammate who already confirmed is not flagged (the participant roster used to drop the flag).
    const confirmed = teamCard(page, w.team).locator('.participant-card', { hasText: 'Mats Member' });
    await expect(confirmed).toBeVisible();
    await expect(confirmed.locator('.role-tag.verify-needed')).toHaveCount(0);

    const mail = await harness.waitForMail('ingrid.invitee@e2e.test');
    const link = mail.html.match(/https?:\/\/[^"'\s]+\/accept-invitation\.html\?invite=[0-9a-fA-F-]{36}/);
    expect(link, `accept link in "${mail.subject}"`).not.toBeNull();

    // The invitee opens the link in a fresh, signed-out browser session.
    await page.evaluate(() => localStorage.clear());
    await page.goto(new URL(link[0]).pathname + new URL(link[0]).search);
    await expect(page.locator('#invite-team-name')).toContainText('Power Rangers');
    await page.locator('#next-to-profile-btn').click();
    // Signed out, the page only has the public invitation projection, so nothing is prefilled.
    await page.locator('#profile-firstName').fill('Ingrid');
    await page.locator('#profile-lastName').fill('Invitee');
    await page.locator('#profile-phone').fill('+47 933 33 333');
    await page.locator('#profile-email').fill('ingrid.invitee@e2e.test');
    await page.locator('#continue-to-verify-btn').click();
    await page.locator('#send-otp-btn').click();
    await page.locator('#otp-code').fill(await harness.otpFor('ingrid.invitee@e2e.test'));
    await page.locator('#verify-otp-btn').click();
    await expect(page.locator('#step-profile')).toBeVisible();
    await page.locator('#continue-to-verify-btn').click();

    await expect(page.locator('#success-team-name')).toContainText('Power Rangers');
    await expect(page).toHaveURL(new RegExp(`/event\\.html\\?id=${w.event.id}`), { timeout: 10000 });
    await expect(page.locator('#site-header h1')).toHaveText('ACDC 2027 - Power Rangers');

    const [inv] = await rows("SELECT * FROM Invitations WHERE Email = 'ingrid.invitee@e2e.test'");
    expect(inv.Status).toBe('accepted');
    const [user] = await rows("SELECT * FROM Users WHERE Email = 'ingrid.invitee@e2e.test'");
    expect(user).toMatchObject({ FirstName: 'Ingrid', InvitationPending: false, ProfileComplete: true });
    const [p] = await rows('SELECT * FROM Participations WHERE UserId = @u', { u: user.Id });
    expect(p).toMatchObject({ TeamId: w.team.id, IsTeamAdmin: false, ProfileVerification: true });
});

test('team admin resends and then cancels a pending invitation', async ({ page, harness, loginAs, dialogs }) => {
    const w = buildWorld();
    // Sent two minutes ago: a reminder is refused for 60 s after the last send.
    const sentAt = Date.now() - 2 * 60_000;
    const inv = f.invitation(w.event, w.leader, { teamId: w.team.id, teamName: w.team.teamName, email: 'pending.pia@e2e.test', inviteeFirstName: 'Pia', inviteeLastName: 'Pending',
        createdAt: new Date(sentAt).toISOString(), expiresAt: new Date(sentAt + 7 * 24 * 3600e3).toISOString() });
    await harness.seed({ ...w.seed(), invitations: [inv] });
    await loginAs(w.leader);
    await page.goto(`/event.html?id=${w.event.id}`);

    const card = teamCard(page, w.team).locator(`.pending-card[data-invite-id="${inv.id}"]`);
    await expect(card).toBeVisible();
    await card.locator('.resend-invite-btn').click();
    await expect(card.locator('.resend-invite-btn')).toContainText('Sent');
    const reminder = await harness.waitForMail('pending.pia@e2e.test', { subject: /^Reminder:/ });
    expect(reminder.html).toMatch(new RegExp(`accept-invitation\\.html\\?invite=${inv.id}`, 'i'));

    await card.locator('.cancel-invite-btn').click();
    await expect.poll(() => dialogs.last()?.message).toBe('Cancel invitation for pending.pia@e2e.test?');
    await expect(card).toHaveCount(0);
    const [row] = await rows('SELECT Status FROM Invitations WHERE Id = @id', { id: inv.id });
    expect(row.Status).toBe('cancelled');
});

test('a member must confirm their details before using the event page', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    w.participations.member.profileVerification = false;
    await harness.seed(w.seed());
    await loginAs(w.member);
    await page.goto(`/event.html?id=${w.event.id}`);

    const modal = page.locator('#edit-participant-modal');
    await expect(modal).toHaveClass(/active/);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveClass(/active/);
    await expect(page.locator('#edit-firstName')).toHaveValue('Mats');

    await page.locator('#edit-phone').fill('+47 944 44 444');
    await page.locator('#save-participant-btn').click();
    await expect(page.locator('#edit-participant-error')).toContainText('verify that your information is correct');
    await page.locator('#edit-data-verified').check();
    await page.locator('#save-participant-btn').click();
    await expect(page.locator('#edit-participant-success')).toHaveText('Saved!');
    await expect(modal).not.toHaveClass(/active/);

    const [p] = await rows('SELECT ProfileVerification FROM Participations WHERE Id = @id', { id: w.participations.member.id });
    expect(p.ProfileVerification).toBe(true);
    const [u] = await rows('SELECT Phone FROM Users WHERE Id = @id', { id: w.member.id });
    expect(u.Phone).toBe('+47 944 44 444');
});

test('team admin promotes a member to co-admin', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.leader);
    await page.goto(`/event.html?id=${w.event.id}`);

    const memberCard = teamCard(page, w.team).locator(`.participant-card[data-user-id="${w.member.id}"]`);
    await expect(memberCard.locator('.role-tag.admin')).toHaveCount(0);
    await memberCard.locator('.edit-participant-btn').click();
    await page.locator('#edit-data-verified').check();
    await page.locator('#tab-roles-btn').click();
    await page.locator('#edit-isAdmin').check();
    await page.locator('#save-participant-btn').click();
    await expect(page.locator('#edit-participant-success')).toHaveText('Saved!');
    await expect(memberCard.locator('.role-tag.admin')).toHaveCount(1);

    const [p] = await rows('SELECT IsTeamAdmin FROM Participations WHERE Id = @id', { id: w.participations.member.id });
    expect(p.IsTeamAdmin).toBe(true);
});

test('a participant joins the solo queue', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.loner);
    await page.goto(`/event.html?id=${w.event.id}`);

    await page.locator('#join-solo-btn').click();
    await page.locator('#solo-note').fill('Pro-code, likes Power Automate');
    await page.locator('#join-queue-btn').click();
    await expect(page.locator('#solo-queue-success')).toContainText("You're in the queue!");
    await expect(page.locator('#queue-position')).toHaveText('1 of 1');
    await expect(page.locator('#join-solo-btn')).toBeHidden();
    const [entry] = await rows('SELECT * FROM SoloQueue WHERE UserId = @u', { u: w.loner.id });
    expect(entry).toMatchObject({ EventId: w.event.id, Note: 'Pro-code, likes Power Automate', Status: 'waiting' });
});

test('a participant can leave the solo queue', async ({ page, harness, loginAs, dialogs }) => {
    const w = buildWorld();
    await harness.seed({ ...w.seed(), 'solo-queue': [{ id: f.id(), userId: w.loner.id, eventId: w.event.id, note: null, status: 'waiting', joinedAt: new Date().toISOString() }] });
    await loginAs(w.loner);
    await page.goto(`/event.html?id=${w.event.id}`);
    await expect(page.locator('#queue-position')).toHaveText('1 of 1');

    await page.locator('#leave-queue-btn').click();
    await expect.poll(() => dialogs.last()?.message).toBe('Are you sure you want to leave the solo queue?');
    await expect(page.locator('#join-solo-btn')).toBeVisible();
    expect(await rows('SELECT * FROM SoloQueue WHERE UserId = @u', { u: w.loner.id })).toHaveLength(0);
});

test('the queue confirmation reports the real position', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.loner);
    await page.goto(`/event.html?id=${w.event.id}`);
    await page.locator('#join-solo-btn').click();
    await page.locator('#join-queue-btn').click();
    await expect(page.locator('#solo-queue-success')).toContainText('Position: 1', { timeout: 3000 });
});

test('team admin unlocks one more slot', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.leader);
    await page.goto(`/event.html?id=${w.event.id}`);
    await teamCard(page, w.team).locator('.unlock-slot').click();
    await expect.poll(async () => (await rows('SELECT NumberOfParticipants n FROM Teams WHERE Id = @id', { id: w.team.id }))[0].n,
        { timeout: 3000 }).toBe(5);
});
