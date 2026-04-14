// Run SQL migration scripts against Azure SQL using Entra ID auth
const sql = require('../api/node_modules/mssql');
const { DefaultAzureCredential } = require('../api/node_modules/@azure/identity');
const fs = require('fs');
const path = require('path');

async function run() {
    const scriptName = process.argv[2];
    if (!scriptName) {
        console.error('Usage: node run-migration.js <script.sql>');
        process.exit(1);
    }

    const scriptPath = path.join(__dirname, scriptName);
    if (!fs.existsSync(scriptPath)) {
        console.error(`File not found: ${scriptPath}`);
        process.exit(1);
    }

    console.log(`Running migration: ${scriptName}`);
    console.log('Getting Azure AD token...');
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://database.windows.net/.default');

    console.log('Connecting to Azure SQL (may take ~60s if auto-paused)...');
    const pool = await sql.connect({
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        options: { encrypt: true, trustServerCertificate: false },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: { token: tokenResponse.token }
        },
        connectionTimeout: 120000,
        requestTimeout: 120000
    });
    console.log('Connected!\n');

    const sqlFile = fs.readFileSync(scriptPath, 'utf8');
    // Split on GO statements, falling back to semicolons for ALTER TABLE
    const statements = sqlFile
        .split(/;\s*\n/)
        .map(s => s.replace(/^\s*--.*$/gm, '').trim())
        .filter(s => s.length > 0);

    let ok = 0, skipped = 0, failed = 0;
    for (const stmt of statements) {
        try {
            await pool.request().query(stmt);
            console.log(`  ✓ ${stmt.substring(0, 80).replace(/\s+/g, ' ')}...`);
            ok++;
        } catch (err) {
            if (err.message.includes('already exists') || err.message.includes('Column already exists') || err.message.includes('Duplicate column')) {
                console.log(`  ⏭ Already applied: ${stmt.substring(0, 60).replace(/\s+/g, ' ')}...`);
                skipped++;
            } else {
                console.error(`  ✗ FAILED: ${err.message}\n    SQL: ${stmt.substring(0, 100)}`);
                failed++;
            }
        }
    }

    console.log(`\nDone: ${ok} applied, ${skipped} already existed, ${failed} failed.`);
    await pool.close();
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
