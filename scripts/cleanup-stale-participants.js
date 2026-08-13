const { getPool, closePool, sql } = require('../api/src/shared/sql');

const apply = process.argv.includes('--apply');

const staleParticipantsQuery = `
    SELECT
        p.Id,
        p.Email,
        p.UserId,
        p.EventId,
        p.TeamId,
        p.CreatedAt,
        CASE
            WHEN p.UserId IS NULL THEN 'email-only participation without a user'
            WHEN userById.Id IS NULL THEN 'participation references a missing user'
            ELSE 'incomplete team contact without a pending invitation'
        END AS Reason
    FROM Participations p
    LEFT JOIN Users userById ON userById.Id = p.UserId
    LEFT JOIN Users userByEmail ON LOWER(userByEmail.Email) = LOWER(p.Email)
    WHERE (p.UserId IS NULL AND userByEmail.Id IS NULL)
       OR (p.UserId IS NOT NULL AND userById.Id IS NULL)
       OR (
            userById.Id IS NOT NULL
            AND userById.ProfileComplete = 0
            AND p.TeamId IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM Invitations invitation
                WHERE invitation.Status = 'pending'
                  AND invitation.EventId = p.EventId
                  AND invitation.TeamId = p.TeamId
                  AND LOWER(invitation.Email) = LOWER(p.Email)
            )
       )
    ORDER BY p.CreatedAt, p.Email;
`;

async function main() {
    const pool = await getPool();
    const { recordset: staleParticipants } = await pool.request().query(staleParticipantsQuery);

    if (staleParticipants.length === 0) {
        console.log('No stale participants found. No changes made.');
        return;
    }

    console.table(staleParticipants.map(participant => ({
        id: participant.Id,
        email: participant.Email,
        eventId: participant.EventId,
        teamId: participant.TeamId,
        reason: participant.Reason,
        createdAt: participant.CreatedAt
    })));

    if (!apply) {
        console.log(`Preview only: ${staleParticipants.length} stale participant(s) would be removed. Run with --apply to delete them.`);
        return;
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
        for (const participant of staleParticipants) {
            const request = new sql.Request(transaction);
            request.input('participationId', sql.UniqueIdentifier, participant.Id);
            request.input('email', sql.NVarChar(320), participant.Email);
            request.input('eventId', sql.UniqueIdentifier, participant.EventId);
            request.input('teamId', sql.UniqueIdentifier, participant.TeamId);
            request.input('userId', sql.UniqueIdentifier, participant.UserId);

            await request.query(`
                IF OBJECT_ID('dbo.TeamMemberships', 'U') IS NOT NULL
                    DELETE FROM TeamMemberships WHERE ParticipationId = @participationId;
                IF OBJECT_ID('dbo.EventFinancials', 'U') IS NOT NULL
                    DELETE FROM EventFinancials WHERE ParticipationId = @participationId;
                DELETE FROM Invitations
                WHERE Status = 'pending'
                  AND EventId = @eventId
                  AND LOWER(Email) = LOWER(@email);
                DELETE FROM Participations WHERE Id = @participationId;
                                UPDATE Users
                                SET TeamId = NULL, UpdatedAt = SYSUTCDATETIME()
                                WHERE Id = @userId
                                    AND ProfileComplete = 0
                                    AND TeamId = @teamId;
            `);
        }

        await transaction.commit();
        console.log(`Removed ${staleParticipants.length} stale participant(s) and dependent pending records.`);
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

main()
    .catch(error => {
        console.error('Stale participant cleanup failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);