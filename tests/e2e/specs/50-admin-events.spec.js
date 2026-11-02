// admin-events.html: event CRUD, status lifecycle, hotel window, staff invites,
// sponsors, budget and sequences.
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

async function openAdminEvents(page, harness, loginAs, extraSeed = {}, query = '') {
    const w = buildWorld();
    await harness.seed(mergeSeeds(w.seed(), extraSeed));
    await loginAs(w.admin);
    await page.goto(`/admin-events.html${query}`);
    return w;
}

test('admin creates a team event with a hotel window', async ({ page, harness, loginAs }) => {
    await openAdminEvents(page, harness, loginAs);
    await page.locator('#create-event-btn').click();
    await page.locator('#event-name').fill('ACDC 2028');
    await page.locator('#event-description').fill('The Arctic hackathon');
    await page.locator('#event-start').fill('2028-03-01');
    await page.locator('#event-end').fill('2028-03-03');
    await page.locator('#event-location').fill('Oslo');
    await page.locator('.radio-option[data-value="team"]').click();
    await page.locator('summary', { hasText: 'Hotel Booking' }).click();
    await page.locator('#event-hotel-enabled').check();
    await page.locator('#event-hotel-days-before').fill('1');
    await page.locator('#event-hotel-days-after').fill('0');
    await page.locator('#save-btn').click();

    await expect(page.locator('#event-id')).not.toHaveValue('');
    const [e] = await rows("SELECT * FROM Events WHERE Name = 'ACDC 2028'");
    expect(e).toMatchObject({ Status: 'draft', RegistrationType: 'team', HotelEnabled: true, HotelDaysBefore: 1, HotelDaysAfter: 0, Location: 'Oslo' });
    const dates = await rows('SELECT HotelDate FROM EventHotelDates WHERE EventId = @id ORDER BY HotelDate', { id: e.Id });
    expect(dates.map(d => d.HotelDate.toISOString().slice(0, 10))).toEqual(['2028-02-29', '2028-03-01', '2028-03-02', '2028-03-03']);
    const nights = await rows('SELECT NightLabel FROM EventDefaultNights WHERE EventId = @id', { id: e.Id });
    expect(nights.map(n => n.NightLabel).sort()).toEqual(['thu-fri', 'wed-thu']);

    await page.locator('#back-to-list').click();
    await expect(page.locator('#events-table-body')).toContainText('ACDC 2028');
});

test('admin advances an event one status step at a time', async ({ page, harness, loginAs, dialogs }) => {
    const draft = f.event({ name: 'Draft Fest', status: 'draft', isActive: false, registrationOpen: false });
    await openAdminEvents(page, harness, loginAs, { events: [draft] }, `?event=${draft.id}`);

    await page.locator('.status-step[data-status="registration"]').click();
    await expect.poll(() => dialogs.last()?.message).toContain('one step at a time');
    await page.locator('.status-step[data-status="pre-registration"]').click();
    await expect(page.locator('#status-title')).toHaveText('Pre-Registration');
    await page.locator('#save-btn').click();
    await expect.poll(async () => (await rows('SELECT Status FROM Events WHERE Id = @id', { id: draft.id }))[0].Status).toBe('pre-registration');
});

test('admin deletes an event that has no dependants', async ({ page, harness, loginAs, dialogs }) => {
    const lonely = f.event({ name: 'Cancelled Meetup', status: 'draft' });
    await openAdminEvents(page, harness, loginAs, { events: [lonely] }, `?event=${lonely.id}`);
    await page.locator('#delete-btn').click();
    await expect.poll(() => dialogs.last()?.message).toContain('delete this event');
    await expect(page.locator('#events-table-body')).not.toContainText('Cancelled Meetup');
    expect(await rows('SELECT Id FROM Events WHERE Id = @id', { id: lonely.id })).toHaveLength(0);
});

test('admin invites a judge and the judge receives the themed invitation', async ({ page, harness, loginAs }) => {
    const w = await openAdminEvents(page, harness, loginAs);
    await page.goto(`/admin-events.html?event=${w.event.id}&tab=judges`);
    await page.locator('#judge-email').fill('new.judge@e2e.test');
    await page.locator('#invite-judge-btn').click();
    await expect(page.locator('#judges-members-body')).toContainText('new.judge@e2e.test');

    const mail = await harness.waitForMail('new.judge@e2e.test');
    expect(mail.subject).toBe('You are invited to judge ACDC 2027');
    expect(mail.html).toMatch(/[?&]invite=[0-9a-fA-F-]{36}/);
    const [inv] = await rows("SELECT * FROM Invitations WHERE Email = 'new.judge@e2e.test'");
    expect(inv).toMatchObject({ Role: 'judge', Status: 'pending', EventId: w.event.id });
    expect(await rows("SELECT * FROM AllowedEmails WHERE Email = 'new.judge@e2e.test'")).toHaveLength(1);
});

test('admin records, edits and deletes a sponsor', async ({ page, harness, loginAs, dialogs }) => {
    const w = await openAdminEvents(page, harness, loginAs);
    await page.goto(`/admin-events.html?event=${w.event.id}&tab=sponsors`);
    await page.locator('#open-sponsor-modal-btn').click();
    await page.locator('#sponsor-company-name').fill('Contoso');
    await page.locator('#sponsor-contact-person').fill('Carl Contoso');
    await page.locator('#sponsor-email').fill('Carl@Contoso.example');
    await page.locator('#sponsor-amount').fill('25000');
    await page.locator('#sponsor-status').selectOption('negotiating');
    await page.locator('#save-sponsor-btn').click();
    await expect(page.locator('#sponsors-table-body')).toContainText('Contoso');

    const [row] = await rows("SELECT * FROM EventFinancials WHERE Category = 'sponsorship'");
    expect(row).toMatchObject({ ContactPerson: 'Carl Contoso', ContactEmail: 'carl@contoso.example', SponsorStatus: 'negotiating', Type: 'income' });
    expect(Number(row.Amount)).toBe(25000);

    await page.locator('#sponsors-table-body select.sponsor-status-select').selectOption('confirmed');
    await expect.poll(async () => (await rows('SELECT SponsorStatus s FROM EventFinancials WHERE Id = @id', { id: row.Id }))[0].s).toBe('confirmed');

    await page.locator('#sponsors-table-body button', { hasText: '🗑️' }).click();
    await expect.poll(() => dialogs.last()?.message).toBe('Delete this sponsor entry?');
    await expect(page.locator('#sponsors-table-body')).not.toContainText('Contoso');
});

test('admin adds a manual budget row and the summary updates', async ({ page, harness, loginAs }) => {
    const w = await openAdminEvents(page, harness, loginAs);
    await page.goto(`/admin-events.html?event=${w.event.id}&tab=budget`);
    await page.locator('#open-financial-modal-btn').click();
    await page.locator('#financial-type').selectOption('expense');
    await page.locator('#financial-category').selectOption('venue');
    await page.locator('#financial-description').fill('Venue rental');
    await page.locator('#financial-amount').fill('10000');
    await page.locator('#financial-paid-by').selectOption('event');
    await page.locator('#save-financial-btn').click();

    await expect(page.locator('#budget-table-body')).toContainText('Venue rental');
    await expect(page.locator('#budget-total-org-expense')).toContainText('10');
    const [row] = await rows("SELECT * FROM EventFinancials WHERE Description = 'Venue rental'");
    expect(row).toMatchObject({ Type: 'expense', Category: 'venue', PaidBy: 'event', Source: 'manual' });
});

test('recalculate derives hotel, food and fee rows from participations', async ({ apiAs, harness }) => {
    const w = buildWorld();
    Object.assign(w.event, { hotelRatePerNight: 1000, foodRatePerDay: 300, foodDays: 3, costPerParticipant: 500 });
    w.participations.leader.hotelNights = { 'wed-thu': true, 'thu-fri': true };
    await harness.seed(w.seed());
    const admin = await apiAs(w.admin);
    const res = await admin.post(`/api/events/${w.event.id}/financials/recalculate`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ errors: [] });

    const auto = await rows("SELECT Category, Amount, ParticipationId FROM EventFinancials WHERE Source = 'auto' AND ParticipationId = @p",
        { p: w.participations.leader.id });
    const byCat = Object.fromEntries(auto.map(r => [r.Category, Number(r.Amount)]));
    expect(byCat).toMatchObject({ hotel: 2000, food: 900, registration: 500 });
});

test('admin starts an event sequence from scratch', async ({ page, harness, loginAs }) => {
    const w = await openAdminEvents(page, harness, loginAs);
    await page.goto(`/admin-events.html?event=${w.event.id}&tab=sequence`);
    await page.locator('#create-sequence-btn').click();
    await page.getByText('✨ Start from scratch').click();
    await page.locator('#create-sequence-modal').getByRole('button', { name: 'Create Sequence' }).click();
    await expect(page.locator('#sequence-exists-state')).toBeVisible();
    const [e] = await rows('SELECT SequenceId, SequenceEnabled FROM Events WHERE Id = @id', { id: w.event.id });
    expect(e.SequenceEnabled).toBe(true);
    expect(await rows('SELECT * FROM Sequences WHERE Id = @id', { id: e.SequenceId })).toHaveLength(1);
});

test('saving budget rates persists them', async ({ page, harness, loginAs, dialogs }) => {
    const w = await openAdminEvents(page, harness, loginAs);
    await page.goto(`/admin-events.html?event=${w.event.id}&tab=budget`);
    await page.locator('#budget-hotel-rate').fill('1200');
    await page.locator('#budget-hotel-nights').fill('2');
    await page.locator('#save-rates-btn').click();
    await expect.poll(() => dialogs.last()?.message).toContain('Rates saved');
    await expect.poll(async () => Number((await rows('SELECT HotelRatePerNight r FROM Events WHERE Id = @id', { id: w.event.id }))[0].r)).toBe(1200);
});

test('copying a sequence from another event works', async ({ page, harness, loginAs, dialogs }) => {
    const source = f.event({ name: 'ACDC 2026', status: 'completed' });
    const seq = { id: f.id(), name: 'ACDC 2026 drip', description: null, createdAt: new Date().toISOString() };
    source.sequenceId = seq.id;
    const w = await openAdminEvents(page, harness, loginAs, { sequences: [seq], events: [source] });
    await page.goto(`/admin-events.html?event=${w.event.id}&tab=sequence`);
    await page.locator('#create-sequence-btn').click();
    await page.getByText('📋 Copy from another event').click();
    await page.locator('#copy-from-event-select').selectOption(source.id);
    await page.locator('#create-sequence-modal').getByRole('button', { name: 'Create Sequence' }).click();
    await expect(page.locator('#sequence-exists-state')).toBeVisible({ timeout: 4000 });
});

test('an admin can add an email to an event sequence', async ({ page, harness, loginAs }) => {
    const seq = { id: f.id(), name: 'Drip', description: null, createdAt: new Date().toISOString() };
    const w = await openAdminEvents(page, harness, loginAs, { sequences: [seq] });
    await page.goto(`/admin-email.html?mode=sequence&sequenceId=${seq.id}&eventId=${w.event.id}&order=1`);
    await page.locator('#subject').fill('Welcome aboard');
    await page.locator('#editor-container .ql-editor').fill('Hello there');
    await page.locator('#send-btn').click();
    await expect(page.locator('#status-bar')).toContainText('saved successfully', { timeout: 4000 });
});
