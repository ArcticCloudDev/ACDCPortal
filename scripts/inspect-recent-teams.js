const { getPool, closePool } = require('../api/src/shared/sql');

async function main() {
    const pool = await getPool();
    const result = await pool.request().query(`
        SELECT TOP 10 Id, TeamName, EventId, NumberOfParticipants, AdminUserId, CreatedAt, UpdatedAt
        FROM Teams
        ORDER BY CreatedAt DESC;
    `);
    console.table(result.recordset);
}

main()
    .catch(error => {
        console.error('Recent team inspection failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);
