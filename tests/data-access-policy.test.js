// Pins object-level access rules: authenticated users must not read other
// people's data. Invokes handlers with a real JWT against in-memory storage.
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.JWT_SECRET = 'data-access-policy-test-secret';

const API_DIR = path.join(__dirname, '..', 'api');
const SHARED_DIR = path.join(API_DIR, 'src', 'shared');
const FUNCTIONS_DIR = path.join(API_DIR, 'src', 'functions');

const DATA = {
    participations: [
        {
            id: 'p-self', userId: 'user-1', email: 'self@example.com', eventId: 'event-1',
            teamId: 'team-1', isTeamAdmin: true, roles: ['participant'],
            teamMemberships: [{ teamId: 'team-1', isAdmin: true, isParticipant: true }],
            hotelNights: { 'wed-thu': true }
        },
        {
            id: 'p-teammate', userId: 'user-2', email: 'teammate@example.com', eventId: 'event-1',
            teamId: 'team-1', isTeamAdmin: false, roles: ['participant'],
            teamMemberships: [{ teamId: 'team-1', isAdmin: false, isParticipant: true }],
            hotelNights: { 'thu-sun': true }
        },
        {
            id: 'p-stranger', userId: 'user-3', email: 'stranger@example.com', eventId: 'event-1',
            teamId: 'team-2', isTeamAdmin: false, roles: ['participant'],
            teamMemberships: [{ teamId: 'team-2', isAdmin: false, isParticipant: true }],
            hotelNights: { 'sun-mon': true }
        }
    ],
    events: [{ id: 'event-1', name: 'Test Event', status: 'live' }],
    users: [],
    'solo-queue': [
        { id: 'q1', userId: 'user-1', eventId: 'event-1', status: 'waiting', joinedAt: '2026-01-01' },
        { id: 'q2', userId: 'user-3', eventId: 'event-1', status: 'waiting', joinedAt: '2026-01-02' }
    ]
};

function store(collection) {
    const rows = () => DATA[collection] || [];
    return {
        getAll: async () => JSON.parse(JSON.stringify(rows())),
        getById: async (id) => JSON.parse(JSON.stringify(rows().find(r => r.id === id) || null)),
        getByEmail: async (email) => JSON.parse(JSON.stringify(rows().find(r => r.email === email) || null)),
        create: async (row) => row,
        update: async (_id, updates) => updates,
        delete: async () => {}
    };
}

function mockModule(request, exportsObject) {
    const resolved = require.resolve(request, { paths: [FUNCTIONS_DIR] });
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

const registrations = [];
mockModule('@azure/functions', {
    app: {
        http: (name, options) => registrations.push({ name, ...options }),
        timer: () => {},
        hook: { preInvocation: () => {} }
    }
});
mockModule(path.join(SHARED_DIR, 'storage.js'), new Proxy({}, {
    get: (_t, prop) => {
        if (prop === 'Storage') return function MockStorage(collection) { return store(collection); };
        if (prop === 'readData' || prop === 'writeData') return async () => ({});
        if (prop === 'then') return undefined;
        return store(String(prop));
    }
}));
mockModule(path.join(SHARED_DIR, 'sql.js'), { getPool: async () => { throw new Error('no sql in test'); }, closePool: async () => {}, sql: {} });
mockModule(path.join(SHARED_DIR, 'error-log.js'), { logError: async () => {} });
mockModule(path.join(SHARED_DIR, 'keyvault.js'), { loadSecrets: async () => true });
mockModule(path.join(SHARED_DIR, 'mail.js'), { sendEmail: async () => ({}), processTemplate: t => t, extractInlineImages: html => ({ html, attachments: [] }) });
mockModule(path.join(SHARED_DIR, 'event-financials.js'), new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : async () => ({}))
}));

require(path.join(FUNCTIONS_DIR, 'participations.js'));
require(path.join(FUNCTIONS_DIR, 'solo-queue.js'));

const jwt = require(path.join(API_DIR, 'node_modules', 'jsonwebtoken'));
function tokenFor(user) {
    return jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '5m', issuer: 'acdc-portal' });
}
const SELF = { email: 'self@example.com', userId: 'user-1', isPortalAdmin: false };
const ADMIN = { email: 'admin@example.com', userId: 'admin-1', isPortalAdmin: true };

function request(user, { params = {}, query = '' } = {}) {
    return {
        method: 'GET',
        url: 'http://localhost/api/test',
        headers: new Headers({ 'x-acdc-token': tokenFor(user) }),
        params,
        query: new URLSearchParams(query),
        json: async () => ({})
    };
}
const noop = () => {};
const ctx = () => ({ log: Object.assign(noop, { error: noop, warn: noop }), warn: noop, error: noop });

function endpoint(name) {
    const found = registrations.find(r => r.name === name);
    assert.ok(found, `endpoint ${name} must be registered`);
    return found.handler;
}

(async () => {
    // by-person: strangers' data is admin-only.
    const byPerson = endpoint('participations-by-person');
    let res = await byPerson(request(SELF, { params: { email: 'stranger%40example.com' } }), ctx());
    assert.equal(res.status, 403, 'non-admin must not read another person\'s participations');
    res = await byPerson(request(SELF, { params: { email: 'self%40example.com' } }), ctx());
    assert.equal(res.status, 200, 'self lookup must work');
    res = await byPerson(request(ADMIN, { params: { email: 'stranger%40example.com' } }), ctx());
    assert.equal(res.status, 200, 'admin lookup must work');

    // by-event: non-staff callers get projected rows without emails; hotel data only for shared teams.
    const byEvent = endpoint('participations-by-event');
    res = await byEvent(request(SELF, { params: { eventId: 'event-1' } }), ctx());
    assert.equal(res.status, 200);
    const rows = res.jsonBody;
    assert.ok(rows.every(r => r.email === undefined), 'participant view must not expose emails');
    const teammate = rows.find(r => r.id === 'p-teammate');
    const stranger = rows.find(r => r.id === 'p-stranger');
    assert.ok(teammate.hotelNights, 'same-team hotel data stays available for team management');
    assert.equal(stranger.hotelNights, undefined, 'other teams\' hotel data must be hidden');
    res = await byEvent(request(ADMIN, { params: { eventId: 'event-1' } }), ctx());
    assert.ok(res.jsonBody.every(r => r.email !== undefined), 'admin keeps full records');

    // solo-queue position: own position only.
    const position = endpoint('solo-queue-position');
    res = await position(request(SELF, { params: { eventId: 'event-1', userId: 'user-3' } }), ctx());
    assert.equal(res.status, 403, 'non-admin must not read another user\'s queue position');
    res = await position(request(SELF, { params: { eventId: 'event-1', userId: 'user-1' } }), ctx());
    assert.equal(res.status, 200, 'own position must work');

    const upsert = endpoint('participations-upsert');
    res = await upsert({
        ...request(SELF),
        method: 'POST',
        json: async () => ({ userId: 'user-1', email: 'other@example.com', eventId: 'event-1', roles: ['judge'] })
    }, ctx());
    assert.equal(res.status, 403, 'non-admin must not self-assign privileged roles');

    const update = endpoint('participations-update');
    res = await update({
        ...request(SELF, { params: { id: 'p-self' } }),
        method: 'PUT',
        json: async () => ({ isTeamAdmin: true, userId: 'user-3', teamId: 'team-2' })
    }, ctx());
    assert.equal(res.status, 403, 'non-admin must not change identity or admin status');

    const assignTeam = endpoint('participations-assign-team');
    res = await assignTeam({
        ...request(SELF, { params: { id: 'p-self' } }),
        method: 'PUT',
        json: async () => ({ teamId: 'team-2', isTeamAdmin: true })
    }, ctx());
    assert.equal(res.status, 403, 'non-admin must not assign across teams or grant admin status');

    // by-team endpoint was removed as uncalled surface; ensure it stays gone.
    assert.ok(!registrations.some(r => r.name === 'participations-by-team'), 'participations-by-team must stay removed');

    console.log('PASS: Object-level access rules hide other users\' data from non-admins');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
