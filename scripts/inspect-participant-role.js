const { getPool, closePool, sql } = require('../api/src/shared/sql');

const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
    console.error('Usage: node scripts/inspect-participant-role.js <email>');
    process.exit(1);
}

async function main() {
    const pool = await getPool();
    const result = await pool.request()
        .input('email', sql.NVarChar(320), email)
        .query(`
            SELECT p.Id, p.Email, p.EventId, p.TeamId, p.Roles, p.IsTeamAdmin,
                   p.ProfileVerification, t.TeamName
            FROM Participations p
            LEFT JOIN Teams t ON t.Id = p.TeamId
            WHERE LOWER(p.Email) = @email;
        `);
    console.table(result.recordset);
}

main()
    .catch(error => {
        console.error('Participant role inspection failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);