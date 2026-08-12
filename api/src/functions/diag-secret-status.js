// TEMPORARY diagnostic endpoint — used to investigate intermittent JWT verification
// failures across scaled-out Function App instances. Reveals NO secret values,
// only lengths/hashes/hostname so we can compare consistency across instances.
// DELETE THIS FILE once the investigation is complete.
const { app } = require('@azure/functions');
const crypto = require('crypto');
const os = require('os');

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

        return {
            status: 200,
            jsonBody: {
                hostname: os.hostname(),
                keyVaultUrlSet: !!process.env.KEY_VAULT_URL,
                jwtSecret: fingerprint(process.env.JWT_SECRET),
                now: new Date().toISOString()
            }
        };
    }
});
