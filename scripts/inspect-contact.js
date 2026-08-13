const { getPool, closePool, sql } = require('../api/src/shared/sql');

const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
    console.error('Usage: node scripts/inspect-contact.js <email>');
    process.exit(1);
}

async function query(pool, text) {
    return (await pool.request().input('email', sql.NVarChar(320), email).query(text)).recordset;
}

async function main() {
    const pool = await getPool();
    const users = await query(pool, `
        SELECT Id, Email, FirstName, LastName, ProfileComplete, TeamId, CreatedAt, UpdatedAt
        FROM Users WHERE LOWER(Email) = @email;
    `);
    const participations = await query(pool, `
        SELECT p.Id, p.UserId, p.Email, p.EventId, p.TeamId, p.Roles, p.CreatedAt, p.UpdatedAt,
               t.TeamName, t.EventId AS TeamEventId
        FROM Participations p
        LEFT JOIN Teams t ON t.Id = p.TeamId
        WHERE LOWER(p.Email) = @email;
    `);
    const invitations = await query(pool, `
        SELECT Id, Email, EventId, TeamId, TeamName, Role, Status, CreatedAt, ExpiresAt, CancelledAt, AcceptedAt
        FROM Invitations WHERE LOWER(Email) = @email ORDER BY CreatedAt;
    `);
    const legacyTeams = await query(pool, `
        SELECT t.Id, t.TeamName, t.EventId
        FROM Teams t
        INNER JOIN Users u ON u.TeamId = t.Id
        WHERE LOWER(u.Email) = @email;
    `);
    const userColumns = await pool.request().query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'Users'
          AND COLUMN_NAME IN ('InvitationPending', 'ProfileComplete', 'TeamId')
        ORDER BY COLUMN_NAME;
    `);

    console.log('Users');
    console.table(users);
    console.log('Participations');
    console.table(participations);
    console.log('Invitations');
    console.table(invitations);
    console.log('Legacy user TeamId target');
    console.table(legacyTeams);
    console.log('Users lifecycle columns');
    console.table(userColumns.recordset);
}

main()
    .catch(error => {
        console.error('Contact inspection failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);