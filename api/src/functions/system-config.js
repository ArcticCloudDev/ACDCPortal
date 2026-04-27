const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { getPool, sql } = require('../shared/sql');

const SUPPORTED_CURRENCIES = ['NOK', 'USD', 'EUR', 'GBP', 'SEK', 'DKK'];

// Map currency code → default locale for number formatting
const CURRENCY_LOCALES = {
    NOK: 'nb-NO',
    SEK: 'sv-SE',
    DKK: 'da-DK',
    USD: 'en-US',
    EUR: 'de-DE',
    GBP: 'en-GB',
};

async function getSettings(pool) {
    const result = await pool.request()
        .query(`SELECT Currency, Locale FROM SystemSettings WHERE Id = 1`);
    if (result.recordset.length === 0) {
        return { currency: 'NOK', locale: 'nb-NO' };
    }
    const row = result.recordset[0];
    return { currency: row.Currency, locale: row.Locale };
}

// GET /api/system/config — public, no auth needed (it's just display config)
app.http('system-config-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'system/config',
    handler: async (request, context) => {
        try {
            const pool = await getPool();
            const settings = await getSettings(pool);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            };
        } catch (err) {
            await logError(context, err, { endpoint: 'GET /system/config' });
            return { status: 500, body: JSON.stringify({ error: 'Failed to load system config' }) };
        }
    },
});

// PUT /api/system/config — admin only (enforced by client-side permissions)
app.http('system-config-put', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'system/config',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const currency = (body.currency || '').toUpperCase().trim();
            if (!SUPPORTED_CURRENCIES.includes(currency)) {
                return {
                    status: 400,
                    body: JSON.stringify({ error: `Unsupported currency. Supported: ${SUPPORTED_CURRENCIES.join(', ')}` }),
                };
            }

            // Derive locale from currency unless explicitly provided
            const locale = body.locale && body.locale.trim()
                ? body.locale.trim()
                : (CURRENCY_LOCALES[currency] || 'en-US');

            const pool = await getPool();
            await pool.request()
                .input('currency', sql.NVarChar(10), currency)
                .input('locale', sql.NVarChar(20), locale)
                .query(`UPDATE SystemSettings SET Currency = @currency, Locale = @locale, UpdatedAt = SYSUTCDATETIME() WHERE Id = 1`);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currency, locale }),
            };
        } catch (err) {
            await logError(context, err, { endpoint: 'PUT /system/config' });
            return { status: 500, body: JSON.stringify({ error: 'Failed to update system config' }) };
        }
    },
});
