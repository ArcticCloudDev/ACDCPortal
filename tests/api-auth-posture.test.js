// Loads every Azure Function with mocked infrastructure and proves each HTTP
// endpoint rejects unauthenticated requests, except a pinned public allowlist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_DIR = path.join(__dirname, '..', 'api');
const FUNCTIONS_DIR = path.join(API_DIR, 'src', 'functions');
const SHARED_DIR = path.join(API_DIR, 'src', 'shared');

// Endpoints that intentionally serve unauthenticated requests.
const PUBLIC_ENDPOINTS = new Set([
    'auth-check-email',
    'auth-send-otp',
    'auth-verify-otp',
    'register-start',
    'register-complete',
    'invitations-get',
    'invitations-accept',
    'interest-record',
    'events-list',
    'events-active',
    'events-get',
    'badges-list',
    'badges-get'
]);

// Guarded by x-scheduler-secret instead of a user JWT; fails closed (503) when unset.
const SECRET_GUARDED = new Map([['scheduled-emails-run', 503]]);

function mockModule(request, exportsObject) {
    const resolved = require.resolve(request, { paths: [FUNCTIONS_DIR] });
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: exportsObject
    };
}

function throwingStore(label) {
    return new Proxy({}, {
        get: (_t, prop) => {
            if (prop === 'then') return undefined;
            return () => { throw new Error(`${label}.${String(prop)} reached without authentication`); };
        }
    });
}

// --- Mock infrastructure before loading any function file ---
const registrations = [];
mockModule('@azure/functions', {
    app: {
        http: (name, options) => registrations.push({ name, ...options }),
        timer: (name, options) => registrations.push({ name, ...options, timer: true }),
        hook: { preInvocation: () => {}, postInvocation: () => {} }
    }
});

const storageMock = new Proxy({}, {
    get: (_t, prop) => {
        if (prop === 'Storage') {
            return function MockStorage(collection) { return throwingStore(`storage(${collection})`); };
        }
        if (prop === 'readData' || prop === 'writeData') {
            return () => { throw new Error(`storage.${String(prop)} reached without authentication`); };
        }
        if (prop === 'then') return undefined;
        return throwingStore(`storage.${String(prop)}`);
    }
});
mockModule(path.join(SHARED_DIR, 'storage.js'), storageMock);
mockModule(path.join(SHARED_DIR, 'sql.js'), {
    getPool: () => { throw new Error('sql pool reached without authentication'); },
    closePool: async () => {},
    sql: {}
});
mockModule(path.join(SHARED_DIR, 'error-log.js'), { logError: async () => {} });
mockModule(path.join(SHARED_DIR, 'keyvault.js'), { loadSecrets: async () => true });
mockModule(path.join(SHARED_DIR, 'mail.js'), {
    sendEmail: async () => { throw new Error('mail reached without authentication'); },
    processTemplate: (template) => template,
    extractInlineImages: (html) => ({ html, attachments: [] })
});
mockModule(path.join(SHARED_DIR, 'sharepoint.js'), new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : () => { throw new Error('sharepoint reached without authentication'); })
}));

for (const file of fs.readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.js'))) {
    require(path.join(FUNCTIONS_DIR, file));
}

const httpEndpoints = registrations.filter(r => !r.timer);
assert.ok(httpEndpoints.length >= 100, `expected the full endpoint surface, found ${httpEndpoints.length}`);

function fakeRequest(method, route) {
    return {
        method,
        url: `http://localhost/api/${route}`,
        headers: new Headers(),
        params: {},
        query: new URLSearchParams(),
        json: async () => ({}),
        text: async () => ''
    };
}

const noop = () => {};
function fakeContext() {
    return { log: Object.assign(noop, { error: noop, warn: noop }), warn: noop, error: noop };
}

(async () => {
    const failures = [];
    for (const endpoint of httpEndpoints) {
        if (PUBLIC_ENDPOINTS.has(endpoint.name)) continue;

        const expected = SECRET_GUARDED.get(endpoint.name) ?? 401;
        let response;
        try {
            response = await endpoint.handler(fakeRequest(endpoint.methods[0], endpoint.route), fakeContext());
        } catch (error) {
            failures.push(`${endpoint.name}: handler threw before rejecting (${error.message})`);
            continue;
        }
        if (!response || response.status !== expected) {
            failures.push(`${endpoint.name}: expected ${expected} for unauthenticated request, got ${response?.status}`);
        }
    }

    for (const name of PUBLIC_ENDPOINTS) {
        if (!httpEndpoints.some(e => e.name === name)) {
            failures.push(`allowlist entry '${name}' is not a registered endpoint (stale allowlist)`);
        }
    }

    assert.deepEqual(failures, [], `authorization posture violations:\n${failures.join('\n')}`);
    console.log(`PASS: All ${httpEndpoints.length} endpoints reject unauthenticated requests except the ${PUBLIC_ENDPOINTS.size} pinned public routes`);
})().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
