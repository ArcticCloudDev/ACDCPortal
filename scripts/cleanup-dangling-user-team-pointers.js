const { getPool, closePool, sql } = require('../api/src/shared/sql');

const apply = process.argv.includes('--apply');

async function main() {
    const pool = await getPool();
    const { recordset: users } = await pool.request().query(`
        SELECT u.Id, u.Email, u.TeamId, u.ProfileComplete, u.UpdatedAt
        FROM Users u
        LEFT JOIN Teams t ON t.Id = u.TeamId
        WHERE u.TeamId IS NOT NULL AND t.Id IS NULL
        ORDER BY u.Email;
    `);

    if (users.length === 0) {
        console.log('No dangling Users.TeamId pointers found. No changes made.');
        return;
    }

    console.table(users);
    if (!apply) {
        console.log(`Preview only: ${users.length} legacy team pointer(s) would be cleared. Run with --apply to update them.`);
        return;
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        for (const user of users) {
            await new sql.Request(transaction)
                .input('id', sql.UniqueIdentifier, user.Id)
                .query('UPDATE Users SET TeamId = NULL, UpdatedAt = SYSUTCDATETIME() WHERE Id = @id;');
        }
        await transaction.commit();
        console.log(`Cleared ${users.length} dangling Users.TeamId pointer(s).`);
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

main()
    .catch(error => {
        console.error('Legacy team pointer cleanup failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);