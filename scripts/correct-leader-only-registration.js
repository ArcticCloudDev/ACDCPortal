const { getPool, closePool, sql } = require('../api/src/shared/sql');

const apply = process.argv.includes('--apply');
const participationId = '09157AEC-080B-48C7-AE51-13FDC1BFA904';

async function main() {
    const pool = await getPool();
    const result = await pool.request()
        .input('id', sql.UniqueIdentifier, participationId)
        .query(`
            SELECT p.Id, p.Email, p.TeamId, p.Roles, p.IsTeamAdmin, t.TeamName
            FROM Participations p
            LEFT JOIN Teams t ON t.Id = p.TeamId
            WHERE p.Id = @id;
        `);
    const participant = result.recordset[0];
    if (!participant) throw new Error('Target participation was not found');

    console.table([participant]);
    if (!apply) {
        console.log('Preview only: this leader will be changed to admin-only with no participant role. Run with --apply to update.');
        return;
    }

    if (!participant.IsTeamAdmin || !participant.Roles.split(',').map(role => role.trim()).includes('participant')) {
        throw new Error('Refusing update because the target is not an admin with a participant role');
    }

    await pool.request()
        .input('id', sql.UniqueIdentifier, participationId)
        .query(`
            UPDATE Participations
            SET Roles = NULL, UpdatedAt = SYSUTCDATETIME()
            WHERE Id = @id;
        `);
    console.log('Leader-only registration corrected.');
}

main()
    .catch(error => {
        console.error('Leader-only correction failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);