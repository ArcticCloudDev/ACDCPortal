// One-time migration: rename HotelAcknowledged -> ProfileVerification in Participations
const sql = require('../api/node_modules/mssql');
const { DefaultAzureCredential } = require('../api/node_modules/@azure/identity');

async function run() {
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://database.windows.net/.default');
    const pool = await sql.connect({
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        options: { encrypt: true, trustServerCertificate: false },
        authentication: { type: 'azure-active-directory-access-token', options: { token: tokenResponse.token } },
        connectionTimeout: 120000,
        requestTimeout: 120000
    });
    console.log('Connected');

    // Check if column already renamed
    const check = await pool.request().query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Participations' AND COLUMN_NAME IN ('HotelAcknowledged','ProfileVerification')"
    );
    const cols = check.recordset.map(r => r.COLUMN_NAME);
    console.log('Current columns found:', cols);

    if (cols.includes('ProfileVerification') && !cols.includes('HotelAcknowledged')) {
        console.log('Already renamed — nothing to do.');
    } else if (cols.includes('HotelAcknowledged')) {
        await pool.request().query("EXEC sp_rename 'Participations.HotelAcknowledged', 'ProfileVerification', 'COLUMN'");
        console.log('Renamed HotelAcknowledged -> ProfileVerification');
    } else {
        console.log('Neither column found — may need to add it.');
    }

    await pool.close();
}

run().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
