const { getPool, closePool } = require('../api/src/shared/sql');

async function main() {
    const pool = await getPool();
    await pool.request().query(`
        IF COL_LENGTH('dbo.Invitations', 'InviteePhone') IS NULL
            ALTER TABLE dbo.Invitations ADD InviteePhone NVARCHAR(50) NULL;

        IF COL_LENGTH('dbo.Invitations', 'InviteeGamertag') IS NULL
            ALTER TABLE dbo.Invitations ADD InviteeGamertag NVARCHAR(100) NULL;

        IF COL_LENGTH('dbo.Invitations', 'InviteeAllergies') IS NULL
            ALTER TABLE dbo.Invitations ADD InviteeAllergies NVARCHAR(MAX) NULL;
    `);
    console.log('Invitation contact-details migration completed.');
}

main()
    .catch(error => {
        console.error('Invitation contact-details migration failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);