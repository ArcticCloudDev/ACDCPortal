// SQL Connection Pool Management
// Uses Entra ID (DefaultAzureCredential) for authentication.
// Token auto-refreshes before expiry.

const sql = require('mssql');
const { DefaultAzureCredential } = require('@azure/identity');

const DB_SERVER = 'acdc-portal-db.database.windows.net';
const DB_NAME = 'acdc-portal-db';

let _pool = null;
let _tokenExpiresAt = 0;

async function getPool() {
    const now = Date.now();
    // Refresh if token expires within 5 minutes
    if (_pool && now < _tokenExpiresAt - 300000) {
        return _pool;
    }

    if (_pool) {
        try { await _pool.close(); } catch (e) { /* ignore */ }
        _pool = null;
    }

    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://database.windows.net/.default');
    _tokenExpiresAt = tokenResponse.expiresOnTimestamp;

    _pool = await sql.connect({
        server: DB_SERVER,
        database: DB_NAME,
        connectionTimeout: 30000,
        requestTimeout: 30000,
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
        options: { encrypt: true, trustServerCertificate: false },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: { token: tokenResponse.token }
        }
    });

    // Run pending schema migrations on first connection
    await runMigrations(_pool);

    return _pool;
}

// Self-healing schema migrations — safe to run repeatedly (idempotent checks first)
async function runMigrations(pool) {
    try {
        // Migration: rename Participations.HotelAcknowledged -> ProfileVerification
        const col = await pool.request().query(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Participations' AND COLUMN_NAME='HotelAcknowledged'"
        );
        if (col.recordset.length > 0) {
            await pool.request().query("EXEC sp_rename 'Participations.HotelAcknowledged', 'ProfileVerification', 'COLUMN'");
            console.log('[sql] Migration applied: HotelAcknowledged -> ProfileVerification');
        }
    } catch (e) {
        // Migrations must never crash the app
        console.error('[sql] Migration warning:', e.message);
    }
}

async function closePool() {
    if (_pool) {
        try { await _pool.close(); } catch (e) { /* ignore */ }
        _pool = null;
    }
}

module.exports = { getPool, closePool, sql };
