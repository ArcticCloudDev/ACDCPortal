const sql = require('../api/node_modules/mssql');
const { DefaultAzureCredential } = require('../api/node_modules/@azure/identity');

async function run() {
    const credential = new DefaultAzureCredential();
    const token = await credential.getToken('https://database.windows.net/.default');
    const pool = await sql.connect({
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        options: { encrypt: true },
        authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
        connectionTimeout: 120000,
        requestTimeout: 30000
    });

    const r = await pool.request().query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Participations' ORDER BY ORDINAL_POSITION"
    );
    console.log('Participations columns:', r.recordset.map(x => x.COLUMN_NAME).join(', '));
    await pool.close();
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
