// Local SQL Server used by the E2E harness. Never points anywhere but localhost.
const fs = require('node:fs');
const path = require('node:path');
const sql = require('../../../api/node_modules/mssql');

const ROOT = path.join(__dirname, '..', '..', '..');

const DB_CONFIG = {
    server: process.env.E2E_SQL_HOST || '127.0.0.1',
    port: Number(process.env.E2E_SQL_PORT || 14333),
    user: 'sa',
    password: process.env.E2E_SQL_PASSWORD || 'E2e_LocalOnly_Pw!2026',
    database: process.env.E2E_SQL_DATABASE || 'acdc_e2e',
    options: { encrypt: false, trustServerCertificate: true },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 30000
};

if (!['127.0.0.1', 'localhost'].includes(DB_CONFIG.server)) {
    throw new Error(`E2E harness refuses non-local SQL host: ${DB_CONFIG.server}`);
}

// Child tables first so DELETEs never trip foreign keys.
const TABLES_IN_DELETE_ORDER = [
    'ScheduledRunCampaigns', 'ScheduledRuns', 'EmailDeliveries', 'EmailLog', 'EmailCampaigns',
    'BadgeClaims', 'EventBadges', 'Badges', 'EventFinancials', 'EventSponsors',
    'Invitations', 'Participations', 'InterestLeads', 'InterestQueue', 'SoloQueue',
    'PendingRegistrations', 'AllowedEmails', 'Teams', 'Users',
    'EventHotelDates', 'EventDefaultNights', 'Events', 'Sequences',
    'SystemEmailConfig', 'Errors'
];

let _pool = null;

async function getPool() {
    if (_pool) return _pool;
    _pool = await new sql.ConnectionPool(DB_CONFIG).connect();
    return _pool;
}

async function closePool() {
    if (_pool) {
        try { await _pool.close(); } catch { /* already closed */ }
        _pool = null;
    }
}

const CONTAINER = process.env.E2E_SQL_CONTAINER || 'acdc-e2e-sql';
const IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';

// Starts (or creates) the throwaway SQL Server container unless E2E_SQL_EXTERNAL=1.
function ensureContainer() {
    if (process.env.E2E_SQL_EXTERNAL === '1') return;
    const { execFileSync } = require('node:child_process');
    const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let state;
    try {
        state = docker('inspect', '-f', '{{.State.Running}}', CONTAINER);
    } catch {
        state = 'missing';
    }
    if (state === 'true') return;
    if (state === 'false') {
        docker('start', CONTAINER);
        return;
    }
    docker('run', '-d', '--name', CONTAINER,
        '-e', 'ACCEPT_EULA=Y', '-e', `MSSQL_SA_PASSWORD=${DB_CONFIG.password}`, '-e', 'MSSQL_PID=Developer',
        '-p', `127.0.0.1:${DB_CONFIG.port}:1433`, IMAGE);
}

async function connectMaster(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            return await new sql.ConnectionPool({ ...DB_CONFIG, database: 'master' }).connect();
        } catch (error) {
            if (Date.now() > deadline) throw new Error(`SQL Server not reachable on ${DB_CONFIG.server}:${DB_CONFIG.port}: ${error.message}`);
            await new Promise(r => setTimeout(r, 1500));
        }
    }
}

async function ensureDatabase() {
    ensureContainer();
    const master = await connectMaster();
    try {
        await master.request()
            .input('name', DB_CONFIG.database)
            .query(`IF DB_ID(@name) IS NULL EXEC('CREATE DATABASE [${DB_CONFIG.database}]')`);
    } finally {
        await master.close();
    }

    const pool = await getPool();
    // The repo schema first, then the columns the code uses that the repo schema lacks.
    for (const file of [path.join(ROOT, 'scripts', 'create-tables.sql'), path.join(__dirname, 'schema-drift.sql')]) {
        const script = fs.readFileSync(file, 'utf8');
        for (const batch of script.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean)) {
            await pool.request().batch(batch);
        }
    }
}

async function truncateAll() {
    const pool = await getPool();
    await pool.request().batch(
        'UPDATE [Events] SET CommitteeTeamId = NULL, JudgesTeamId = NULL;\n' +
        TABLES_IN_DELETE_ORDER.map(t => `DELETE FROM [${t}];`).join('\n')
    );
}

module.exports = { sql, DB_CONFIG, getPool, closePool, ensureDatabase, truncateAll, TABLES_IN_DELETE_ORDER };
