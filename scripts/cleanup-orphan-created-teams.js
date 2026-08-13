const { getPool, closePool, sql } = require('../api/src/shared/sql');

const apply = process.argv.includes('--apply');
const teamIds = [
    '8476E374-FDF9-4435-93BB-4C29A077FD86',
    '3C942635-0093-4391-A06D-3F70813C3EF4'
];

async function main() {
    const pool = await getPool();
    const request = pool.request();
    teamIds.forEach((teamId, index) => request.input(`team${index}`, sql.UniqueIdentifier, teamId));

    const result = await request.query(`
        SELECT t.Id, t.TeamName, t.CreatedAt,
            (SELECT COUNT(*) FROM Participations p WHERE p.TeamId = t.Id) AS ParticipationCount,
            (SELECT COUNT(*) FROM Invitations i WHERE i.TeamId = t.Id) AS InvitationCount,
            (SELECT COUNT(*) FROM BadgeClaims c WHERE c.TeamId = t.Id) AS BadgeClaimCount
        FROM Teams t
        WHERE t.Id IN (@team0, @team1);
    `);

    console.table(result.recordset);
    const deletable = result.recordset.filter(team =>
        team.ParticipationCount === 0 && team.InvitationCount === 0 && team.BadgeClaimCount === 0
    );

    if (!apply) {
        console.log(`Preview only: ${deletable.length} orphan team(s) are eligible for deletion.`);
        return;
    }

    if (deletable.length !== result.recordset.length) {
        throw new Error('Refusing cleanup because one or more teams have dependent records');
    }

    const deleteRequest = pool.request();
    deletable.forEach((team, index) => deleteRequest.input(`team${index}`, sql.UniqueIdentifier, team.Id));
    await deleteRequest.query(`DELETE FROM Teams WHERE Id IN (${deletable.map((_, index) => `@team${index}`).join(', ')});`);
    console.log(`Removed ${deletable.length} orphan team(s).`);
}

main()
    .catch(error => {
        console.error('Orphan team cleanup failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);
