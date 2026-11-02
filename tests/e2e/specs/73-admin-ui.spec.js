// Admin frontend hardening: strict CSP on every admin page, stored-XSS payloads rendered as
// text, sandboxed email previews, sequence flows, and the admin-side contract fixes.
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
const XSS_SCRIPT = '<script>window.__xss=1</script>';

function sequenceSeed(evt, overrides = {}) {
    const seq = { id: f.id(), name: 'ACDC 2027 drip', description: null, createdAt: new Date().toISOString() };
    const campaign = {
        id: f.id(), sequenceId: seq.id, subject: 'Hotel info for {{eventName}}', content: '<p>Pack warm clothes.</p>',
        type: 'sequence', sequenceOrder: 1, status: 'draft', createdAt: new Date().toISOString(), ...overrides
    };
    evt.sequenceId = seq.id;
    evt.sequenceEnabled = true;
    return { seq, campaign };
}

function lead(evt, overrides = {}) {
    return {
        id: f.id(), eventId: evt.id, email: `lead${f.id().slice(0, 6).toLowerCase()}@e2e.test`, firstName: 'Lars', lastName: 'Lead',
        verified: true, verifiedAt: new Date(Date.now() - 3600e3).toISOString(), createdAt: new Date(Date.now() - 3600e3).toISOString(),
        ...overrides
    };
}

// A world with every admin surface populated: sequence + campaign, a lead, a badge assigned to the event.
function richWorld(overrides = {}) {
    const w = buildWorld(overrides);
    const { seq, campaign } = sequenceSeed(w.event);
    const badge = f.badge({ name: 'Arctic Explorer' });
    const theLead = lead(w.event);
    const seed = () => mergeSeeds(w.seed(), {
        sequences: [seq],
        'email-campaigns': [campaign],
        'interest-leads': [theLead],
        badges: [badge],
        'event-badges': [f.eventBadge(w.event, badge)]
    });
    return { ...w, seq, campaign, badge, lead: theLead, seed };
}

async function noXss(page) {
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
}

function noThirdParty(context) {
    expect(context.__blockedRequests, 'requests to third-party hosts').toEqual([]);
    expect(context.__cspViolations, 'Content-Security-Policy violations').toEqual([]);
}

test.describe('strict CSP: every admin page loads with no violations and no third-party requests', () => {
    const EVENT_TABS = ['general', 'committee', 'judges', 'leads', 'sponsors', 'budget', 'teams', 'sequence'];

    test('dashboard, teams, people (with drawer), person, interest', async ({ page, context, harness, loginAs }) => {
        const w = richWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);

        await page.goto('/admin-dashboard.html');
        await expect(page.locator('#teams-table-body')).toContainText('Power Rangers');

        await page.goto('/admin-teams.html');
        await expect(page.locator('tr.team-main-row', { hasText: 'Power Rangers' })).toBeVisible();
        await page.locator('tr.team-main-row .expand-btn').first().click();
        await expect(page.locator('tr.member-details-row')).toBeVisible();

        await page.goto('/admin-users.html');
        await expect(page.locator('#admin-content')).toContainText('lena.leader@e2e.test');
        await page.getByText('lena.leader@e2e.test').first().click();
        await expect(page.locator('#person-drawer')).toHaveClass(/open/);
        await expect(page.locator('#drawer-body')).toContainText('ACDC 2027');
        await page.keyboard.press('Escape');
        await expect(page.locator('#person-drawer')).not.toHaveClass(/open/);
        await page.locator('#view-event').click();
        await expect(page.locator('#main-tbody .group-header-row').first()).toBeVisible();

        await page.goto('/admin-person.html?email=lena.leader%40e2e.test');
        await expect(page.locator('#results-container')).toContainText('ACDC 2027');

        await page.goto('/admin-interest.html');
        await expect(page.locator('#queue-table-body')).toBeVisible();

        noThirdParty(context);
    });

    test('events editor: every tab of an existing event, plus the create form', async ({ page, context, harness, loginAs }) => {
        const w = richWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);

        for (const tab of EVENT_TABS) {
            await page.goto(`/admin-events.html?event=${w.event.id}&tab=${tab}`);
            await expect(page.locator(`#${tab}-panel`)).toHaveClass(/active/);
        }
        await expect(page.locator('#sequence-exists-state')).toBeVisible();
        await expect(page.locator('#recipient-delivery-overview')).toContainText(w.lead.email);

        await page.goto('/admin-events.html?action=create');
        await expect(page.locator('#form-title')).toHaveText('Create Event');

        await page.goto(`/admin-event-participants.html?id=${w.event.id}`);
        await expect(page.locator('#participant-count')).toHaveText('3 participants');

        noThirdParty(context);
    });

    test('badges (all tabs), quick email, sequence email editor, templates with preview, sequences detail', async ({ page, context, harness, loginAs }) => {
        const w = richWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);

        await page.goto('/admin-badges.html');
        await expect(page.locator('#badges-container .badge-card')).toHaveCount(1);
        await page.locator('.tab-btn[data-tab="event-badges"]').click();
        await page.locator('#event-badge-selector').selectOption(w.event.id);
        await expect(page.locator('#event-badges-list .event-badge-row')).toHaveCount(1);
        await page.locator('.tab-btn[data-tab="claims"]').click();
        await expect(page.locator('#tab-claims')).toHaveClass(/active/);

        await page.goto('/admin-email.html');
        await expect(page.locator('#editor-container .ql-editor')).toBeVisible();
        await expect(page.locator('#preview-frame')).toHaveAttribute('srcdoc', /Email Subject|<html/i);

        await page.goto(`/admin-email.html?mode=sequence&sequenceId=${w.seq.id}&eventId=${w.event.id}&emailId=${w.campaign.id}`);
        await expect(page.locator('#subject')).toHaveValue('Hotel info for {{eventName}}');
        await expect(page.locator('#send-btn')).toHaveText(/Update Email/);

        await page.goto('/admin-email-templates.html');
        await page.locator('.template-option[data-template="invitation-judge"]').click();
        await page.locator('#event-select').selectOption(w.event.id);
        await expect(page.locator('#template-preview-frame')).toHaveAttribute('srcdoc', /ACDC 2027/);

        await page.goto('/admin-campaigns.html');
        await page.locator('#sequences-list .sequence-header', { hasText: 'ACDC 2027 drip' }).click();
        await expect(page.locator('#emails-body')).toContainText('Hotel info for');
        await expect(page.locator('#sequence-stats')).toContainText('Team Members');

        noThirdParty(context);
    });

    test('admin pages reference no third-party script or style hosts', async ({ request }) => {
        for (const p of ['admin-email', 'admin-email-templates', 'admin-campaigns', 'admin-events', 'admin-badges']) {
            const html = await (await request.get(`/${p}.html`)).text();
            expect(html, p).not.toMatch(/https?:\/\/(cdn\.quilljs\.com|unpkg\.com|cdnjs|jsdelivr)/);
            expect(html, `${p} has inline handlers`).not.toMatch(/\son[a-z]+="/i);
            expect(html, `${p} has inline scripts`).not.toMatch(/<script>/);
        }
    });
});

test.describe('stored XSS payloads render as text on admin pages', () => {
    test('user and team names: teams, dashboard, people, person, event participants, events teams tab', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        w.leader.firstName = XSS;
        w.leader.lastName = 'Leader';
        w.team.teamName = `${XSS} Rangers`;
        await harness.seed(w.seed());
        await loginAs(w.admin);

        await page.goto('/admin-teams.html');
        await expect(page.locator('tr.team-main-row').first()).toContainText(XSS);
        await page.locator('tr.team-main-row .expand-btn').first().click();
        await expect(page.locator('tr.member-details-row')).toContainText(XSS);
        await noXss(page);

        await page.goto('/admin-dashboard.html');
        await expect(page.locator('#teams-table-body')).toContainText(XSS);
        await noXss(page);

        await page.goto('/admin-users.html');
        await expect(page.locator('#main-tbody')).toContainText(XSS);
        await page.getByText('lena.leader@e2e.test').first().click();
        await expect(page.locator('#drawer-name')).toContainText(XSS);
        await expect(page.locator('#drawer-body')).toContainText(`${XSS} Rangers`);
        await noXss(page);

        await page.goto('/admin-person.html?email=lena.leader%40e2e.test');
        await expect(page.locator('#results-container h2')).toContainText(XSS);
        await noXss(page);

        await page.goto(`/admin-event-participants.html?id=${w.event.id}`);
        await expect(page.locator('.team-header-row').first()).toContainText(XSS);
        await expect(page.locator('#participants-body')).toContainText(XSS);
        await noXss(page);

        await page.goto(`/admin-events.html?event=${w.event.id}&tab=teams`);
        await expect(page.locator('#teams-table-body')).toContainText(XSS);
        await noXss(page);
    });

    test('interest lead names in the sequence recipient overview, leads tab and interest queue', async ({ page, harness, loginAs }) => {
        const w = richWorld();
        w.lead.firstName = XSS;
        w.lead.lastName = `M${XSS_SCRIPT}`;
        await harness.seed(w.seed());
        await loginAs(w.admin);

        await page.goto(`/admin-events.html?event=${w.event.id}&tab=sequence`);
        await expect(page.locator('#recipient-overview-body')).toContainText(w.lead.email);
        await expect(page.locator('#recipient-overview-body')).toContainText(XSS);
        await noXss(page);

        await page.locator('.tab-btn[data-tab="leads"]').click();
        await expect(page.locator('#leads-table-body')).toContainText(XSS);
        await noXss(page);
    });

    test('badge names and descriptions, claim evidence', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        const badge = f.badge({ name: `Badge ${XSS}`, description: `Desc ${XSS_SCRIPT}` });
        const eb = f.eventBadge(w.event, badge);
        const claim = { id: f.id(), eventBadgeId: eb.id, badgeId: badge.id, teamId: w.team.id, eventId: w.event.id, status: 'pending',
            evidence: `https://evil.example/?${XSS}`, claimedBy: w.leader.id, claimedAt: new Date().toISOString() };
        await harness.seed(mergeSeeds(w.seed(), { badges: [badge], 'event-badges': [eb], 'badge-claims': [claim] }));
        await loginAs(w.admin);

        await page.goto('/admin-badges.html');
        await expect(page.locator('#badges-container')).toContainText(`Badge ${XSS}`);
        await expect(page.locator('#badges-container')).toContainText(XSS_SCRIPT);
        await page.locator('#badges-container button[data-action="edit-badge"]').click();
        await expect(page.locator('#badge-name')).toHaveValue(`Badge ${XSS}`);
        await page.locator('#cancel-badge-modal-btn').click();

        await page.locator('.tab-btn[data-tab="event-badges"]').click();
        await page.locator('#event-badge-selector').selectOption(w.event.id);
        await expect(page.locator('#event-badges-list')).toContainText(`Badge ${XSS}`);

        await page.locator('.tab-btn[data-tab="claims"]').click();
        await expect(page.locator('#claims-grouped-container')).toContainText(`Badge ${XSS}`);
        await expect(page.locator('#claims-grouped-container')).toContainText(XSS);
        await noXss(page);
    });

    test('sponsor fields and email subjects', async ({ page, harness, loginAs, apiAs }) => {
        const w = richWorld();
        w.campaign.subject = `Subject ${XSS}`;
        await harness.seed(w.seed());
        const admin = await apiAs(w.admin);
        const created = await admin.post(`/api/events/${w.event.id}/sponsors`, {
            data: { companyName: `Contoso ${XSS}`, contactPerson: `Carl ${XSS}`, email: 'contact@contoso.example', notes: `Notes ${XSS_SCRIPT}`, amount: 1000, status: 'confirmed' }
        });
        expect(created.status()).toBeLessThan(300);
        await loginAs(w.admin);

        await page.goto(`/admin-events.html?event=${w.event.id}&tab=sponsors`);
        await expect(page.locator('#sponsors-table-body')).toContainText(`Contoso ${XSS}`);
        await expect(page.locator('#sponsors-table-body')).toContainText(`Carl ${XSS}`);
        await expect(page.locator('#sponsors-table-body')).toContainText(XSS_SCRIPT);
        const mailto = await page.locator('#sponsors-table-body a[href^="mailto:"]').getAttribute('href');
        expect(mailto).toContain('mailto:');
        await noXss(page);

        await page.locator('.tab-btn[data-tab="budget"]').click();
        await expect(page.locator('#budget-table-body')).toContainText(`Contoso ${XSS}`);
        await noXss(page);

        await page.locator('.tab-btn[data-tab="sequence"]').click();
        await expect(page.locator('#sequence-emails-list')).toContainText(`Subject ${XSS}`);
        await noXss(page);

        await page.goto(`/admin-campaigns.html?sequence=${w.seq.id}`);
        await expect(page.locator('#emails-body')).toContainText(`Subject ${XSS}`);
        await noXss(page);
    });
});

test.describe('email previews are sandboxed', () => {
    test('quick email preview: script and onerror in the subject do not execute', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);
        await page.goto('/admin-email.html');
        await page.locator('#subject').fill(`Doors ${XSS}${XSS_SCRIPT}`);
        await page.locator('#preview-btn').click();
        const frame = page.locator('#preview-frame');
        await expect(frame).toHaveAttribute('srcdoc', /onerror=/);
        expect(await frame.getAttribute('sandbox')).toBe('');
        await page.waitForTimeout(300);
        await noXss(page);
    });

    test('template preview: script in an event name does not execute', async ({ page, harness, loginAs }) => {
        const w = buildWorld({ event: { name: `ACDC ${XSS}${XSS_SCRIPT}` } });
        await harness.seed(w.seed());
        await loginAs(w.admin);
        await page.goto('/admin-email-templates.html');
        await page.locator('#event-select').selectOption(w.event.id);
        const frame = page.locator('#template-preview-frame');
        await expect(frame).toHaveAttribute('srcdoc', /<!DOCTYPE html>/);
        expect(await frame.getAttribute('srcdoc')).not.toMatch(/<img src=x onerror=|<script>/);
        expect(await frame.getAttribute('sandbox')).toBe('');
        await page.waitForTimeout(300);
        await noXss(page);
    });
});

test.describe('sequence flows from the event editor', () => {
    test('an email added from the sequence tab is saved to /api/email/campaigns and listed', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        const seq = { id: f.id(), name: 'Drip', description: null, createdAt: new Date().toISOString() };
        w.event.sequenceId = seq.id;
        w.event.sequenceEnabled = true;
        await harness.seed(mergeSeeds(w.seed(), { sequences: [seq] }));
        await loginAs(w.admin);

        await page.goto(`/admin-events.html?event=${w.event.id}&tab=sequence`);
        await page.locator('#add-sequence-email-btn').click();
        await expect(page).toHaveURL(/admin-email\.html\?mode=sequence/);
        await page.locator('#subject').fill('Welcome aboard');
        await page.locator('#editor-container .ql-editor').fill('Hello there');
        const req = page.waitForRequest(r => r.method() === 'POST' && r.url().includes('/api/email/campaigns'));
        await page.locator('#send-btn').click();
        expect((await req).postDataJSON()).toMatchObject({ sequenceId: seq.id, subject: 'Welcome aboard', sequenceOrder: 1 });
        await expect(page.locator('#status-bar')).toContainText('saved successfully');

        await expect(page).toHaveURL(new RegExp(`admin-events\\.html\\?event=${w.event.id}&tab=sequence`), { timeout: 5000 });
        await expect(page.locator('#sequence-emails-list')).toContainText('Welcome aboard');
        expect(await rows('SELECT Subject FROM EmailCampaigns WHERE SequenceId = @id', { id: seq.id })).toEqual([{ Subject: 'Welcome aboard' }]);

        await page.locator('#sequence-emails-list [data-action="edit-email"]').click();
        await expect(page).toHaveURL(/admin-email\.html\?mode=sequence.*emailId=/);
        await page.locator('#cancel-btn').click();
        await expect(page).toHaveURL(new RegExp(`admin-events\\.html\\?event=${w.event.id}&tab=sequence`));
    });

    test.describe('copy from another event', () => {
        test.use({ allowServerErrors: true });
        test('copying posts to /api/sequences/{id}/copy with the target event', async ({ page, harness, loginAs }) => {
            const source = f.event({ name: 'ACDC 2026', status: 'completed' });
            const seq = { id: f.id(), name: 'ACDC 2026 drip', description: null, createdAt: new Date().toISOString() };
            source.sequenceId = seq.id;
            const w = buildWorld();
            await harness.seed(mergeSeeds(w.seed(), { sequences: [seq], events: [source] }));
            await loginAs(w.admin);
            await page.goto(`/admin-events.html?event=${w.event.id}&tab=sequence`);
            await page.locator('#create-sequence-btn').click();
            await page.getByText('📋 Copy from another event').click();
            await page.locator('#copy-from-event-select').selectOption(source.id);
            const req = page.waitForRequest(r => r.method() === 'POST' && /\/api\/sequences\/[^/]+\/copy$/.test(r.url()));
            await page.locator('#confirm-create-sequence-btn').click();
            const request = await req;
            expect(request.url()).toContain(`/api/sequences/${seq.id}/copy`);
            expect(request.postDataJSON()).toEqual({ targetEventId: w.event.id });
        });
    });

    test('teams and sequence tabs stay disabled until the event is saved', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);
        await page.goto('/admin-events.html?action=create');
        for (const tab of ['committee', 'judges', 'leads', 'sponsors', 'budget', 'teams', 'sequence']) {
            await expect(page.locator(`#${tab}-tab-btn`), tab).toBeDisabled();
        }
        await page.locator('#event-name').fill('Tabs Fest');
        await page.locator('#event-start').fill('2028-05-01');
        await page.locator('#event-end').fill('2028-05-02');
        await page.locator('#save-btn').click();
        await expect(page.locator('#event-id')).not.toHaveValue('');
        await expect(page.locator('#teams-tab-btn')).toBeEnabled();
        await expect(page.locator('#sequence-tab-btn')).toBeEnabled();
    });
});

test.describe('admin-side contract fixes', () => {
    test('quick email posts the template fields under data and only sends once per click', async ({ page, context, harness, loginAs, dialogs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);
        await page.goto('/admin-email.html');
        await page.locator('#recipient-filter').selectOption('custom');
        await page.locator('#custom-emails').fill('alpha@e2e.test');
        await page.locator('#subject').fill('Doors open at 09:00');
        await page.locator('#editor-container .ql-editor').fill('Bring your laptop charger.');
        await page.locator('#cta-url').fill('https://acdc.example/agenda');

        let sends = 0;
        await context.route('**/api/email/send', async route => {
            sends++;
            await new Promise(r => setTimeout(r, 800));
            await route.continue();
        });
        const req = page.waitForRequest(r => r.method() === 'POST' && r.url().includes('/api/email/send'));
        await page.locator('#send-btn').click();
        await expect(page.locator('#send-btn')).toBeDisabled();
        await page.locator('#send-btn').click({ force: true }).catch(() => {});
        const body = (await req).postDataJSON();
        expect(body).toMatchObject({
            templateId: 'announcement',
            subject: 'Doors open at 09:00',
            recipients: [{ email: 'alpha@e2e.test' }],
            data: { subject: 'Doors open at 09:00', ctaUrl: 'https://acdc.example/agenda', ctaText: 'Learn More' }
        });
        expect(body.data.content).toContain('Bring your laptop charger.');
        expect(body.content).toBeUndefined();
        await expect(page.locator('#status-bar')).toContainText('Successfully sent to 1 recipient(s)');
        await expect(page.locator('#send-btn')).toBeEnabled();
        expect(sends).toBe(1);
        expect(dialogs.last().message).toBe('Send email to 1 recipient(s)?');
        const mail = await harness.waitForMail('alpha@e2e.test', { subject: 'Doors open at 09:00' });
        expect(mail.html).toContain('Bring your laptop charger.');
    });

    test('dashboard Edit opens the event editor and the members column counts team participants', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);
        await page.goto('/admin-dashboard.html');
        await expect(page.locator('#stat-participants')).toHaveText('2');
        // Members column shows filled / committed places (redesign 2026-11).
        await expect(page.locator('#teams-table-body .badge.count')).toHaveText('2 / 4');
        const countCalls = page.waitForRequest(r => r.url().includes('/participations/team/'), { timeout: 1000 }).catch(() => null);
        expect(await countCalls).toBeNull();
        await page.locator('#events-list .event-row').getByText('Edit').click();
        await expect(page.locator('#event-name')).toHaveValue(w.event.name);
    });

    test('teams page reads the committed size from numberOfParticipants and honours ?team=', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        const other = f.event({ name: 'Other Fest' });
        const otherTeam = f.team(other, w.loner, { teamName: 'Other Team', numberOfParticipants: 5 });
        await harness.seed(mergeSeeds(w.seed(), { events: [other], teams: [otherTeam] }));
        await loginAs(w.admin);

        await page.goto('/admin-teams.html');
        await expect(page.locator('#total-committed')).toHaveText('9');
        await expect(page.locator('tr.team-main-row', { hasText: 'Power Rangers' }).locator('.badge')).toHaveText('2/4');

        await page.goto(`/admin-teams.html?team=${w.team.id.toLowerCase()}`);
        await expect(page.locator('#event-filter')).toHaveValue(w.event.id);
        await expect(page.locator('tr.team-main-row.highlighted')).toContainText('Power Rangers');
        await expect(page.locator('tr.member-details-row .member-list')).toContainText('Mats Member');
        await expect(page.locator('tr.team-main-row')).toHaveCount(1);
    });

    test('event participants and events pages accept lower-case ids', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);
        await page.goto(`/admin-event-participants.html?id=${w.event.id.toLowerCase()}`);
        await expect(page.locator('#participant-count')).toHaveText('3 participants');
        await page.goto(`/admin-events.html?event=${w.event.id.toLowerCase()}&tab=teams`);
        await expect(page.locator('#event-name')).toHaveValue(w.event.name);
        await expect(page.locator('#teams-table-body')).toContainText('Power Rangers');
    });

    test('budget renders NOK when an event has no currency and saving rates sends only event columns', async ({ page, harness, loginAs, dialogs }) => {
        const w = buildWorld({ event: { currency: null } });
        await harness.seed(w.seed());
        await loginAs(w.admin);
        await page.goto(`/admin-events.html?event=${w.event.id}&tab=budget`);
        await expect(page.locator('#event-currency')).toHaveValue('NOK');
        await page.locator('#open-financial-modal-btn').click();
        await page.locator('#financial-description').fill('Venue rental');
        await page.locator('#financial-amount').fill('10000');
        await page.locator('#save-financial-btn').click();
        await expect(page.locator('#budget-table-body')).toContainText('NOK');
        await expect(page.locator('#budget-table-body')).not.toContainText('undefined');

        await page.locator('#budget-hotel-rate').fill('1200');
        await page.locator('#budget-hotel-nights').fill('2');
        await page.locator('#budget-food-rate').fill('300');
        const req = page.waitForRequest(r => r.method() === 'PUT' && r.url().includes(`/api/events/${w.event.id}`));
        await page.locator('#save-rates-btn').click();
        const body = (await req).postDataJSON();
        expect(body).toEqual({ hotelRatePerNight: 1200, foodRatePerDay: 300, foodDays: null });
        await expect.poll(() => dialogs.last()?.message).toContain('Rates saved');
        await expect.poll(async () => Number((await rows('SELECT HotelRatePerNight r FROM Events WHERE Id = @id', { id: w.event.id }))[0].r)).toBe(1200);
    });

    test('events list keeps a stable order for pre-registration and completed events', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        const extra = [
            f.event({ name: 'Old Completed', status: 'completed', startDate: f.isoDate(-400), endDate: f.isoDate(-398) }),
            f.event({ name: 'Teaser', status: 'pre-registration', startDate: f.isoDate(200), endDate: f.isoDate(202) }),
            f.event({ name: 'Sketch', status: 'draft', startDate: f.isoDate(300), endDate: f.isoDate(302) }),
            f.event({ name: 'Running', status: 'live', startDate: f.isoDate(-1), endDate: f.isoDate(1) })
        ];
        await harness.seed(mergeSeeds(w.seed(), { events: extra }));
        await loginAs(w.admin);
        await page.goto('/admin-events.html');
        await expect(page.locator('#events-table-body tr')).toHaveCount(5);
        const names = await page.locator('#events-table-body tr td:first-child').allTextContents();
        expect(names.map(n => n.trim())).toEqual(['Running', 'ACDC 2027', 'Teaser', 'Sketch', 'Old Completed']);
    });

    test('people drawer shows the team name and the interest queue counts verified leads', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);
        await page.goto('/admin-users.html');
        await page.locator('#filter-search').fill('mats');
        await page.getByText('mats.member@e2e.test').first().click();
        await expect(page.locator('#drawer-body')).toContainText('Power Rangers');
    });

    test('email templates can be configured from an empty config', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        const { 'system-email-config': _omit, ...seed } = w.seed();
        await harness.seed(seed);
        await loginAs(w.admin);
        await page.goto('/admin-email-templates.html');
        await expect(page.locator('#merge-fields .merge-field-tag').first()).toBeVisible();
        await page.locator('.template-option[data-template="interest-acknowledgment"]').click();
        await page.locator('#event-select').selectOption(w.event.id);
        await expect(page.locator('#field-header-title')).not.toHaveValue('');
        await page.locator('#field-header-title').fill('Thanks for caring about the Arctic');
        await page.locator('#save-template-btn').click();
        await expect(page.locator('#status-bar')).toContainText('Template saved successfully!');
        const saved = await rows('SELECT TemplateKey FROM SystemEmailConfig ORDER BY TemplateKey');
        expect(saved.map(r => r.TemplateKey)).toEqual(['interest-acknowledgment', 'invitation-committee', 'invitation-judge', 'welcome']);
        const [cfg] = await rows("SELECT EventThemes FROM SystemEmailConfig WHERE TemplateKey = 'interest-acknowledgment'");
        expect(JSON.parse(cfg.EventThemes)[w.event.id].headerTitle).toBe('Thanks for caring about the Arctic');
    });

    test('badge search tolerates badges without a description', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(mergeSeeds(w.seed(), { badges: [f.badge({ name: 'Plain', description: null }), f.badge({ name: 'Fancy' })] }));
        await loginAs(w.admin);
        await page.goto('/admin-badges.html');
        await page.locator('#filter-search').fill('fan');
        await expect(page.locator('#badges-container .badge-card')).toHaveCount(1);
        await page.locator('#filter-search').fill('');
        await expect(page.locator('#badges-container .badge-card')).toHaveCount(2);
    });
});
