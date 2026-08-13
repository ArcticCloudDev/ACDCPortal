const { getPool, closePool, sql } = require('../api/src/shared/sql');

const teamId = process.argv[2]?.trim();

if (!teamId) {
    console.error('Usage: node scripts/inspect-team.js <team-id>');
    process.exit(1);
}

async function main() {
    const pool = await getPool();
    const result = await pool.request()
        .input('teamId', sql.UniqueIdentifier, teamId)
        .query(`
            SELECT Id, TeamName, EventId, NumberOfParticipants, AdminUserId, CreatedAt, UpdatedAt
            FROM Teams
            WHERE Id = @teamId;
        `);
    console.table(result.recordset);
}

main()
    .catch(error => {
        console.error('Team inspection failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);