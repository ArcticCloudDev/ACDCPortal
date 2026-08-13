const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const store = new Map();
let capturedRequest = null;
const localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
};

const window = {
    fetch: async (input, init) => {
        capturedRequest = { input, init };
        return { status: 200 };
    },
    location: {},
    __acdcFetchPatched: false
};

const context = {
    console,
    localStorage,
    window,
    Headers,
    atob,
    CONFIG: {
        auth: {
            tokenKey: 'token',
            userKey: 'user'
        }
    }
};

vm.createContext(context);
const authSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'auth.js'),
    'utf8'
);
vm.runInContext(`${authSource}\nglobalThis.testAuth = Auth;`, context);

function makeToken(exp) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        email: 'user@example.com',
        exp
    })).toString('base64url');

    return `${header}.${payload}.signature`;
}

const now = Math.floor(Date.now() / 1000);

context.testAuth.setSession(makeToken(now + 3600), { email: 'user@example.com' });
assert.equal(context.testAuth.isLoggedIn(), true, 'fresh JWT must remain logged in');
assert.equal(context.testAuth.getUser().email, 'user@example.com');

context.testAuth.setSession(makeToken(now - 3600), { email: 'user@example.com' });
assert.equal(context.testAuth.isLoggedIn(), false, 'expired JWT must be rejected');

context.testAuth.setSession('malformed', { email: 'user@example.com' });
assert.equal(context.testAuth.isLoggedIn(), false, 'malformed JWT must be rejected');

context.testAuth.setSession(makeToken(now + 3600), { email: 'user@example.com' });
context.testAuth.init();

(async () => {
    await context.window.fetch('/api/users', {
        headers: { Authorization: 'Bearer duplicate-must-be-removed' }
    });

    const headers = capturedRequest.init.headers;
    assert.equal(headers.get('x-acdc-token'), context.testAuth.getToken());
    assert.equal(headers.has('Authorization'), false, 'Authorization must not be duplicated');

    console.log('PASS: Auth retains valid JWTs and sends exactly one Azure-safe token header');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
