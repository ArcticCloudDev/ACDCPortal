const { getPool, closePool } = require('../api/src/shared/sql');

async function main() {
    const pool = await getPool();
    const result = await pool.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'Invitations'
        ORDER BY ORDINAL_POSITION;
    `);
    console.table(result.recordset);
}

main()
    .catch(error => {
        console.error('Invitation schema inspection failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);