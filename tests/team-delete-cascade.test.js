const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('../api/node_modules/jsonwebtoken');

process.env.JWT_SECRET = 'team-delete-test-secret';

const functionsDir = path.join(__dirname, '..', 'api', 'src', 'functions');
const sharedDir = path.join(__dirname, '..', 'api', 'src', 'shared');
const data = {
    teams: [{ id: 'team-1', teamName: 'Test Team', eventId: 'event-1', adminUserId: 'user-1' }],
    participations: [{ id: 'p-1', userId: 'user-1', email: 'admin@example.com', eventId: 'event-1', teamId: 'team-1', isTeamAdmin: true, roles: [], hotelNights: { 'thu-sun': true }, teamMemberships: [] }],
    users: [{ id: 'user-1', email: 'admin@example.com', teamId: 'team-1' }],
    invitations: [{ id: 'i-1', teamId: 'team-1' }],
    'badge-claims': [{ id: 'c-1', teamId: 'team-1' }],
    'email-deliveries': [{ id: 'd-1', email: 'admin@example.com' }]
};
const deleted = {};
const folderDeletes = [];

function store(name) {
    return {
        getAll: async () => [...(data[name] || [])],
        getById: async id => (data[name] || []).find(row => row.id === id) || null,
        update: async (id, updates) => {
            const row = (data[name] || []).find(item => item.id === id);
            if (row) Object.assign(row, updates);
            return row;
        },
        delete: async id => {
            deleted[name] = [...(deleted[name] || []), id];
            data[name] = (data[name] || []).filter(row => row.id !== id);
            return true;
        },
        create: async row => row
    };
}

function mock(request, exportsObject) {
    const resolved = require.resolve(request, { paths: [functionsDir] });
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

const registrations = [];
const storage = new Proxy({}, {
    get: (_target, prop) => {
        if (prop === 'Storage') return function MockStorage(name) { return store(name); };
        if (prop === 'then') return undefined;
        return store(String(prop));
    }
});
mock('@azure/functions', { app: { http: (name, options) => registrations.push({ name, ...options }) } });
mock(path.join(sharedDir, 'storage.js'), storage);
mock(path.join(sharedDir, 'sharepoint.js'), { isConfigured: () => true, deleteFolder: async folder => folderDeletes.push(folder) });
mock(path.join(sharedDir, 'welcome-email.js'), { sendWelcomeEmail: async () => {} });
mock(path.join(sharedDir, 'error-log.js'), { logError: async () => {} });

require(path.join(functionsDir, 'teams.js'));
const endpoint = registrations.find(item => item.name === 'teams-delete');
assert.ok(endpoint, 'team delete endpoint must be registered');

const token = jwt.sign({ userId: 'user-1', email: 'admin@example.com', isPortalAdmin: true }, process.env.JWT_SECRET, { issuer: 'acdc-portal' });
const request = {
    method: 'DELETE',
    params: { id: 'team-1' },
    headers: new Headers({ 'x-acdc-token': token }),
    query: new URLSearchParams(),
    json: async () => ({})
};
const noop = () => {};
const context = { log: Object.assign(noop, { error: noop, warn: noop }), error: noop, warn: noop };

(async () => {
    const response = await endpoint.handler(request, context);
    assert.equal(response.status, 200);
    assert.deepEqual(folderDeletes, ['Events/event-1/team-1']);
    assert.deepEqual(deleted.teams, ['team-1']);
    assert.deepEqual(deleted.invitations, ['i-1']);
    assert.deepEqual(deleted['badge-claims'], ['c-1']);
    assert.deepEqual(deleted['email-deliveries'], ['d-1']);
    assert.equal(data.participations[0].teamId, null);
    assert.equal(data.participations[0].isTeamAdmin, false);
    assert.equal(data.users[0].teamId, null);
    assert.equal(data.users[0].id, 'user-1', 'deleting a team must not delete the user account');
    console.log('PASS: Team deletion cleans external and team-scoped resources without deleting the user account');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
