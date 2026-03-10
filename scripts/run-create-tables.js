// Run CREATE TABLE statements against Azure SQL using Entra ID auth
const sql = require('mssql');
const { DefaultAzureCredential } = require('@azure/identity');
const fs = require('fs');
const path = require('path');

async function run() {
    console.log('Getting Azure AD token...');
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://database.windows.net/.default');
    
    console.log('Connecting to Azure SQL (database may need to wake from auto-pause, this can take ~60s)...');
    const config = {
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        options: {
            encrypt: true,
            trustServerCertificate: false
        },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: {
                token: tokenResponse.token
            }
        },
        connectionTimeout: 120000,
        requestTimeout: 120000
    };

    const pool = await sql.connect(config);
    console.log('Connected!');

    // Read and execute the SQL file
    const sqlFile = fs.readFileSync(path.join(__dirname, 'create-tables.sql'), 'utf8');
    
    // Split on GO statements (batch separator)
    const batches = sqlFile.split(/^\s*GO\s*$/im).filter(b => b.trim());
    
    let batchNum = 0;
    for (const batch of batches) {
        batchNum++;
        if (!batch.trim()) continue;
        try {
            await pool.request().query(batch);
            // Extract table name from batch for progress reporting
            const tableMatch = batch.match(/CREATE TABLE (\w+)/i);
            if (tableMatch) {
                console.log(`  ✓ ${tableMatch[1]}`);
            }
        } catch (err) {
            if (err.message.includes('already exists') || err.message.includes('There is already')) {
                const tableMatch = batch.match(/CREATE TABLE (\w+)/i);
                console.log(`  ⏭ ${tableMatch ? tableMatch[1] : 'batch ' + batchNum} (already exists)`);
            } else {
                console.error(`  ✗ Batch ${batchNum} failed:`, err.message);
            }
        }
    }

    // Verify
    const result = await pool.request().query(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
    );
    console.log(`\n=== ${result.recordset.length} tables in database ===`);
    result.recordset.forEach(r => console.log(`  • ${r.TABLE_NAME}`));
    
    await pool.close();
}

run().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
