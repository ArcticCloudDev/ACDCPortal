// Reset transactional test data in Azure SQL
// Preserves: Events, Users, EmailCampaigns, Sequences, SystemEmailConfig, Badges, EventBadges
// Clears:    Participations, Invitations, Teams, InterestLeads, InterestQueue, SoloQueue,
//            EmailDeliveries, EmailLog, ScheduledRuns, ScheduledRunCampaigns, BadgeClaims
const sql = require('../api/node_modules/mssql');
const { DefaultAzureCredential } = require('../api/node_modules/@azure/identity');
const readline = require('readline');

const TABLES_TO_CLEAR = [
    // Children first (FK order)
    { name: 'ScheduledRunCampaigns', note: 'child of ScheduledRuns' },
    { name: 'EmailDeliveries',       note: '' },
    { name: 'EmailLog',              note: '' },
    { name: 'BadgeClaims',           note: 'child of EventBadges/Badges' },
    { name: 'ScheduledRuns',         note: '' },
    { name: 'Invitations',           note: '' },
    { name: 'Participations',        note: '' },
    { name: 'InterestLeads',         note: '' },
    { name: 'InterestQueue',         note: '' },
    { name: 'SoloQueue',             note: '' },
    // Teams last — must null out cross-references in Events/Users first
];

async function confirm(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

async function run() {
    console.log('\n=== ACDC Portal: Transactional Data Reset ===\n');
    console.log('This will DELETE all rows from:');
    TABLES_TO_CLEAR.forEach(t => console.log(`  - ${t.name}${t.note ? ' (' + t.note + ')' : ''}`));
    console.log('  - Teams (after nulling Events.CommitteeTeamId/JudgesTeamId and Users.TeamId)\n');
    console.log('Preserved: Events, Users, EmailCampaigns, Sequences, Badges, EventBadges, SystemEmailConfig\n');

    const answer = await confirm('Type "yes" to proceed: ');
    if (answer !== 'yes') {
        console.log('Aborted.');
        process.exit(0);
    }

    console.log('\nGetting Azure AD token...');
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://database.windows.net/.default');

    console.log('Connecting to Azure SQL (may take ~60s if auto-paused)...');
    const pool = await sql.connect({
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        options: {
            encrypt: true,
            trustServerCertificate: false
        },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: { token: tokenResponse.token }
        },
        connectionTimeout: 120000,
        requestTimeout: 120000
    });
    console.log('Connected!\n');

    try {
        // Clear all transactional tables
        for (const { name } of TABLES_TO_CLEAR) {
            const result = await pool.request().query(`DELETE FROM [${name}]`);
            console.log(`  ✓ Cleared ${name} (${result.rowsAffected[0]} rows deleted)`);
        }

        // Null out cross-references in Events before deleting Teams
        const eventsResult = await pool.request().query(
            `UPDATE Events SET CommitteeTeamId = NULL, JudgesTeamId = NULL
             WHERE CommitteeTeamId IS NOT NULL OR JudgesTeamId IS NOT NULL`
        );
        console.log(`  ✓ Nulled Events.CommitteeTeamId/JudgesTeamId (${eventsResult.rowsAffected[0]} rows updated)`);

        // Null out legacy Users.TeamId
        const usersResult = await pool.request().query(
            `UPDATE Users SET TeamId = NULL WHERE TeamId IS NOT NULL`
        );
        console.log(`  ✓ Nulled Users.TeamId legacy field (${usersResult.rowsAffected[0]} rows updated)`);

        // Delete Teams
        const teamsResult = await pool.request().query(`DELETE FROM Teams`);
        console.log(`  ✓ Cleared Teams (${teamsResult.rowsAffected[0]} rows deleted)`);

        console.log('\nDone. Database reset to clean state for testing.\n');
    } catch (err) {
        console.error('\nERROR:', err.message);
        process.exit(1);
    } finally {
        await pool.close();
    }
}

run().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
