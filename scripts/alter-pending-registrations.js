// One-time migration: Add WillParticipate and EventId columns to PendingRegistrations
const sql = require('mssql');
const { DefaultAzureCredential } = require('@azure/identity');

async function run() {
    console.log('Getting Azure AD token...');
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://database.windows.net/.default');

    console.log('Connecting...');
    const config = {
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        options: { encrypt: true, trustServerCertificate: false },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: { token: tokenResponse.token }
        },
        connectionTimeout: 120000,
        requestTimeout: 120000
    };
    const pool = await sql.connect(config);
    console.log('Connected!');

    // Check existing columns
    const check = await pool.request().query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'PendingRegistrations' ORDER BY ORDINAL_POSITION"
    );
    const cols = check.recordset.map(r => r.COLUMN_NAME);
    console.log('Current columns:', cols.join(', '));

    if (!cols.includes('WillParticipate')) {
        await pool.request().query('ALTER TABLE PendingRegistrations ADD WillParticipate BIT NULL');
        console.log('Added WillParticipate');
    } else {
        console.log('WillParticipate already exists - skipping');
    }

    if (!cols.includes('EventId')) {
        await pool.request().query('ALTER TABLE PendingRegistrations ADD EventId UNIQUEIDENTIFIER NULL');
        console.log('Added EventId');
    } else {
        console.log('EventId already exists - skipping');
    }

    await pool.close();
    console.log('Done!');
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
