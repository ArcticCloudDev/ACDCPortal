const assert = require('node:assert/strict');

const previousSecret = process.env.JWT_SECRET;
const previousKeyVaultUrl = process.env.KEY_VAULT_URL;

try {
    delete process.env.JWT_SECRET;
    delete process.env.KEY_VAULT_URL;

    const { getJwtSecret } = require('../api/src/shared/auth');
    assert.throws(
        () => getJwtSecret(),
        /ServerAuthConfigError: JWT secret unavailable/,
        'authentication must fail closed when JWT_SECRET is missing'
    );

    console.log('PASS: Auth fails closed without a configured JWT secret');
} finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousKeyVaultUrl === undefined) delete process.env.KEY_VAULT_URL;
    else process.env.KEY_VAULT_URL = previousKeyVaultUrl;
}
