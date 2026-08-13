const { getPool, closePool } = require('../api/src/shared/sql');

async function main() {
    const pool = await getPool();
    await pool.request().query(`
        IF COL_LENGTH('dbo.Users', 'InvitationPending') IS NULL
        BEGIN
            ALTER TABLE dbo.Users
            ADD InvitationPending BIT NOT NULL
                CONSTRAINT DF_Users_InvitationPending DEFAULT 0;
        END
    `);
    console.log('Users.InvitationPending migration completed.');
}

main()
    .catch(error => {
        console.error('InvitationPending migration failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);