const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'src', 'functions', 'register.js'),
    'utf8'
);

assert.match(source, /const \{ requireAuth \} = require\('\.\.\/shared\/auth'\)/);
assert.match(source, /const auth = requireAuth\(request, context\)/);
assert.match(source, /auth\.user\.email\?\.toLowerCase\(\) !== normalizedEmail/);
assert.match(source, /status: 403/);

console.log('PASS: Registration completion requires an OTP-issued session for the same email');