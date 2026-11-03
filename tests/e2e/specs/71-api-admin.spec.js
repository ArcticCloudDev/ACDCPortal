// API-level contract for the admin & event endpoints: validation, FK-safe deletes,
// role rules, path anchoring, quick email merge fields and GUID hygiene.
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


function sequenceSeed(evt, { status = 'draft' } = {}) {
    const seq = { id: f.id(), name: 'Drip', description: 'Pre-event emails', createdAt: new Date().toISOString() };
    const campaign = {
        id: f.id(), sequenceId: seq.id, subject: 'Hotel info', content: '<p>Pack warm clothes.</p>',
        type: 'sequence', sequenceOrder: 1, status, scheduledSendTime: null, createdAt: new Date().toISOString()
    };
    evt.sequenceId = seq.id;
    evt.sequenceEnabled = true;
    return { seq, campaign };
}

test.describe('events', () => {
    test('PUT uses an allow-list: unknown keys are ignored, invalid values are 400', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const admin = await apiAs(w.admin);
        const url = `/api/events/${w.event.id}`;

        // The budget page sends hotelNights, which has no column; it must simply be ignored.
        const ok = await admin.put(url, { data: { hotelRatePerNight: 1200, hotelNights: 2, foodRatePerDay: null, foodDays: null } });
        expect(ok.status()).toBe(200);
        expect((await ok.json()).hotelNights).toBeUndefined();
        expect(Number((await rows('SELECT HotelRatePerNight r FROM Events WHERE Id = @id', { id: w.event.id }))[0].r)).toBe(1200);

        const bad = [
            { status: 'bogus' },
            { registrationType: 'duo' },
            { startDate: '2027-13-40' },
            { startDate: '2027-06-10', endDate: '2027-06-01' },
            { minTeamSize: 6, maxTeamSize: 2 },
            { hotelDaysBefore: -1 },
            { sharepointUrl: 'javascript:alert(1)' },
            { sharepointUrl: 'http://insecure.example/site' },
            { sequenceId: 'not-a-guid' }
        ];
        for (const body of bad) {
            const res = await admin.put(url, { data: body });
            expect(res.status(), JSON.stringify(body)).toBe(400);
        }
        expect((await admin.put(`/api/events/${w.event.id}`, { data: { sharepointUrl: 'https://contoso.sharepoint.com/sites/acdc' } })).status()).toBe(200);
        expect((await rows('SELECT Status s FROM Events WHERE Id = @id', { id: w.event.id }))[0].s).toBe('registration');
    });

    test('draft events are hidden from the public and heavy fields are stripped', async ({ apiAs, harness }) => {
        const w = buildWorld({ event: { eventImageData: 'data:image/png;base64,AAAA' } });
        const draft = f.event({ name: 'Secret Draft', status: 'draft', isActive: false, registrationOpen: false });
        await harness.seed(mergeSeeds(w.seed(), { events: [draft] }));

        const anon = await apiAs(null);
        const publicList = await (await anon.get('/api/events')).json();
        expect(publicList.map(e => e.name)).toEqual(['ACDC 2027']);
        expect(publicList[0]).not.toHaveProperty('eventImageData');
        expect((await anon.get(`/api/events/${draft.id}`)).status()).toBe(404);
        expect((await (await anon.get(`/api/events/${w.event.id}`)).json())).not.toHaveProperty('eventImageData');

        const member = await apiAs(w.member);
        expect((await member.get(`/api/events/${draft.id}`)).status()).toBe(404);
        expect((await (await member.get('/api/events')).json()).map(e => e.name)).toEqual(['ACDC 2027']);

        const admin = await apiAs(w.admin);
        const adminList = await (await admin.get('/api/events')).json();
        expect(adminList.map(e => e.name).sort()).toEqual(['ACDC 2027', 'Secret Draft']);
        expect(adminList.find(e => e.id === w.event.id).eventImageData).toBe('data:image/png;base64,AAAA');
        expect((await admin.get(`/api/events/${draft.id}`)).status()).toBe(200);
    });

    test('deleting an event with dependants is a 409 with a clear message', async ({ apiAs, harness }) => {
        const w = buildWorld();
        const lonely = f.event({ name: 'Lonely', status: 'draft', isActive: false, registrationOpen: false });
        await harness.seed(mergeSeeds(w.seed(), { events: [lonely] }));
        const admin = await apiAs(w.admin);

        const blocked = await admin.delete(`/api/events/${w.event.id}`);
        expect(blocked.status()).toBe(409);
        const body = await blocked.json();
        expect(body.error).toMatch(/teams/);
        expect(body.dependants.map(d => d.what)).toEqual(expect.arrayContaining(['teams', 'participations']));
        expect(await rows('SELECT Id FROM Events WHERE Id = @id', { id: w.event.id })).toHaveLength(1);

        expect((await admin.delete(`/api/events/${lonely.id}`)).status()).toBe(200);
        expect(await rows('SELECT Id FROM Events WHERE Id = @id', { id: lonely.id })).toHaveLength(0);
        expect((await admin.delete(`/api/events/${lonely.id}`)).status()).toBe(404);
    });

    test('activating a second event through PUT completes the current one', async ({ apiAs, harness }) => {
        const w = buildWorld();
        const next = f.event({ name: 'Next Year', status: 'draft', isActive: false, registrationOpen: false });
        await harness.seed(mergeSeeds(w.seed(), { events: [next] }));
        const admin = await apiAs(w.admin);

        expect((await admin.put(`/api/events/${next.id}`, { data: { status: 'pre-registration' } })).status()).toBe(200);
        const statuses = Object.fromEntries((await rows('SELECT Id, Status FROM Events')).map(r => [r.Id, r.Status]));
        expect(statuses[w.event.id]).toBe('completed');
        expect(statuses[next.id]).toBe('pre-registration');
    });

    test('a hotel window longer than a week does not repeat default-night labels', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const admin = await apiAs(w.admin);
        const res = await admin.post('/api/events', {
            data: { name: 'Long Camp', startDate: '2028-03-01', endDate: '2028-03-14', status: 'draft', hotelEnabled: true }
        });
        expect(res.status()).toBe(201);
        const created = await res.json();
        expect(new Set(created.hotelDefaultNights).size).toBe(created.hotelDefaultNights.length);
        expect(await rows('SELECT NightLabel FROM EventDefaultNights WHERE EventId = @id', { id: created.id })).toHaveLength(7);

        expect((await admin.post('/api/events', { data: { name: 'Bad', startDate: '2028-03-01', endDate: '2028-02-01' } })).status()).toBe(400);
        expect((await admin.post('/api/events', { data: { name: 'Bad', startDate: '2028-03-01', endDate: '2028-03-02', status: 'nope' } })).status()).toBe(400);
    });
});

test.describe('sequences', () => {
    test('copy duplicates the emails; delete removes deliveries, campaigns and detaches the event', async ({ apiAs, harness }) => {
        const w = buildWorld();
        const { seq, campaign } = sequenceSeed(w.event);
        // Deliveries store the campaign id as NVARCHAR, sometimes lower-case.
        const delivery = { id: f.id(), campaignId: campaign.id.toLowerCase(), email: 'old@e2e.test', status: 'sent', sentAt: new Date().toISOString(), createdAt: new Date().toISOString() };
        await harness.seed(mergeSeeds(w.seed(), { sequences: [seq], 'email-campaigns': [campaign], 'email-deliveries': [delivery] }));
        const admin = await apiAs(w.admin);

        const copied = await admin.post(`/api/sequences/${seq.id}/copy`);
        expect(copied.status()).toBe(201);
        const copy = await copied.json();
        expect(copy.emailCount).toBe(1);
        expect(copy.sequence.name).toBe('Drip (Copy)');
        const copiedCampaigns = await rows('SELECT * FROM EmailCampaigns WHERE SequenceId = @id', { id: copy.sequence.id });
        expect(copiedCampaigns).toHaveLength(1);
        expect(copiedCampaigns[0]).toMatchObject({ Subject: 'Hotel info', Status: 'draft', ScheduledSendTime: null, SequenceOrder: 1 });

        const list = await (await admin.get('/api/sequences')).json();
        const original = list.sequences.find(s => s.id === seq.id);
        expect(original).toMatchObject({ emailCount: 1, stats: { sent: 1, failed: 0 } });

        const detail = await (await admin.get(`/api/sequences/${seq.id}`)).json();
        expect(detail.emails[0].stats).toEqual({ sent: 1, failed: 0, pending: 0 });

        expect((await admin.delete(`/api/sequences/${seq.id}`)).status()).toBe(200);
        expect(await rows('SELECT Id FROM Sequences')).toHaveLength(1);
        expect(await rows('SELECT Id FROM EmailCampaigns WHERE SequenceId = @id', { id: seq.id })).toHaveLength(0);
        expect(await rows('SELECT Id FROM EmailDeliveries')).toHaveLength(0);
        const [evt] = await rows('SELECT SequenceId, SequenceEnabled FROM Events WHERE Id = @id', { id: w.event.id });
        expect(evt).toMatchObject({ SequenceId: null, SequenceEnabled: false });

        expect((await admin.delete(`/api/sequences/${seq.id}`)).status()).toBe(404);
        expect((await admin.post(`/api/sequences/${f.id()}/copy`)).status()).toBe(404);
    });

    test('campaigns are found through the event sequence and matched case-insensitively', async ({ apiAs, harness }) => {
        const w = buildWorld();
        const { seq, campaign } = sequenceSeed(w.event, { status: 'live' });
        const delivery = { id: f.id(), campaignId: campaign.id.toLowerCase(), email: w.leader.email, status: 'failed', errorMessage: 'boom', createdAt: new Date().toISOString() };
        await harness.seed(mergeSeeds(w.seed(), { sequences: [seq], 'email-campaigns': [campaign], 'email-deliveries': [delivery] }));
        const admin = await apiAs(w.admin);

        const byEvent = await (await admin.get(`/api/email/campaigns?eventId=${w.event.id}`)).json();
        expect(byEvent.campaigns.map(c => c.id)).toEqual([campaign.id]);
        expect(byEvent.campaigns[0].stats).toEqual({ total: 1, sent: 0, failed: 1, pending: 0 });

        const created = await admin.post('/api/email/campaigns', { data: { sequenceId: seq.id.toLowerCase(), subject: 'Second', content: '<p>2</p>' } });
        expect(created.status()).toBe(201);
        const second = await created.json();
        expect(second.sequenceOrder).toBe(2);
        expect((await admin.post('/api/email/campaigns', { data: { sequenceId: seq.id, subject: 'x', content: 'y', ctaUrl: 'javascript:alert(1)' } })).status()).toBe(400);
        expect((await admin.post('/api/email/campaigns', { data: { sequenceId: f.id(), subject: 'x', content: 'y' } })).status()).toBe(404);

        // Both the seeded campaign and the one created above belong to the event's sequence (ordered by sequenceOrder).
        const deliveriesView = await (await admin.get(`/api/deliveries/event/${w.event.id}`)).json();
        expect(deliveriesView.campaigns.map(c => c.id.toUpperCase())).toEqual([campaign.id, second.id.toUpperCase()]);
        expect(deliveriesView.deliveries).toHaveLength(1);
    });
});

test.describe('badges', () => {
    test('deleting an assigned library badge removes claims and assignments first', async ({ apiAs, harness }) => {
        const w = buildWorld({ event: { status: 'live' } });
        const b = f.badge();
        const eb = f.eventBadge(w.event, b);
        const claim = { id: f.id(), eventBadgeId: eb.id, eventId: w.event.id, badgeId: b.id, teamId: w.team.id, status: 'pending', blogUrl: 'https://acdc.blog/x', evidence: '', claimedAt: new Date().toISOString() };
        await harness.seed(mergeSeeds(w.seed(), { badges: [b], 'event-badges': [eb], 'badge-claims': [claim] }));
        const admin = await apiAs(w.admin);

        expect((await admin.delete(`/api/badges/${b.id}`)).status()).toBe(200);
        expect(await rows('SELECT Id FROM BadgeClaims')).toHaveLength(0);
        expect(await rows('SELECT Id FROM EventBadges')).toHaveLength(0);
        expect(await rows('SELECT Id FROM Badges')).toHaveLength(0);
        expect((await admin.delete(`/api/badges/${b.id}`)).status()).toBe(404);
    });

    test('badge validation: points, imageUrl, category', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const admin = await apiAs(w.admin);
        const base = { name: 'Valid', category: 'soft', claimType: 'common' };
        expect((await admin.post('/api/badges', { data: { ...base, points: -5 } })).status()).toBe(400);
        expect((await admin.post('/api/badges', { data: { ...base, points: 'ten' } })).status()).toBe(400);
        expect((await admin.post('/api/badges', { data: { ...base, imageUrl: 'javascript:alert(1)' } })).status()).toBe(400);
        expect((await admin.post('/api/badges', { data: { ...base, category: 'hard' } })).status()).toBe(400);
        const ok = await admin.post('/api/badges', { data: { ...base, points: '15', imageUrl: 'https://cdn.example/badge.png' } });
        expect(ok.status()).toBe(201);
        expect((await ok.json()).points).toBe(15);
    });

    test('removing an event badge deletes its claims; bulk dedupes and validates', async ({ apiAs, harness }) => {
        const w = buildWorld({ event: { status: 'live' } });
        const b1 = f.badge({ name: 'One' });
        const b2 = f.badge({ name: 'Two' });
        const eb1 = f.eventBadge(w.event, b1);
        const claim = { id: f.id(), eventBadgeId: eb1.id, eventId: w.event.id, badgeId: b1.id, teamId: w.team.id, status: 'approved', blogUrl: '', evidence: '', claimedAt: new Date().toISOString() };
        await harness.seed(mergeSeeds(w.seed(), { badges: [b1, b2], 'event-badges': [eb1], 'badge-claims': [claim] }));
        const admin = await apiAs(w.admin);

        expect((await admin.delete(`/api/events/${w.event.id}/badges/${eb1.id}`)).status()).toBe(200);
        expect(await rows('SELECT Id FROM BadgeClaims')).toHaveLength(0);
        expect(await rows('SELECT Id FROM EventBadges')).toHaveLength(0);

        expect((await admin.post(`/api/events/${w.event.id}/badges/bulk`, { data: { selectedBadgeIds: ['does-not-exist'] } })).status()).toBe(400);
        expect((await admin.post(`/api/events/${f.id()}/badges/bulk`, { data: { selectedBadgeIds: [b1.id] } })).status()).toBe(404);
        const bulk = await admin.post(`/api/events/${w.event.id}/badges/bulk`, { data: { selectedBadgeIds: [b1.id, b1.id, b2.id] } });
        expect(bulk.status()).toBe(200);
        expect(await bulk.json()).toEqual({ added: 2, removed: 0, total: 2 });
        expect(await rows('SELECT Id FROM EventBadges WHERE EventId = @id', { id: w.event.id })).toHaveLength(2);

        // Soft first in the event listing too.
        const listed = await (await (await apiAs(w.member)).get(`/api/events/${w.event.id}/badges`)).json();
        expect(listed.map(x => x.badge.name)).toEqual(['One', 'Two']);
    });
});

test.describe('badge claims', () => {
    test('review only moves pending claims and honours the assigned judge', async ({ apiAs, harness }) => {
        const w = buildWorld({ event: { status: 'live' } });
        const judy = f.user({ email: 'judy.judge@e2e.test' });
        const jon = f.user({ email: 'jon.judge@e2e.test' });
        const b = f.badge();
        const eb = f.eventBadge(w.event, b, { judgeUserId: judy.id });
        const pending = { id: f.id(), eventBadgeId: eb.id, eventId: w.event.id, badgeId: b.id, teamId: w.team.id, status: 'pending', blogUrl: 'https://acdc.blog/x', evidence: '', claimedAt: new Date().toISOString() };
        const seed = w.seed();
        seed.users.push(judy, jon);
        seed.participations.push(f.participation(judy, w.event, { roles: ['judge'] }), f.participation(jon, w.event, { roles: ['judge'] }));
        await harness.seed(mergeSeeds(seed, { badges: [b], 'event-badges': [eb], 'badge-claims': [pending] }));

        const url = `/api/badge-claims/${pending.id}/review`;
        expect((await (await apiAs(w.member)).put(url, { data: { status: 'approved' } })).status()).toBe(403);
        expect((await (await apiAs(jon)).put(url, { data: { status: 'approved' } })).status()).toBe(403);
        expect((await (await apiAs(judy)).put(url, { data: { status: 'declined' } })).status()).toBe(400);

        const approved = await (await apiAs(judy)).put(url, { data: { status: 'approved', reviewedBy: judy.id } });
        expect(approved.status()).toBe(200);
        expect((await approved.json()).reviewedBy.toUpperCase()).toBe(judy.id);

        expect((await (await apiAs(judy)).put(url, { data: { status: 'declined', declineReason: 'changed my mind' } })).status()).toBe(409);
        expect((await (await apiAs(w.admin)).put(url, { data: { status: 'declined', declineReason: 'nope' } })).status()).toBe(409);
        expect((await rows('SELECT Status s FROM BadgeClaims WHERE Id = @id', { id: pending.id }))[0].s).toBe('approved');

        // Drafts (assigned, never submitted) cannot be approved either.
        const draft = await (await apiAs(w.leader)).put('/api/badge-claims/assign', { data: { eventBadgeId: eb.id, teamId: w.team.id, assignedToUserId: w.member.id } });
        expect(draft.status()).toBe(200);
        const claims = await rows('SELECT Id, Status FROM BadgeClaims WHERE TeamId = @t', { t: w.team.id });
        expect(claims).toHaveLength(1);
    });

    test('a claim must match the badge event and carry an http(s) blogUrl', async ({ apiAs, harness }) => {
        const w = buildWorld({ event: { status: 'live' } });
        const other = f.event({ name: 'Other', status: 'completed', isActive: false, registrationOpen: false });
        const otherTeam = f.team(other, w.loner, { teamName: 'Strangers' });
        const b = f.badge();
        const eb = f.eventBadge(w.event, b);
        const seed = w.seed();
        seed.participations.push(f.participation(w.loner, other, { teamId: otherTeam.id, isTeamAdmin: true, roles: ['participant'] }));
        await harness.seed(mergeSeeds(seed, { events: [other], teams: [otherTeam], badges: [b], 'event-badges': [eb] }));

        const loner = await apiAs(w.loner);
        const mismatch = await loner.post('/api/badge-claims', { data: { eventBadgeId: eb.id, teamId: otherTeam.id, blogUrl: 'https://acdc.blog/x' } });
        expect(mismatch.status()).toBe(400);
        expect((await mismatch.json()).error).toMatch(/does not belong/);

        const member = await apiAs(w.member);
        const base = { eventBadgeId: eb.id, teamId: w.team.id };
        expect((await member.post('/api/badge-claims', { data: { ...base, blogUrl: 'javascript:alert(1)' } })).status()).toBe(400);
        expect((await member.post('/api/badge-claims', { data: { ...base, blogUrl: `https://acdc.blog/${'x'.repeat(2001)}` } })).status()).toBe(400);
        expect((await member.post('/api/badge-claims', { data: { ...base, blogUrl: 'https://acdc.blog/x', evidence: 'e'.repeat(2001) } })).status()).toBe(400);
        expect((await member.post('/api/badge-claims', { data: { ...base, blogUrl: 'https://acdc.blog/x', claimedBy: 'nope' } })).status()).toBe(400);
        expect((await member.post('/api/badge-claims', { data: { eventBadgeId: 'nope', teamId: w.team.id } })).status()).toBe(400);
        expect(await rows('SELECT Id FROM BadgeClaims')).toHaveLength(0);

        const ok = await member.post('/api/badge-claims', { data: { ...base, blogUrl: 'https://acdc.blog/x', claimedBy: w.member.id } });
        expect(ok.status()).toBe(201);
        expect((await ok.json()).claimedBy).toBe(w.member.id);
    });
});

test.describe('files', () => {
    const q = w => `eventId=${w.event.id}&teamId=${w.team.id}`;

    test('paths are anchored to Events/<event>/<team>/<file> and the team must belong to the event', async ({ apiAs, harness }) => {
        const w = buildWorld({ event: { status: 'live', sharepointUrl: 'https://contoso.sharepoint.com/sites/acdc' } });
        const other = f.event({ name: 'Other', status: 'completed', isActive: false, registrationOpen: false });
        await harness.seed(mergeSeeds(w.seed(), { events: [other] }));
        const member = await apiAs(w.member);

        const up = await member.post(`/api/files/upload?${q(w)}`, {
            multipart: { file: { name: 'demo.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') } }
        });
        expect(up.status()).toBe(200);

        const good = `Events/${w.event.id}/${w.team.id}/demo.mp4`;
        expect((await (await member.get(`/api/files/list?${q(w)}`)).json()).map(x => x.name)).toEqual(['demo.mp4']);

        const badPaths = [
            `Events/${w.event.id}/${w.team.id}/../${f.id()}/demo.mp4`,
            `Events/${w.event.id}/${w.team.id}/demo.mp4/extra`,
            `Events/${w.event.id}/${w.team.id}/..`,
            `Events/not-a-guid/${w.team.id}/demo.mp4`,
            `/Events/${w.event.id}/${w.team.id}/demo.mp4`,
            `Shared/Events/${w.event.id}/${w.team.id}/demo.mp4`
        ];
        for (const p of badPaths) {
            expect((await member.delete(`/api/files/delete?path=${encodeURIComponent(p)}`)).status(), p).toBe(400);
        }
        // Right team, wrong event.
        const wrongEvent = `Events/${other.id}/${w.team.id}/demo.mp4`;
        expect((await member.delete(`/api/files/delete?path=${encodeURIComponent(wrongEvent)}`)).status()).toBe(400);
        expect((await member.get(`/api/files/list?eventId=${other.id}&teamId=${w.team.id}`)).status()).toBe(400);
        expect((await member.post(`/api/files/upload?eventId=${other.id}&teamId=${w.team.id}`, {
            multipart: { file: { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') } }
        })).status()).toBe(400);
        // Only the part named "file" is accepted.
        expect((await member.post(`/api/files/upload?${q(w)}`, {
            multipart: { attachment: { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') } }
        })).status()).toBe(400);
        expect((await member.delete(`/api/files/delete?path=${encodeURIComponent(`Events/${w.event.id}/${w.team.id}/missing.txt`)}`)).status()).toBe(404);

        const sp = await harness.sharepoint();
        expect(sp.files.map(x => x.path)).toEqual([good]);
    });

    test('a 6 MB upload succeeds and 11 MB is refused with a 400', async ({ apiAs, harness }) => {
        const w = buildWorld({ event: { status: 'live' } });
        await harness.seed(w.seed());
        const member = await apiAs(w.member);
        const big = await member.post(`/api/files/upload?${q(w)}`, {
            multipart: { file: { name: 'big.zip', mimeType: 'application/zip', buffer: Buffer.alloc(6 * 1024 * 1024, 7) } }
        });
        expect(big.status()).toBe(200);
        expect((await harness.sharepoint()).files.find(x => x.path.endsWith('/big.zip')).size).toBe(6 * 1024 * 1024);

        const huge = await member.post(`/api/files/upload?${q(w)}`, {
            multipart: { file: { name: 'huge.zip', mimeType: 'application/zip', buffer: Buffer.alloc(11 * 1024 * 1024, 7) } }
        });
        expect(huge.status()).toBe(400);
    });
});

test.describe('email', () => {
    test('quick email body and subject reach the recipient (legacy and contract shapes)', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const admin = await apiAs(w.admin);

        const legacy = await admin.post('/api/email/send', {
            data: {
                templateId: 'announcement', subject: 'Doors open at 09:00', content: '<p>Bring your laptop charger.</p>',
                ctaUrl: 'https://acdc.blog/agenda', ctaText: 'See agenda',
                recipients: [{ email: 'alpha@e2e.test', name: 'Alpha Person' }]
            }
        });
        expect(legacy.status()).toBe(200);
        const mail = await harness.waitForMail('alpha@e2e.test', { subject: 'Doors open at 09:00' });
        expect(mail.html).toContain('Bring your laptop charger.');
        expect(mail.html).toContain('<h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600;">Doors open at 09:00</h1>');
        expect(mail.html).toContain('https://acdc.blog/agenda');
        expect(mail.html).toContain('Hi Alpha,');

        const contract = await admin.post('/api/email/send', {
            data: {
                templateId: 'announcement', subject: 'ignored when data.subject is set',
                recipients: [{ email: 'beta@e2e.test', firstName: 'Beta' }],
                data: { subject: 'Hello {{firstName}}', content: '<p>Contract body</p>', ctaUrl: null, ctaText: null }
            }
        });
        expect(contract.status()).toBe(200);
        const mail2 = await harness.waitForMail('beta@e2e.test', { subject: 'Hello Beta' });
        expect(mail2.html).toContain('Contract body');

        expect((await admin.post('/api/email/send', { data: { templateId: '../../package', subject: 's', content: 'c', recipients: [{ email: 'x@e2e.test' }] } })).status()).toBe(404);
        expect((await admin.post('/api/email/send', { data: { templateId: 'announcement', subject: 's', content: 'c', ctaUrl: 'javascript:alert(1)', recipients: [{ email: 'x@e2e.test' }] } })).status()).toBe(400);
        expect((await admin.post('/api/email/send', { data: { templateId: 'announcement', subject: 's', content: 'c', recipients: [{ email: 'not an email' }] } })).status()).toBe(400);
        expect((await admin.post('/api/email/preview', { data: { templateId: 'nope', data: {} } })).status()).toBe(404);
        expect((await harness.outbox()).length).toBe(2);
    });

    test('recipient filters resolve team admins, team members and all event contacts', async ({ apiAs, harness }) => {
        const w = buildWorld();
        const judge = f.user({ email: 'judy.judge@e2e.test' });
        const seed = w.seed();
        seed.users.push(judge);
        seed.participations.push(f.participation(judge, w.event, { roles: ['judge'] }));
        const leads = [
            { id: f.id(), eventId: w.event.id, email: 'lead.lars@e2e.test', firstName: 'Lars', lastName: 'Lead', verified: true, createdAt: new Date().toISOString() },
            { id: f.id(), eventId: w.event.id, email: 'MATS.MEMBER@e2e.test', firstName: 'Dup', lastName: 'Lead', verified: true, createdAt: new Date().toISOString() },
            { id: f.id(), eventId: w.event.id, email: 'unverified@e2e.test', firstName: 'Un', lastName: 'Verified', verified: false, createdAt: new Date().toISOString() }
        ];
        await harness.seed(mergeSeeds(seed, { 'interest-leads': leads }));
        const admin = await apiAs(w.admin);
        const emails = async filter => (await (await admin.get(`/api/email/recipients?eventId=${w.event.id}&filter=${filter}`)).json()).map(r => r.email.toLowerCase()).sort();

        expect(await emails('team-admins')).toEqual(['lena.leader@e2e.test']);
        expect(await emails('team-members')).toEqual(['mats.member@e2e.test']);
        expect(await emails('all-participants')).toEqual(['lena.leader@e2e.test', 'mats.member@e2e.test']);
        expect(await emails('all-event-contacts')).toEqual(['judy.judge@e2e.test', 'lead.lars@e2e.test', 'lena.leader@e2e.test', 'mats.member@e2e.test', 'solo.sverre@e2e.test']);
        expect((await admin.get('/api/email/recipients?eventId=nope&filter=team-admins')).status()).toBe(400);
    });
});

test.describe('financials', () => {
    test('the summary counts only confirmed sponsors and validates sponsor and budget input', async ({ apiAs, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        const admin = await apiAs(w.admin);
        const base = `/api/events/${w.event.id}`;

        for (const [status, amount] of [['confirmed', 10000], ['negotiating', 5000], ['declined', 3000], ['reached-out', 700]]) {
            expect((await admin.post(`${base}/sponsors`, { data: { companyName: `Sponsor ${status}`, amount, status } })).status()).toBe(201);
        }
        expect((await (await admin.get(`${base}/sponsors`)).json())).toHaveLength(4);
        expect((await (await admin.get(`${base}/financials`)).json()).filter(r => r.category === 'sponsorship')).toHaveLength(4);
        const summary = await (await admin.get(`${base}/financials/summary`)).json();
        expect(summary.totalIncome).toBe(10000);
        expect(summary.netBalance).toBe(10000);

        expect((await admin.post(`${base}/sponsors`, { data: { companyName: '', amount: 1 } })).status()).toBe(400);
        expect((await admin.post(`${base}/sponsors`, { data: { companyName: 'X', email: 'not-an-email' } })).status()).toBe(400);
        expect((await admin.post(`${base}/sponsors`, { data: { companyName: 'X', amount: -1 } })).status()).toBe(400);
        expect((await admin.post(`${base}/sponsors`, { data: { companyName: 'X', status: 'maybe' } })).status()).toBe(400);
        expect((await admin.post(`/api/events/${f.id()}/sponsors`, { data: { companyName: 'X' } })).status()).toBe(404);

        expect((await admin.post(`${base}/financials`, { data: { type: 'expense', category: 'venue', amount: 10 } })).status()).toBe(400);
        expect((await admin.post(`${base}/financials`, { data: { type: 'expense', category: 'venue', description: 'd'.repeat(201), amount: 10 } })).status()).toBe(400);
        expect((await admin.put(`${base}/financials/${f.id()}`, { data: { amount: 5 } })).status()).toBe(404);
        expect((await admin.patch(`${base}/financials/${f.id()}`, { data: { paidBy: 'event' } })).status()).toBe(404);
        expect((await admin.patch(`${base}/financials/${f.id()}`, { data: { paidBy: 'santa' } })).status()).toBe(400);
    });

    test('auto rows are removed again when the underlying rate becomes zero', async ({ apiAs, harness }) => {
        const w = buildWorld();
        Object.assign(w.event, { hotelRatePerNight: 1000, foodRatePerDay: 300, foodDays: 3, costPerParticipant: 500 });
        w.participations.leader.hotelNights = { 'wed-thu': true, 'thu-fri': true };
        await harness.seed(w.seed());
        const admin = await apiAs(w.admin);
        const base = `/api/events/${w.event.id}`;
        const autoRows = async () => Object.fromEntries((await rows("SELECT Category, Amount FROM EventFinancials WHERE Source = 'auto' AND ParticipationId = @p", { p: w.participations.leader.id })).map(r => [r.Category, Number(r.Amount)]));

        expect((await admin.post(`${base}/financials/recalculate`)).status()).toBe(200);
        expect(await autoRows()).toEqual({ hotel: 2000, food: 900, registration: 500 });

        expect((await admin.put(base, { data: { hotelRatePerNight: null, foodDays: 0, costPerParticipant: 0 } })).status()).toBe(200);
        expect((await admin.post(`${base}/financials/recalculate`)).status()).toBe(200);
        expect(await autoRows()).toEqual({});
    });
});

test('malformed GUIDs are rejected with 4xx, never 500', async ({ apiAs, harness }) => {
    const w = buildWorld({ event: { status: 'live' } });
    await harness.seed(w.seed());
    const admin = await apiAs(w.admin);
    const member = await apiAs(w.member);
    const anon = await apiAs(null);
    const e = w.event.id;

    const cases = [
        [anon, 'get', '/api/events/not-a-guid'],
        [admin, 'put', '/api/events/not-a-guid', { name: 'x' }],
        [admin, 'delete', '/api/events/not-a-guid'],
        [member, 'get', '/api/events/not-a-guid/badges'],
        [admin, 'post', '/api/events/not-a-guid/badges', { badgeIds: ['x'] }],
        [admin, 'put', `/api/events/${e}/badges/not-a-guid`, { isActive: false }],
        [admin, 'delete', `/api/events/${e}/badges/not-a-guid`],
        [admin, 'post', '/api/events/not-a-guid/badges/bulk', { selectedBadgeIds: [] }],
        [member, 'get', '/api/badge-claims?eventId=not-a-guid'],
        [member, 'get', '/api/badge-claims?teamId=not-a-guid'],
        [admin, 'put', '/api/badge-claims/not-a-guid/review', { status: 'approved' }],
        [member, 'put', '/api/badge-claims/not-a-guid', { evidence: 'x' }],
        [admin, 'delete', '/api/badge-claims/not-a-guid'],
        [member, 'post', '/api/badge-claims', { eventBadgeId: 'not-a-guid', teamId: w.team.id }],
        [admin, 'post', '/api/badge-claims/award', { eventBadgeId: 'not-a-guid', teamId: 'nope' }],
        [member, 'put', '/api/badge-claims/assign', { eventBadgeId: 'not-a-guid', teamId: w.team.id }],
        [admin, 'get', '/api/sequences/not-a-guid'],
        [admin, 'put', '/api/sequences/not-a-guid', { name: 'x' }],
        [admin, 'delete', '/api/sequences/not-a-guid'],
        [admin, 'post', '/api/sequences/not-a-guid/copy'],
        [admin, 'get', '/api/email/campaigns?eventId=not-a-guid'],
        [admin, 'get', '/api/email/campaigns/not-a-guid'],
        [admin, 'put', '/api/email/campaigns/not-a-guid', { subject: 'x' }],
        [admin, 'delete', '/api/email/campaigns/not-a-guid'],
        [admin, 'post', '/api/email/campaigns/not-a-guid/send', { recipients: [{ email: 'a@e2e.test' }] }],
        [admin, 'get', '/api/email/campaigns/not-a-guid/deliveries'],
        [admin, 'post', '/api/email/campaigns', { sequenceId: 'not-a-guid', subject: 's', content: 'c' }],
        [admin, 'get', '/api/deliveries/event/not-a-guid'],
        [admin, 'get', '/api/events/not-a-guid/financials'],
        [admin, 'get', '/api/events/not-a-guid/financials/summary'],
        [admin, 'post', '/api/events/not-a-guid/financials', { type: 'expense', category: 'venue', description: 'x', amount: 1 }],
        [admin, 'put', `/api/events/${e}/financials/not-a-guid`, { amount: 1 }],
        [admin, 'patch', `/api/events/${e}/financials/not-a-guid`, { paidBy: 'event' }],
        [admin, 'delete', `/api/events/${e}/financials/not-a-guid`],
        [admin, 'post', '/api/events/not-a-guid/financials/recalculate'],
        [admin, 'get', '/api/events/not-a-guid/sponsors'],
        [admin, 'post', '/api/events/not-a-guid/sponsors', { companyName: 'x' }],
        [admin, 'put', `/api/events/${e}/sponsors/not-a-guid`, { companyName: 'x' }],
        [admin, 'delete', `/api/events/${e}/sponsors/not-a-guid`],
        [member, 'get', '/api/files/list?eventId=not-a-guid&teamId=not-a-guid'],
        [member, 'delete', '/api/files/delete?path=Events/not-a-guid/not-a-guid/x.txt'],
        [admin, 'get', '/api/email/recipients?eventId=not-a-guid'],
        [admin, 'post', '/api/system-emails/preview', { templateType: 'welcome', eventId: 'not-a-guid' }],
        [admin, 'post', '/api/system-emails/test', { templateType: 'welcome', eventId: 'not-a-guid', testEmail: 'a@e2e.test' }]
    ];
    for (const [client, method, url, data] of cases) {
        const res = await client[method](url, data !== undefined ? { data } : undefined);
        expect(res.status(), `${method.toUpperCase()} ${url}`).toBeGreaterThanOrEqual(400);
        expect(res.status(), `${method.toUpperCase()} ${url}`).toBeLessThan(500);
        const text = await res.text();
        expect(text, `${method.toUpperCase()} ${url}`).not.toMatch(/at .*\.js:\d+|Conversion failed|uniqueidentifier/i);
    }
});
