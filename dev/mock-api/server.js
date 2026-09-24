// Local mock API + static server for frontend work.
//
//   npm run dev        -> http://localhost:4280
//
// Serves src/ as-is and answers /api/* from in-memory fixtures (dev/mock-api/fixtures.js).
// No Azure, no SQL, no mail. Restarting the server resets all data.
//
// Log in at http://localhost:4280/dev-login (one click), or use the real login page
// with any fixture email and the OTP code 123456.

const path = require('path');
const express = require('express');
const F = require('./fixtures');

const PORT = Number(process.env.PORT) || 4280;
const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const MOCK_OTP = '123456';

const app = express();
app.use(express.json());

// ---------- helpers ----------
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const nowIso = () => new Date().toISOString();
const newId = () => {
    const h = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0');
    return `${h()}-${h().slice(0, 4)}-4${h().slice(0, 3)}-8${h().slice(0, 3)}-${h()}${h().slice(0, 4)}`;
};
const lower = (s) => (s || '').toLowerCase();

function makeToken(user) {
    const payload = {
        email: user.email,
        userId: user.id,
        isPortalAdmin: !!user.isPortalAdmin,
        iss: 'acdc-portal',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 8 * 3600,
    };
    return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.mock`;
}

function readToken(req) {
    const token = req.get('x-acdc-token');
    if (!token) return null;
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        if (payload.exp * 1000 < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

function publicUser(u) {
    return {
        id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName,
        name: `${u.firstName} ${u.lastName}`, profileComplete: !!u.profileComplete, isPortalAdmin: !!u.isPortalAdmin,
    };
}

const findUserByEmail = (email) => F.users.find(u => lower(u.email) === lower(email));
const findUserById = (id) => F.users.find(u => u.id === id);

// ---------- request log ----------
app.use('/api', (req, _res, next) => {
    console.log(`${req.method} /api${req.url}`);
    next();
});

// ---------- public auth endpoints ----------
app.post('/api/auth/check-email', (req, res) => {
    const user = findUserByEmail(req.body?.email);
    res.json(user
        ? { allowed: true, isNewUser: false, message: 'Email verified, proceed with login' }
        : { allowed: false, isNewUser: true, message: 'New email, proceed with registration' });
});

app.post('/api/auth/send-otp', (req, res) => {
    console.log(`   OTP for ${req.body?.email} is ${MOCK_OTP}`);
    res.json({ success: true, message: `Mock: use code ${MOCK_OTP}` });
});

app.post('/api/auth/verify-otp', (req, res) => {
    const { email, code } = req.body || {};
    if (code !== MOCK_OTP) return res.status(400).json({ message: `Invalid code. Mock server accepts ${MOCK_OTP}.` });
    let user = findUserByEmail(email);
    if (!user) {
        user = { id: newId(), email: lower(email), firstName: 'New', lastName: 'User', phone: null, gamertag: null, allergies: null, isPortalAdmin: false, profileComplete: false, teamId: null, createdAt: nowIso(), updatedAt: null };
        F.users.push(user);
    }
    res.json({ success: true, message: 'Verification successful', token: makeToken(user), user: publicUser(user) });
});

app.post('/api/register/start', (req, res) => {
    const b = req.body || {};
    if (findUserByEmail(b.email)) return res.status(409).json({ message: 'This email is already registered. Please login instead.' });
    const [firstName, ...rest] = (b.name || 'New User').split(' ');
    F.users.push({ id: newId(), email: lower(b.email), firstName, lastName: rest.join(' ') || '', phone: b.phone || null, gamertag: b.gamertag || null, allergies: b.allergies || null, isPortalAdmin: false, profileComplete: false, teamId: null, createdAt: nowIso(), updatedAt: null });
    res.json({ success: true, pendingId: newId(), message: 'Account prepared. Proceed to email verification.' });
});

app.post('/api/interest/record', (req, res) => res.json({ success: true }));

// Public reads (same allowlist as production)
app.get('/api/events', (_req, res) => res.json(F.events));
app.get('/api/events/active', (_req, res) => {
    const e = F.events.find(x => x.isActive);
    e ? res.json(e) : res.status(404).json({ error: 'No active event found' });
});
app.get('/api/events/:id', (req, res) => {
    const e = F.events.find(x => x.id === req.params.id);
    e ? res.json(e) : res.status(404).json({ error: 'Event not found' });
});
app.get('/api/badges', (req, res) => {
    const c = req.query.category;
    res.json(c ? F.badges.filter(b => b.category === c) : F.badges);
});
app.get('/api/badges/:id', (req, res) => {
    const b = F.badges.find(x => x.id === req.params.id);
    b ? res.json(b) : res.status(404).json({ error: 'Badge not found' });
});
app.get('/api/invitations/:id', (req, res) => {
    const i = F.invitations.find(x => x.id === req.params.id);
    i ? res.json(i) : res.status(404).json({ message: 'Invitation not found' });
});

// ---------- everything below requires a session ----------
app.use('/api', (req, res, next) => {
    const auth = readToken(req);
    if (!auth) return res.status(401).json({ message: 'Unauthorized' });
    req.auth = auth;
    next();
});

// register/complete
app.post('/api/register/complete', (req, res) => {
    const u = findUserByEmail(req.auth.email);
    if (u) { u.profileComplete = true; u.updatedAt = nowIso(); }
    res.json({ success: true, user: u ? publicUser(u) : null });
});

// ---------- users ----------
app.get('/api/users/all', (_req, res) => res.json(F.users));
app.get('/api/users', (req, res) => {
    const u = findUserByEmail(req.query.email);
    u ? res.json(u) : res.status(404).json({ message: 'User not found' });
});
app.get('/api/users/:id', (req, res) => {
    const u = findUserById(req.params.id);
    u ? res.json(u) : res.status(404).json({ message: 'User not found' });
});
app.post('/api/users', (req, res) => {
    const u = { id: newId(), isPortalAdmin: false, profileComplete: false, teamId: null, createdAt: nowIso(), updatedAt: null, ...req.body };
    F.users.push(u);
    res.status(201).json(u);
});
app.put('/api/users/:id', (req, res) => {
    const u = findUserById(req.params.id);
    if (!u) return res.status(404).json({ message: 'User not found' });
    const { id, isPortalAdmin, ...patch } = req.body || {};
    Object.assign(u, patch, { updatedAt: nowIso() });
    res.json(u);
});

// ---------- events (admin writes) ----------
app.post('/api/events', (req, res) => {
    const e = { id: newId(), status: 'draft', registrationType: 'team', registrationOpen: false, isActive: false, hotelDates: [], hotelDefaultNights: [], createdAt: nowIso(), updatedAt: null, ...req.body };
    F.events.push(e);
    res.status(201).json(e);
});
app.put('/api/events/:id', (req, res) => {
    const e = F.events.find(x => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: 'Event not found' });
    Object.assign(e, req.body, { id: e.id, updatedAt: nowIso() });
    res.json(e);
});
app.delete('/api/events/:id', (req, res) => {
    const i = F.events.findIndex(x => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Event not found' });
    const [e] = F.events.splice(i, 1);
    res.json({ message: 'Event deleted', event: e });
});
app.get('/api/events/:id/sponsors', (_req, res) => res.json([]));
app.get('/api/events/:id/financials', (_req, res) => res.json([]));
app.get('/api/events/:id/financials/summary', (_req, res) => res.json({ rows: [], totals: {} }));

// event badges
app.get('/api/events/:id/badges', (req, res) => {
    const order = { soft: 0, 'low-code': 1, 'pro-code': 2, sponsor: 3 };
    let list = F.eventBadges.filter(eb => eb.eventId === req.params.id)
        .map(eb => ({ ...eb, badge: F.badges.find(b => b.id === eb.badgeId) || null }))
        .sort((a, b) => (order[a.badge?.category] ?? 99) - (order[b.badge?.category] ?? 99) || a.badge.name.localeCompare(b.badge.name));
    if (!req.auth.isPortalAdmin) list = list.filter(x => x.isActive).map(({ id, eventId, badgeId, isActive, badge }) => ({ id, eventId, badgeId, isActive, badge }));
    res.json(list);
});
app.post('/api/events/:id/badges', (req, res) => {
    const eb = { id: newId(), eventId: req.params.id, judgeUserId: null, isActive: true, createdAt: nowIso(), updatedAt: null, ...req.body };
    F.eventBadges.push(eb);
    res.status(201).json(eb);
});
app.put('/api/events/:id/badges/:ebId', (req, res) => {
    const eb = F.eventBadges.find(x => x.id === req.params.ebId);
    if (!eb) return res.status(404).json({ error: 'Not found' });
    Object.assign(eb, req.body, { updatedAt: nowIso() });
    res.json(eb);
});
app.delete('/api/events/:id/badges/:ebId', (req, res) => {
    const i = F.eventBadges.findIndex(x => x.id === req.params.ebId);
    if (i >= 0) F.eventBadges.splice(i, 1);
    res.json({ success: true });
});

// ---------- teams ----------
app.get('/api/teams', (req, res) => {
    let teams = F.teams;
    if (req.query.eventId) teams = teams.filter(t => t.eventId === req.query.eventId);
    res.json(teams);
});
app.get('/api/teams/:id', (req, res) => {
    const t = F.teams.find(x => x.id === req.params.id);
    t ? res.json(t) : res.status(404).json({ message: 'Team not found' });
});
app.get('/api/teams/:id/members', (req, res) => {
    res.json(F.users.filter(u => u.teamId === req.params.id));
});
app.post('/api/teams', (req, res) => {
    const b = req.body || {};
    const t = { id: newId(), teamName: b.teamName || b.name || 'New team', eventId: b.eventId, numberOfParticipants: b.numberOfParticipants ?? 3, adminUserId: req.auth.userId, isSpecialTeam: false, specialTeamType: null, createdAt: nowIso(), updatedAt: null };
    F.teams.push(t);
    let p = F.participations.find(x => x.userId === req.auth.userId && x.eventId === t.eventId);
    if (!p) {
        p = { id: newId(), userId: req.auth.userId, email: req.auth.email, eventId: t.eventId, roles: [], teamId: null, isTeamAdmin: false, hotelNights: {}, profileVerification: false, createdAt: nowIso(), updatedAt: null };
        F.participations.push(p);
    }
    if (!p.roles.includes('participant')) p.roles.push('participant');
    p.teamId = t.id; p.isTeamAdmin = true;
    p.teamMemberships = [{ teamId: t.id, isAdmin: true, isParticipant: true }];
    res.status(201).json(t);
});
app.put('/api/teams/:id', (req, res) => {
    const t = F.teams.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ message: 'Team not found' });
    Object.assign(t, req.body, { id: t.id, updatedAt: nowIso() });
    res.json(t);
});
app.delete('/api/teams/:id', (req, res) => {
    const i = F.teams.findIndex(x => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ message: 'Team not found' });
    F.teams.splice(i, 1);
    F.participations.forEach(p => { if (p.teamId === req.params.id) { p.teamId = null; p.isTeamAdmin = false; p.teamMemberships = []; } });
    F.users.forEach(u => { if (u.teamId === req.params.id) u.teamId = null; });
    res.json({ success: true });
});
app.delete('/api/members/:userId', (req, res) => {
    const u = findUserById(req.params.userId);
    if (u) u.teamId = null;
    F.participations.forEach(p => { if (p.userId === req.params.userId && p.teamId === req.body?.teamId) { p.teamId = null; p.isTeamAdmin = false; p.teamMemberships = []; } });
    res.json({ success: true });
});

// ---------- participations ----------
app.get('/api/participations/all', (_req, res) => res.json(F.participations));
app.get('/api/participations/event/:eventId', (req, res) => {
    let list = F.participations.filter(p => p.eventId === req.params.eventId);
    if (req.query.role) list = list.filter(p => p.roles.includes(req.query.role));
    res.json(list);
});
app.get('/api/participations/person/:email', (req, res) => {
    const email = decodeURIComponent(req.params.email);
    res.json(F.participations.filter(p => lower(p.email) === lower(email))
        .map(p => ({ ...p, eventName: F.events.find(e => e.id === p.eventId)?.name || 'Unknown Event' })));
});
app.get('/api/participations/team/:teamId/count', (req, res) => {
    const members = F.participations.filter(p => (p.teamMemberships || []).some(m => m.teamId === req.params.teamId));
    res.json({
        teamId: req.params.teamId,
        adminCount: members.filter(p => p.teamMemberships.some(m => m.teamId === req.params.teamId && m.isAdmin)).length,
        participantCount: members.filter(p => p.teamMemberships.some(m => m.teamId === req.params.teamId && m.isParticipant)).length,
        maxParticipants: 5,
    });
});
app.get('/api/participations', (req, res) => {
    const { userId, eventId } = req.query;
    let list = F.participations.filter(p => p.userId === userId);
    if (eventId) list = list.filter(p => p.eventId === eventId);
    if (eventId) return list[0] ? res.json(list[0]) : res.status(404).json({ error: 'Not found' });
    res.json(list);
});
app.post('/api/participations', (req, res) => {
    const b = req.body || {};
    let p = F.participations.find(x => x.userId === b.userId && x.eventId === b.eventId);
    if (!p) {
        p = { id: newId(), userId: b.userId, email: findUserById(b.userId)?.email || b.email, eventId: b.eventId, roles: [], teamId: null, isTeamAdmin: false, hotelNights: {}, profileVerification: false, teamMemberships: [], createdAt: nowIso(), updatedAt: null };
        F.participations.push(p);
    }
    (b.roles || []).forEach(r => { if (!p.roles.includes(r)) p.roles.push(r); });
    if (b.hotelNights) p.hotelNights = b.hotelNights;
    p.updatedAt = nowIso();
    res.json(p);
});
app.put('/api/participations/:id/hotel', (req, res) => {
    const p = F.participations.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (req.body?.hotelNights) p.hotelNights = req.body.hotelNights;
    if (req.body?.profileVerification !== undefined) p.profileVerification = !!req.body.profileVerification;
    res.json(p);
});
app.put('/api/participations/:id/roles', (req, res) => {
    const p = F.participations.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const { add, remove, set } = req.body || {};
    if (set) p.roles = [...set];
    (add || []).forEach(r => { if (!p.roles.includes(r)) p.roles.push(r); });
    (remove || []).forEach(r => { p.roles = p.roles.filter(x => x !== r); });
    res.json(p);
});
app.put('/api/participations/:id/team', (req, res) => {
    const p = F.participations.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const { teamId, isTeamAdmin = false, isParticipant = true } = req.body || {};
    p.teamId = teamId; p.isTeamAdmin = !!isTeamAdmin;
    p.teamMemberships = teamId ? [{ teamId, isAdmin: !!isTeamAdmin, isParticipant: !!isParticipant }] : [];
    const u = findUserById(p.userId); if (u) u.teamId = teamId;
    res.json(p);
});
app.put('/api/participations/:id/team-membership/:teamId/roles', (req, res) => {
    const p = F.participations.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const m = (p.teamMemberships || []).find(x => x.teamId === req.params.teamId);
    if (m) { m.isAdmin = !!req.body?.isAdmin; m.isParticipant = !!req.body?.isParticipant; p.isTeamAdmin = m.isAdmin; }
    res.json(p);
});
app.put('/api/participations/:id', (req, res) => {
    const p = F.participations.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    Object.assign(p, req.body, { id: p.id, updatedAt: nowIso() });
    res.json(p);
});
app.delete('/api/participations/:id', (req, res) => {
    const i = F.participations.findIndex(x => x.id === req.params.id);
    if (i >= 0) F.participations.splice(i, 1);
    res.json({ success: true });
});

// ---------- badge claims ----------
app.get('/api/badge-claims', (req, res) => {
    let list = F.badgeClaims;
    for (const k of ['eventId', 'teamId', 'status', 'badgeId']) if (req.query[k]) list = list.filter(c => c[k] === req.query[k]);
    res.json(list.map(c => ({
        ...c,
        badge: F.badges.find(b => b.id === c.badgeId) || null,
        team: F.teams.find(t => t.id === c.teamId) ? { id: c.teamId, teamName: F.teams.find(t => t.id === c.teamId).teamName } : null,
    })).sort((a, b) => new Date(b.claimedAt) - new Date(a.claimedAt)));
});
app.post('/api/badge-claims', (req, res) => {
    const b = req.body || {};
    const eb = F.eventBadges.find(x => x.id === b.eventBadgeId) || F.eventBadges.find(x => x.badgeId === b.badgeId && x.eventId === b.eventId);
    const c = { id: newId(), eventBadgeId: eb?.id || null, eventId: b.eventId || eb?.eventId, badgeId: b.badgeId || eb?.badgeId, teamId: b.teamId || null, status: b.status || 'pending', blogUrl: b.blogUrl || null, evidence: b.evidence || null, assignedToUserId: null, claimedBy: req.auth.userId, claimedAt: nowIso(), declineReason: null, reviewedBy: null, reviewedAt: null };
    F.badgeClaims.push(c);
    res.status(201).json(c);
});
app.put('/api/badge-claims/assign', (req, res) => res.json({ success: true, ...req.body }));
app.post('/api/badge-claims/award', (req, res) => res.json({ success: true, ...req.body }));
app.put('/api/badge-claims/:id/review', (req, res) => {
    const c = F.badgeClaims.find(x => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    Object.assign(c, req.body, { reviewedBy: req.auth.userId, reviewedAt: nowIso() });
    res.json(c);
});
app.put('/api/badge-claims/:id', (req, res) => {
    const c = F.badgeClaims.find(x => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    Object.assign(c, req.body, { id: c.id });
    res.json(c);
});
app.delete('/api/badge-claims/:id', (req, res) => {
    const i = F.badgeClaims.findIndex(x => x.id === req.params.id);
    if (i >= 0) F.badgeClaims.splice(i, 1);
    res.json({ success: true });
});

// ---------- invitations ----------
app.get('/api/invitations', (req, res) => {
    let list = F.invitations;
    if (req.query.teamId) list = list.filter(i => i.teamId === req.query.teamId);
    if (req.query.email) list = list.filter(i => lower(i.email) === lower(req.query.email));
    res.json(list);
});
app.post('/api/invitations', (req, res) => {
    const b = req.body || {};
    const inviter = findUserById(req.auth.userId);
    const team = F.teams.find(t => t.id === b.teamId);
    const inv = { id: newId(), email: lower(b.email), inviteeFirstName: b.firstName || b.inviteeFirstName || null, inviteeLastName: b.lastName || b.inviteeLastName || null, teamId: b.teamId || null, teamName: team?.teamName || b.teamName || null, eventId: b.eventId || team?.eventId || null, role: b.role || 'participant', inviterId: req.auth.userId, inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}` : null, inviterEmail: req.auth.email, message: b.message || null, status: 'pending', createdAt: nowIso(), expiresAt: new Date(Date.now() + 14 * 864e5).toISOString(), acceptedAt: null, acceptedBy: null, cancelledAt: null };
    F.invitations.push(inv);
    res.status(201).json(inv);
});
app.post('/api/invitations/:id/accept', (req, res) => {
    const inv = F.invitations.find(x => x.id === req.params.id);
    if (!inv) return res.status(404).json({ message: 'Invitation not found' });
    inv.status = 'accepted'; inv.acceptedAt = nowIso(); inv.acceptedBy = req.auth.userId;
    res.json({ success: true, invitation: inv });
});
app.post('/api/invitations/:id/resend', (req, res) => res.json({ success: true }));
app.delete('/api/invitations/:id', (req, res) => {
    const inv = F.invitations.find(x => x.id === req.params.id);
    if (inv) { inv.status = 'cancelled'; inv.cancelledAt = nowIso(); }
    res.json({ success: true });
});

// ---------- solo queue ----------
app.get('/api/solo-queue', (req, res) => {
    let q = F.soloQueue;
    if (req.query.eventId) q = q.filter(x => x.eventId === req.query.eventId);
    if (req.query.userId) q = q.filter(x => x.userId === req.query.userId);
    if (!req.auth.isPortalAdmin) return res.json({ entries: q.filter(x => x.userId === req.auth.userId), totalCount: q.length });
    res.json(q);
});
app.post('/api/solo-queue', (req, res) => {
    const e = { id: newId(), userId: req.body?.userId || req.auth.userId, eventId: req.body?.eventId, note: req.body?.note || null, status: 'waiting', joinedAt: nowIso() };
    F.soloQueue.push(e);
    res.status(201).json(e);
});
app.get('/api/solo-queue/position/:eventId/:userId', (req, res) => {
    const q = F.soloQueue.filter(x => x.eventId === req.params.eventId && x.status === 'waiting').sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));
    const i = q.findIndex(x => x.userId === req.params.userId);
    res.json(i < 0 ? { inQueue: false } : { inQueue: true, position: i + 1, totalCount: q.length });
});
app.delete('/api/solo-queue/:id', (req, res) => {
    const i = F.soloQueue.findIndex(x => x.id === req.params.id);
    if (i >= 0) F.soloQueue.splice(i, 1);
    res.json({ success: true });
});

// ---------- email / campaigns / sequences: empty but valid ----------
app.get('/api/email/templates', (_req, res) => res.json([]));
app.get('/api/email/history', (_req, res) => res.json([]));
app.get('/api/email/campaigns', (_req, res) => res.json([]));
app.get('/api/sequences', (_req, res) => res.json([]));
app.get('/api/deliveries/event/:id', (_req, res) => res.json([]));
app.post('/api/email/preview', (req, res) => res.json({ subject: 'Preview', html: '<p>Mock preview</p>' }));

// ---------- fallback: never crash a page ----------
app.use('/api', (req, res) => {
    console.warn(`   (unmocked) ${req.method} /api${req.url} -> generic response`);
    if (req.method === 'GET') return res.json([]);
    res.json({ success: true });
});

// ---------- dev login page (lives only in this server, never deployed) ----------
app.get('/dev-login', (_req, res) => {
    const cards = F.users.map(u => `
        <button data-id="${u.id}">
            <strong>${u.firstName} ${u.lastName}</strong>
            <span>${u.email}</span>
            <em>${u.isPortalAdmin ? 'Portal admin' : F.participations.filter(p => p.userId === u.id).flatMap(p => p.roles).join(', ') || 'no roles'}</em>
        </button>`).join('');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Dev login</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}
 h1{font-size:1.4rem} p{color:#555}
 button{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:12px 16px;margin:8px 0;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;font:inherit}
 button:hover{border-color:#333;background:#f6f6f6} button span{color:#666;font-size:.9rem} button em{color:#888;font-size:.8rem}
 .out{margin-top:16px;padding:8px 12px;border-left:3px solid #999;background:#f6f6f6}
</style>
<h1>ACDC Portal, local mock login</h1>
<p>Pick a user. A fake session is written to localStorage and you are sent to the events page. Log out from the site header as usual.</p>
${cards}
<p class="out">Or use the real <a href="/register.html">login page</a> with any email above and code <code>${MOCK_OTP}</code>.</p>
<script>
 const users = ${JSON.stringify(F.users.map(u => ({ id: u.id, email: u.email })))};
 document.querySelectorAll('button').forEach(b => b.onclick = async () => {
   const u = users.find(x => x.id === b.dataset.id);
   const r = await fetch('/api/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, code: '${MOCK_OTP}' }) });
   const d = await r.json();
   localStorage.setItem('acdc_token', d.token);
   localStorage.setItem('acdc_user', JSON.stringify(d.user));
   location.href = '/events.html';
 });
</script>`);
});

// ---------- static site (mirrors staticwebapp.config.json fallback) ----------
app.use(express.static(SRC_DIR, { extensions: ['html'] }));
app.use((req, res) => {
    if (req.path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(req.path)) return res.status(404).send('Not found');
    res.sendFile(path.join(SRC_DIR, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\nACDC Portal mock dev server`);
    console.log(`  site:   http://localhost:${PORT}`);
    console.log(`  login:  http://localhost:${PORT}/dev-login   (or OTP code ${MOCK_OTP} on the real login page)`);
    console.log(`  data:   dev/mock-api/fixtures.js (in memory, resets on restart)\n`);
});
