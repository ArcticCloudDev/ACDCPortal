// Quick email, system templates, sequences/campaigns and the scheduled sender.
const { test, expect, f, SCHEDULER_SECRET } = require('../fixtures');
const { buildWorld, mergeSeeds } = require('../support/world');
const db = require('../harness/db');

async function rows(query, params = {}) {
    const pool = await db.getPool();
    const req = pool.request();
    for (const [k, v] of Object.entries(params)) req.input(k, v);
    return (await req.query(query)).recordset;
}
test.afterAll(async () => { await db.closePool(); });

function sequenceSeed(evt, { status = 'live', sendAt = new Date(Date.now() - 60e3) } = {}) {
    const seq = { id: f.id(), name: 'ACDC 2027 drip', description: 'Pre-event emails', createdAt: new Date().toISOString() };
    const campaign = {
        id: f.id(), sequenceId: seq.id, subject: 'Hotel info for {{eventName}}', content: '<p>Pack warm clothes.</p>',
        type: 'sequence', sequenceOrder: 1, status, scheduledSendTime: sendAt.toISOString(), createdAt: new Date().toISOString()
    };
    evt.sequenceId = seq.id;
    evt.sequenceEnabled = true;
    return { seq, campaign };
}

async function sendQuickEmail(page, dialogs) {
    await page.goto('/admin-email.html');
    await page.locator('.template-card[data-template="announcement"]').click();
    await page.locator('#recipient-filter').selectOption('custom');
    await page.locator('#custom-emails').fill('alpha@e2e.test\nbeta@e2e.test');
    await expect(page.locator('#recipient-count')).toContainText('2');
    await page.locator('#subject').fill('Doors open at 09:00');
    await page.locator('#editor-container .ql-editor').fill('Bring your laptop charger.');
    await page.locator('#send-btn').click();
    await expect.poll(() => dialogs.last()?.message).toBe('Send email to 2 recipient(s)?');
    await expect(page.locator('#status-bar')).toContainText('Successfully sent to 2 recipient(s)');
}

test('admin sends a quick announcement to custom recipients', async ({ page, harness, loginAs, dialogs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.admin);
    await sendQuickEmail(page, dialogs);

    for (const to of ['alpha@e2e.test', 'beta@e2e.test']) {
        await harness.waitForMail(to, { subject: 'Doors open at 09:00' });
    }
    await expect(page.locator('#history-body')).toContainText('Doors open at 09:00');
    const [log] = await rows("SELECT * FROM EmailLog WHERE Subject = 'Doors open at 09:00'");
    expect(log).toMatchObject({ RecipientCount: 2, ResultsSent: 2, ResultsFailed: 0, Status: 'completed' });
});

test('BUG (high): quick email recipients receive the message the admin wrote', async ({ page, harness, loginAs, dialogs }) => {
    test.fail(true, 'admin-email.html posts {subject, content, ctaUrl, ctaText} at the top level; email.js email-send merges only '
        + 'body.data, so {{content}} and {{subject}} render empty. The preview uses `data` and looks right.');
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.admin);
    await sendQuickEmail(page, dialogs);
    const mail = await harness.waitForMail('alpha@e2e.test', { subject: 'Doors open at 09:00' });
    expect(mail.html).toContain('Bring your laptop charger.');  // <- bug
});

test('participant recipients for an event are resolved from team membership', async ({ apiAs, harness }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    const res = await (await apiAs(w.admin)).get(`/api/email/recipients?eventId=${w.event.id}&filter=all-participants`);
    expect(res.status()).toBe(200);
    const emails = (await res.json()).map(r => r.email).sort();
    expect(emails).toEqual(['lena.leader@e2e.test', 'mats.member@e2e.test']);
});

test('admin customises the team welcome template for an event and sends a test', async ({ page, harness, loginAs, dialogs }) => {
    const w = buildWorld();
    await harness.seed(w.seed());
    await loginAs(w.admin);
    await page.goto('/admin-email-templates.html');

    await page.locator('.template-option[data-template="welcome"]').click();
    await page.locator('#event-select').selectOption(w.event.id);
    await page.locator('#field-header-title').fill('Welcome to the Arctic');
    await page.locator('#body-editor .ql-editor').fill('Your team is in. See you in Oslo!');
    await page.getByRole('button', { name: /Save Template/ }).click();
    await expect(page.locator('#status-bar')).toContainText('Template saved successfully!');

    const [cfg] = await rows("SELECT EventThemes FROM SystemEmailConfig WHERE TemplateKey = 'welcome'");
    const theme = JSON.parse(cfg.EventThemes)[w.event.id];
    expect(theme.headerTitle).toBe('Welcome to the Arctic');
    expect(theme.body).toContain('See you in Oslo!');

    dialogs.next({ value: 'tester@e2e.test' });
    await page.getByRole('button', { name: /Send Test Email/ }).click();
    await expect(page.locator('#status-bar')).toContainText('Test email sent!');
    const mail = await harness.waitForMail('tester@e2e.test');
    expect(mail.html).toContain('See you in Oslo!');
});

test('sequences page lists sequences and shows their emails', async ({ page, harness, loginAs }) => {
    const w = buildWorld();
    const { seq, campaign } = sequenceSeed(w.event, { status: 'draft' });
    await harness.seed(mergeSeeds(w.seed(), { sequences: [seq], 'email-campaigns': [campaign] }));
    await loginAs(w.admin);
    await page.goto('/admin-campaigns.html');
    await page.locator('#sequences-list .sequence-card .sequence-header', { hasText: 'ACDC 2027 drip' }).click();
    await expect(page.locator('#detail-sequence-name')).toHaveText('ACDC 2027 drip');
    await expect(page.locator('#emails-body')).toContainText('Hotel info for');
});

test('admin creates a campaign and sends it once per recipient', async ({ apiAs, harness }) => {
    const w = buildWorld();
    const seq = { id: f.id(), name: 'Manual', description: null, createdAt: new Date().toISOString() };
    await harness.seed(mergeSeeds(w.seed(), { sequences: [seq] }));
    const admin = await apiAs(w.admin);
    const created = await admin.post('/api/email/campaigns', { data: { sequenceId: seq.id, subject: 'Kickoff', content: '<p>Go!</p>' } });
    expect(created.status()).toBe(201);
    const campaignId = (await created.json()).id;

    const recipients = [{ email: w.leader.email, userId: w.leader.id }, { email: w.member.email, userId: w.member.id }];
    const first = await (await admin.post(`/api/email/campaigns/${campaignId}/send`, { data: { recipients } })).json();
    expect(first).toMatchObject({ sent: 2, failed: 0, skipped: 0 });
    const again = await (await admin.post(`/api/email/campaigns/${campaignId}/send`, { data: { recipients } })).json();
    expect(again).toMatchObject({ sent: 0, skipped: 2 });
    expect(await harness.outbox(w.leader.email)).toHaveLength(1);
});

test('the scheduler sends due sequence emails to participants and verified leads, once', async ({ apiAs, harness }) => {
    const w = buildWorld();
    const { seq, campaign } = sequenceSeed(w.event);
    const lead = { id: f.id(), eventId: w.event.id, email: 'lead.lars@e2e.test', firstName: 'Lars', lastName: 'Lead', verified: true,
        verifiedAt: new Date(Date.now() - 3600e3).toISOString(), createdAt: new Date(Date.now() - 3600e3).toISOString() };
    await harness.seed(mergeSeeds(w.seed(), { sequences: [seq], 'email-campaigns': [campaign], 'interest-leads': [lead] }));

    const scheduler = await apiAs(null, { 'x-scheduler-secret': SCHEDULER_SECRET });
    const run = await (await scheduler.post('/api/scheduled-emails/run')).json();
    expect(run.status).toBe('success');
    expect(run.campaignsProcessed).toBe(1);

    const recipients = ['lena.leader@e2e.test', 'mats.member@e2e.test', 'solo.sverre@e2e.test', 'lead.lars@e2e.test'];
    for (const to of recipients) {
        const mail = await harness.waitForMail(to);
        expect(mail.html).toContain('Pack warm clothes.');
    }
    expect(run.emailsSent).toBe(recipients.length);

    const rerun = await (await scheduler.post('/api/scheduled-emails/run')).json();
    expect(rerun.emailsSent).toBe(0);
    expect((await harness.outbox()).length).toBe(recipients.length);
    expect(await rows('SELECT * FROM ScheduledRuns')).toHaveLength(2);
});

test('a failed delivery is recorded and retried on the next scheduled run', async ({ apiAs, harness }) => {
    const w = buildWorld();
    const { seq, campaign } = sequenceSeed(w.event);
    await harness.seed(mergeSeeds(w.seed(), { sequences: [seq], 'email-campaigns': [campaign] }));
    const scheduler = await apiAs(null, { 'x-scheduler-secret': SCHEDULER_SECRET });

    await harness.failNextMail(1);
    const first = await (await scheduler.post('/api/scheduled-emails/run')).json();
    expect(first.emailsFailed).toBe(1);
    expect(await rows("SELECT * FROM EmailDeliveries WHERE Status = 'failed'")).toHaveLength(1);

    const second = await (await scheduler.post('/api/scheduled-emails/run')).json();
    expect(second.emailsSent).toBe(1);
    expect(second.emailsFailed).toBe(0);
});

test.describe('known broken sequence operations', () => {
    test('BUG: copying a sequence copies its emails', async ({ apiAs, harness }) => {
        test.fail(true, 'sequences.js:250 spreads a `stats` object into the insert -> "Invalid column name Stats" -> 500, leaving an orphan "(Copy)"');
        const w = buildWorld();
        const { seq, campaign } = sequenceSeed(w.event, { status: 'draft' });
        await harness.seed(mergeSeeds(w.seed(), { sequences: [seq], 'email-campaigns': [campaign] }));
        const res = await (await apiAs(w.admin)).post(`/api/sequences/${seq.id}/copy`);
        expect(res.status()).toBe(201);  // <- bug
        expect((await res.json()).emailCount).toBe(1);
    });

    test('BUG: deleting a sequence that has emails', async ({ apiAs, harness }) => {
        test.fail(true, 'sequences.js deletes the Sequence before its EmailCampaigns -> FK_EmailCampaigns_Sequences violation -> 500');
        const w = buildWorld();
        const { seq, campaign } = sequenceSeed(w.event, { status: 'draft' });
        w.event.sequenceId = null;
        await harness.seed(mergeSeeds(w.seed(), { sequences: [seq], 'email-campaigns': [campaign] }));
        const res = await (await apiAs(w.admin)).delete(`/api/sequences/${seq.id}`);
        expect(res.status()).toBe(200);  // <- bug
        expect(await rows('SELECT * FROM Sequences')).toHaveLength(0);
    });

    test('BUG: deleting a library badge that is assigned to an event', async ({ apiAs, harness }) => {
        test.fail(true, 'badges.js deletes the Badge before its EventBadges -> FK_EventBadges_Badges violation -> 500');
        const w = buildWorld();
        const b = f.badge();
        await harness.seed(mergeSeeds(w.seed(), { badges: [b], 'event-badges': [f.eventBadge(w.event, b)] }));
        const res = await (await apiAs(w.admin)).delete(`/api/badges/${b.id}`);
        expect(res.status()).toBe(200);  // <- bug
    });
});
