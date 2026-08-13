const assert = require('node:assert/strict');
const { getTokenFromRequest } = require('../api/src/shared/auth');

assert.equal(
    getTokenFromRequest({ headers: new Headers({ 'x-acdc-token': 'app-jwt' }) }),
    'app-jwt',
    'server must accept the single app token header'
);

assert.equal(
    getTokenFromRequest({ headers: new Headers({ Authorization: 'Bearer rewritten-token' }) }),
    null,
    'server must not use an Authorization fallback'
);

console.log('PASS: Server accepts only x-acdc-token with no fallback');