// Migration: Add TeamRegistrationTerms, SoloQueueTerms, SingleRegistrationTerms to Events table
const sql = require('mssql');
const { DefaultAzureCredential } = require('@azure/identity');

async function run() {
    console.log('Getting Azure AD token...');
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://database.windows.net/.default');

    console.log('Connecting to Azure SQL...');
    const pool = await sql.connect({
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        options: { encrypt: true, trustServerCertificate: false },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: { token: tokenResponse.token }
        },
        connectionTimeout: 120000,
        requestTimeout: 30000
    });
    console.log('Connected!');

    const migrations = [
        {
            check: `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Events' AND COLUMN_NAME = 'TeamRegistrationTerms'`,
            alter: `ALTER TABLE [Events] ADD [TeamRegistrationTerms] NVARCHAR(MAX) NULL`,
            label: 'TeamRegistrationTerms'
        },
        {
            check: `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Events' AND COLUMN_NAME = 'SoloQueueTerms'`,
            alter: `ALTER TABLE [Events] ADD [SoloQueueTerms] NVARCHAR(MAX) NULL`,
            label: 'SoloQueueTerms'
        },
        {
            check: `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Events' AND COLUMN_NAME = 'SingleRegistrationTerms'`,
            alter: `ALTER TABLE [Events] ADD [SingleRegistrationTerms] NVARCHAR(MAX) NULL`,
            label: 'SingleRegistrationTerms'
        }
    ];

    for (const m of migrations) {
        const result = await pool.request().query(m.check);
        if (result.recordset.length > 0) {
            console.log(`  ✓ ${m.label} already exists — skipping`);
        } else {
            await pool.request().query(m.alter);
            console.log(`  ✓ Added ${m.label}`);
        }
    }

    await pool.close();
    console.log('Done.');
}

run().catch(err => { console.error(err); process.exit(1); });
