// TEMPORARY diagnostic endpoint — used to investigate intermittent JWT verification
// failures across scaled-out Function App instances. Reveals NO secret values,
// only lengths/hashes/hostname so we can compare consistency across instances.
// DELETE THIS FILE once the investigation is complete.
const { app } = require('@azure/functions');
const crypto = require('crypto');
const os = require('os');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../shared/auth');

function fingerprint(value) {
    if (!value) return null;
    const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
    return { length: value.length, hash };
}

app.http('diag-secret-status', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'diag/secret-status',
    handler: async (request, context) => {
        const expectedSecret = process.env.SCHEDULER_SECRET;
        const provided = request.headers.get('x-scheduler-secret');
        if (!expectedSecret || !provided || provided !== expectedSecret) {
            return { status: 401, jsonBody: { error: 'Unauthorized' } };
        }

        const url = new URL(request.url);
        const tokenToCheck = url.searchParams.get('token');

        const result = {
            hostname: os.hostname(),
            keyVaultUrlSet: !!process.env.KEY_VAULT_URL,
            jwtSecret: fingerprint(process.env.JWT_SECRET),
            now: new Date().toISOString()
        };

        // Self-test: sign + verify a throwaway token using the exact same
        // functions production code uses, all within this one instance.
        try {
            const selfToken = jwt.sign({ test: true }, getJwtSecret(), { expiresIn: '1m', issuer: 'acdc-portal' });
            const verified = jwt.verify(selfToken, getJwtSecret(), { issuer: 'acdc-portal' });
            result.selfTest = { signed: true, verified: !!verified };
            if (url.searchParams.get('includeTestToken') === '1') {
                result.testToken = selfToken;
            }
        } catch (e) {
            result.selfTest = { error: e.message };
        }

        // If the caller supplied a real user token, analyze exactly why it
        // does or doesn't verify, without ever echoing the secret itself.
        if (tokenToCheck) {
            const decoded = jwt.decode(tokenToCheck, { complete: true });
            result.suppliedToken = {
                decodedHeader: decoded?.header || null,
                decodedPayload: decoded ? {
                    email: decoded.payload.email,
                    iss: decoded.payload.iss,
                    iat: decoded.payload.iat,
                    exp: decoded.payload.exp,
                    expIso: decoded.payload.exp ? new Date(decoded.payload.exp * 1000).toISOString() : null,
                    nowIso: new Date().toISOString(),
                    isExpiredByClock: decoded.payload.exp ? (decoded.payload.exp * 1000 < Date.now()) : null
                } : null
            };
            try {
                jwt.verify(tokenToCheck, getJwtSecret(), { issuer: 'acdc-portal' });
                result.suppliedToken.verifyResult = 'OK';
            } catch (e) {
                result.suppliedToken.verifyResult = 'FAILED';
                result.suppliedToken.verifyError = e.name + ': ' + e.message;
            }
        }

        return {
            status: 200,
            jsonBody: result
        };
    }
});
