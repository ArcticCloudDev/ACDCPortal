const { app } = require('@azure/functions');
const { requireAuth, canManageUser, hasEventRole } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { generateId } = require('../shared/id');

const participationsStorage = new Storage('participations');
const teamsStorage = new Storage('teams');
const eventsStorage = new Storage('events');
const usersStorage = new Storage('users');
const interestQueueStorage = new Storage('interest-queue');
const deliveriesStorage = new Storage('email-deliveries');
const invitationsStorage = new Storage('invitations');
const { sendWelcomeEmail } = require('../shared/welcome-email');
const { upsertParticipationRow, deleteParticipationRows, syncParticipationToFinancials } = require('../shared/event-financials');
const { sendSequenceDigest } = require('../shared/sequence-digest');

const VALID_ROLES = ['interest', 'participant', 'judge', 'committee', 'sponsor'];

function isActiveStatus(status) {
    return status === 'pre-registration' || status === 'registration' || status === 'live';
}

async function enforceParticipantCapacity(participation, teamId, participations, confirmCommitmentIncrease = false) {
    if (!teamId || participation.roles?.includes('participant')) return null;

    const teams = await teamsStorage.getAll();
    const team = teams.find(candidate => candidate.id === teamId);
    if (!team) return { status: 404, jsonBody: { error: 'Team not found' } };

    const events = await eventsStorage.getAll();
    const event = events.find(candidate => candidate.id === participation.eventId);
    const maxSize = event?.maxTeamSize || 5;
    const currentCount = participations.filter(candidate =>
        candidate.teamId === teamId
        && candidate.roles?.includes('participant')
        && candidate.id !== participation.id
    ).length;

    if (currentCount >= maxSize) {
        return {
            status: 400,
            jsonBody: { error: `Team has reached maximum of ${maxSize} participants`, currentCount }
        };
    }

    const committedParticipants = team.numberOfParticipants || event?.minTeamSize || 3;
    if (currentCount < committedParticipants) return null;

    const newCommittedParticipants = currentCount + 1;
    if (!confirmCommitmentIncrease) {
        return {
            status: 409,
            jsonBody: {
                error: `All ${committedParticipants} committed participant places are filled. Adding this person increases the commitment to ${newCommittedParticipants}.`,
                requiresCommitmentIncrease: true,
                currentCommittedParticipants: committedParticipants,
                newCommittedParticipants
            }
        };
    }

    await teamsStorage.update(teamId, {
        numberOfParticipants: newCommittedParticipants,
        updatedAt: new Date().toISOString()
    });
    return null;
}

async function syncParticipationFinancials(participation, context) {
    try {
        const events = await eventsStorage.getAll();
        const event = events.find(e => e.id === participation.eventId);
        if (!event) return;
        await syncParticipationToFinancials(event, participation);
    } catch (err) {
        context.error('syncParticipationFinancials failed (non-critical):', err);
    }
}

async function triggerSequenceEmails(userId, eventId, context) {
    const user = await usersStorage.getById(userId);
    if (!user || !user.email) {
        context.log(`No user found for sequence emails: ${userId}`);
        return;
    }
    return sendSequenceDigest({ eventId, email: user.email, firstName: user.firstName, userId }, context);
}

async function removeFromInterestQueue(userId, eventId, context) {
    try {
        const users = await usersStorage.getAll();
        const user = users.find(u => u.id === userId);
        if (!user || !user.email) return;

        const entries = await interestQueueStorage.getAll();
        const entry = entries.find(e =>
            e.email.toLowerCase() === user.email.toLowerCase() && !e.registeredEventId
        );

        if (entry) {
            await interestQueueStorage.update(entry.id, {
                registeredEventId: eventId,
                registeredAt: new Date().toISOString()
            });
            context.log(`Marked interest queue entry for ${user.email} as registered for event ${eventId}`);
        }
    } catch (error) {
        await logError(context, error);
        context.log(`Warning: Failed to update interest queue: ${error.message}`);
    }
}

app.http('participations-get-all', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'participations/all',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const participations = await participationsStorage.getAll();
            participations.forEach(p => {
                if (!p.roles) p.roles = migrateRoles(p);
            });
            return { status: 200, jsonBody: participations };
        } catch (error) {
            await logError(context, error);
            context.error('Participations GET ALL error:', error);
            return { status: 500, jsonBody: { error: 'Internal server error' } };
        }
    }
});

app.http('participations-get', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'participations',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const userId = request.query.get('userId');
            const email = request.query.get('email');
            const eventId = request.query.get('eventId');

            if (!userId && !email) {
                return { status: 400, jsonBody: { error: 'userId or email is required' } };
            }

            const participations = await participationsStorage.getAll();

            let targetEventId = eventId;
            if (!targetEventId) {
                const events = await eventsStorage.getAll();
                const activeEvent = events.find(e => isActiveStatus(e.status));
                if (activeEvent) targetEventId = activeEvent.id;
            }

            const participation = participations.find(p => {
                const matchesUser = userId ? p.userId === userId : p.email?.toLowerCase() === email.toLowerCase();
                return matchesUser && p.eventId === targetEventId;
            });

            if (!participation) {
                return { status: 200, jsonBody: null };
            }

            const isSelf =
                (participation.userId && participation.userId === auth.user.userId) ||
                (participation.email && auth.user.email &&
                    participation.email.toLowerCase() === auth.user.email.toLowerCase());

            if (!isSelf && !canManageUser(auth.user, participation.userId, participations)) {
                return {
                    status: 403,
                    jsonBody: { error: 'You do not have permission to view this participation' }
                };
            }

            if (!participation.roles) participation.roles = migrateRoles(participation);
            if (!participation.teamMemberships) participation.teamMemberships = buildLegacyTeamMemberships(participation);

            return { status: 200, jsonBody: participation };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting participation:', error);
            return { status: 500, jsonBody: { error: 'Failed to get participation' } };
        }
    }
});

app.http('participations-upsert', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'participations',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { userId, email, eventId, hotelNights, roles } = body;

            if (!eventId) {
                return { status: 400, jsonBody: { error: 'eventId is required' } };
            }
            if (!userId && !email) {
                return { status: 400, jsonBody: { error: 'userId or email is required' } };
            }

            const isSelfById = userId && userId === auth.user.userId;
            const isSelfByEmail = email && auth.user.email && email.toLowerCase() === auth.user.email.toLowerCase();
            if (!isSelfById && !isSelfByEmail && !auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            let resolvedEmail = email;
            if (!resolvedEmail && userId) {
                const users = await usersStorage.getAll();
                const user = users.find(u => u.id === userId);
                resolvedEmail = user?.email;
            }

            const participations = await participationsStorage.getAll();

            const existingIndex = participations.findIndex(p => {
                if (userId && p.userId === userId && p.eventId === eventId) return true;
                if (resolvedEmail && p.email?.toLowerCase() === resolvedEmail.toLowerCase() && p.eventId === eventId) return true;
                return false;
            });

            const now = new Date().toISOString();

            if (existingIndex >= 0) {
                const existing = participations[existingIndex];
                const updated = {
                    ...existing,
                    userId: userId || existing.userId,
                    email: resolvedEmail || existing.email,
                    hotelNights: hotelNights !== undefined ? hotelNights : existing.hotelNights,
                    roles: existing.roles || migrateRoles(existing),
                    updatedAt: now
                };
                updated.teamMemberships = buildLegacyTeamMemberships(updated);
                await participationsStorage.update(existing.id, {
                    userId: updated.userId,
                    email: updated.email,
                    hotelNights: updated.hotelNights,
                    roles: updated.roles,
                    updatedAt: now
                });

                context.log(`Participation updated for ${resolvedEmail || userId} in event ${eventId}`);
                return { status: 200, jsonBody: updated };
            } else {
                const initialRoles = roles || [];
                const initialHotelPaidBy = initialRoles.includes('committee') || initialRoles.includes('judge')
                    ? 'committee' : null;

                const newParticipation = {
                    id: generateId(),
                    userId: userId || null,
                    email: resolvedEmail || null,
                    eventId,
                    roles: initialRoles,
                    teamId: null,
                    isTeamAdmin: false,
                    hotelNights: hotelNights || {},
                    hotelPaidBy: initialHotelPaidBy,
                    createdAt: now,
                    updatedAt: now
                };
                newParticipation.teamMemberships = [];
                await participationsStorage.create(newParticipation);

                context.log(`Participation created for ${resolvedEmail || userId} in event ${eventId}`);
                return { status: 201, jsonBody: newParticipation };
            }
        } catch (error) {
            await logError(context, error);
            context.error('Error upserting participation:', error);
            return { status: 500, jsonBody: { error: 'Failed to save participation' } };
        }
    }
});

app.http('participations-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'participations/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await request.json();

            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const existing = participations[index];

            if (!canManageUser(auth.user, existing.userId, participations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            const updated = {
                ...existing,
                ...(body.hotelNights !== undefined && { hotelNights: body.hotelNights }),
                ...(body.teamId !== undefined && { teamId: body.teamId }),
                ...(body.isTeamAdmin !== undefined && { isTeamAdmin: body.isTeamAdmin }),
                ...(body.userId !== undefined && { userId: body.userId }),
                ...(body.email !== undefined && { email: body.email }),
                ...(body.interestSource !== undefined && { interestSource: body.interestSource }),
                ...(body.interestVerified !== undefined && { interestVerified: body.interestVerified }),
                updatedAt: new Date().toISOString()
            };

            updated.teamMemberships = buildLegacyTeamMemberships(updated);
            await participationsStorage.update(id, {
                ...(body.hotelNights !== undefined && { hotelNights: body.hotelNights }),
                ...(body.teamId !== undefined && { teamId: body.teamId }),
                ...(body.isTeamAdmin !== undefined && { isTeamAdmin: body.isTeamAdmin }),
                ...(body.userId !== undefined && { userId: body.userId }),
                ...(body.email !== undefined && { email: body.email }),
                ...(body.interestSource !== undefined && { interestSource: body.interestSource }),
                ...(body.interestVerified !== undefined && { interestVerified: body.interestVerified }),
                updatedAt: updated.updatedAt
            });

            return { status: 200, jsonBody: updated };
        } catch (error) {
            await logError(context, error);
            context.error('Error updating participation:', error);
            return { status: 500, jsonBody: { error: 'Failed to update participation' } };
        }
    }
});

app.http('participations-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'participations/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];

            if (!canManageUser(auth.user, participation.userId, participations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to delete this participation' } };
            }

            const email = participation.email;
            const userId = participation.userId;
            const eventId = participation.eventId;

            await participationsStorage.delete(id);

            let cleaned = { invitations: 0, deliveries: 0 };

            try {
                const allInvitations = await invitationsStorage.getAll();
                const invToDelete = allInvitations.filter(inv =>
                    inv.email?.toLowerCase() === email?.toLowerCase() && inv.eventId === eventId
                );
                for (const inv of invToDelete) await invitationsStorage.delete(inv.id);
                cleaned.invitations = invToDelete.length;
            } catch (e) { context.log(`Warning: invitation cleanup failed: ${e.message}`); }

            try {
                const allDeliveries = await deliveriesStorage.getAll();
                const delToDelete = allDeliveries.filter(d => {
                    if (userId && d.userId === userId) return true;
                    if (email && d.email?.toLowerCase() === email.toLowerCase()) return true;
                    return false;
                });
                for (const d of delToDelete) await deliveriesStorage.delete(d.id);
                cleaned.deliveries = delToDelete.length;
            } catch (e) { context.log(`Warning: delivery cleanup failed: ${e.message}`); }

            context.log(`Deleted participation ${id} (${email}). Cleaned: ${cleaned.invitations} invitations, ${cleaned.deliveries} deliveries`);

            deleteParticipationRows(id).catch(err => context.warn('Financial cleanup after participation delete failed:', err?.message));

            return { status: 200, jsonBody: { success: true, cleaned } };
        } catch (error) {
            await logError(context, error);
            context.error('Error deleting participation:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete participation' } };
        }
    }
});

app.http('participations-update-roles-v2', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'participations/{id}/roles',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await request.json();
            const { add, remove, set, confirmCommitmentIncrease = false } = body;

            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];

            if (!canManageUser(auth.user, participation.userId, participations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            const requestedRoles = [...(set || []), ...(add || [])];
            const grantsPrivilegedRole = requestedRoles.some(r => ['judge', 'committee'].includes(r));
            if (grantsPrivilegedRole && !auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'Only portal admins can grant judge or committee roles' } };
            }

            let roles = participation.roles || migrateRoles(participation);

            if (set && Array.isArray(set)) {
                const invalid = set.filter(r => !VALID_ROLES.includes(r));
                if (invalid.length > 0) {
                    return { status: 400, jsonBody: { error: `Invalid roles: ${invalid.join(', ')}. Valid: ${VALID_ROLES.join(', ')}` } };
                }
                roles = [...new Set(set)];
            } else {
                if (add && Array.isArray(add)) {
                    const invalid = add.filter(r => !VALID_ROLES.includes(r));
                    if (invalid.length > 0) {
                        return { status: 400, jsonBody: { error: `Invalid roles: ${invalid.join(', ')}` } };
                    }
                    roles = [...new Set([...roles, ...add])];
                }
                if (remove && Array.isArray(remove)) {
                    roles = roles.filter(r => !remove.includes(r));
                }
            }

            if (roles.includes('participant') && !participation.roles?.includes('participant') && participation.teamId) {
                const capacityError = await enforceParticipantCapacity(
                    participation,
                    participation.teamId,
                    participations,
                    confirmCommitmentIncrease
                );
                if (capacityError) return capacityError;
            }

            participation.roles = roles;
            participation.updatedAt = new Date().toISOString();

            const addedActionableRole = add?.some(r => ['participant', 'judge', 'committee'].includes(r));
            if (addedActionableRole && participation.userId) {
                await removeFromInterestQueue(participation.userId, participation.eventId, context);
                await triggerSequenceEmails(participation.userId, participation.eventId, context);

                if (participation.email) {
                }
            }

            participation.teamMemberships = buildLegacyTeamMemberships(participation);
            await participationsStorage.update(id, {
                roles: participation.roles,
                updatedAt: participation.updatedAt
            });

            context.log(`Roles updated for participation ${id}: [${roles.join(', ')}]`);
            return { status: 200, jsonBody: participation };
        } catch (error) {
            await logError(context, error);
            context.error('Error updating roles:', error);
            return { status: 500, jsonBody: { error: 'Failed to update roles' } };
        }
    }
});

app.http('participations-assign-team', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'participations/{id}/team',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await request.json();
            const { teamId, isTeamAdmin, isParticipant = true, confirmCommitmentIncrease = false } = body;

            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];

            if (!canManageUser(auth.user, participation.userId, participations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            if (teamId) {
                const teams = await teamsStorage.getAll();
                const team = teams.find(t => t.id === teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }

                if (!participation.roles) participation.roles = [];
                if (isParticipant) {
                    const capacityError = await enforceParticipantCapacity(
                        participation, teamId, participations, confirmCommitmentIncrease
                    );
                    if (capacityError) return capacityError;
                    if (!participation.roles.includes('participant')) participation.roles.push('participant');
                } else {
                    participation.roles = participation.roles.filter(role => role !== 'participant');
                }
            }

            participation.teamId = teamId || null;
            participation.isTeamAdmin = isTeamAdmin || false;
            participation.updatedAt = new Date().toISOString();

            participation.teamMemberships = buildLegacyTeamMemberships(participation);
            await participationsStorage.update(id, {
                teamId: participation.teamId,
                isTeamAdmin: participation.isTeamAdmin,
                roles: participation.roles,
                updatedAt: participation.updatedAt
            });

            if (teamId && participation.userId) {
                await removeFromInterestQueue(participation.userId, participation.eventId, context);
                await triggerSequenceEmails(participation.userId, participation.eventId, context);

                if (participation.email) {
                }
            }

            context.log(`Team assignment updated for participation ${id}: team=${teamId}`);
            return { status: 200, jsonBody: participation };
        } catch (error) {
            await logError(context, error);
            context.error('Error assigning team:', error);
            return { status: 500, jsonBody: { error: 'Failed to assign team' } };
        }
    }
});

app.http('participations-update-hotel', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'participations/{id}/hotel',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await request.json();
            const { hotelNights, profileVerification } = body;

            const participation = await participationsStorage.getById(id);
            if (!participation) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const hotelParticipations = await participationsStorage.getAll();
            if (!canManageUser(auth.user, participation.userId, hotelParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            const updatedAt = new Date().toISOString();
            const changes = { updatedAt };

            if (hotelNights !== undefined) changes.hotelNights = hotelNights;
            if (profileVerification !== undefined) changes.profileVerification = profileVerification;

            await participationsStorage.update(id, changes);

            context.log(`Hotel updated for participation ${id} (profileVerification=${profileVerification})`);
            return { status: 200, jsonBody: { ...participation, ...changes } };
        } catch (error) {
            await logError(context, error);
            context.error('Error updating hotel nights:', error);
            return { status: 500, jsonBody: { error: 'Failed to update hotel nights' } };
        }
    }
});

app.http('participations-by-event', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'participations/event/{eventId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const role = request.query.get('role');

            const participations = await participationsStorage.getAll();
            let results = participations.filter(p => p.eventId === eventId);

            results.forEach(p => {
                if (!p.roles) p.roles = migrateRoles(p);
                if (!p.teamMemberships) p.teamMemberships = buildLegacyTeamMemberships(p);
            });

            if (role) {
                results = results.filter(p => p.roles.includes(role));
            }

            const isStaff = auth.user.isPortalAdmin
                || hasEventRole(auth.user, eventId, 'judge', participations)
                || hasEventRole(auth.user, eventId, 'committee', participations);

            if (!isStaff) {
                const callerTeamIds = new Set(
                    results
                        .filter(p => p.userId === auth.user.userId)
                        .flatMap(p => (p.teamMemberships || []).map(m => m.teamId))
                );
                // Regular participants only get membership data, never other people's contact or hotel details.
                results = results.map(p => {
                    const sharesTeam = (p.teamMemberships || []).some(m => callerTeamIds.has(m.teamId));
                    return {
                        id: p.id,
                        userId: p.userId,
                        eventId: p.eventId,
                        teamId: p.teamId,
                        isTeamAdmin: p.isTeamAdmin,
                        roles: p.roles,
                        teamMemberships: p.teamMemberships,
                        ...(sharesTeam ? { hotelNights: p.hotelNights } : {})
                    };
                });
            }

            return { status: 200, jsonBody: results };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting participations by event:', error);
            return { status: 500, jsonBody: { error: 'Failed to get participations' } };
        }
    }
});

app.http('participations-by-person', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'participations/person/{email}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const email = decodeURIComponent(request.params.email);

            const isSelf = auth.user.email && email.toLowerCase() === auth.user.email.toLowerCase();
            if (!isSelf && !auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'You do not have permission to view these participations' } };
            }

            const participations = await participationsStorage.getAll();
            const personParticipations = participations.filter(p =>
                p.email?.toLowerCase() === email.toLowerCase()
            );

            const users = await usersStorage.getAll();
            const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
            if (user) {
                participations.forEach(p => {
                    if (p.userId === user.id && !personParticipations.find(pp => pp.id === p.id)) {
                        personParticipations.push(p);
                    }
                });
            }

            personParticipations.forEach(p => {
                if (!p.roles) p.roles = migrateRoles(p);
            });

            const events = await eventsStorage.getAll();
            const enriched = personParticipations.map(p => ({
                ...p,
                eventName: events.find(e => e.id === p.eventId)?.name || 'Unknown Event'
            }));

            return { status: 200, jsonBody: enriched };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting participations by person:', error);
            return { status: 500, jsonBody: { error: 'Failed to get participations' } };
        }
    }
});

app.http('participations-team-count', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'participations/team/{teamId}/count',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const teamId = request.params.teamId;
            const participations = await participationsStorage.getAll();

            let adminCount = 0;
            let participantCount = 0;

            for (const p of participations) {
                if (p.teamId === teamId && p.roles?.includes('participant')) {
                    participantCount++;
                    if (p.isTeamAdmin) adminCount++;
                    continue;
                }
                const membership = (p.teamMemberships || []).find(m => m.teamId === teamId);
                if (membership) {
                    if (membership.isAdmin) adminCount++;
                    if (membership.isParticipant) participantCount++;
                }
            }

            return {
                status: 200,
                jsonBody: { teamId, adminCount, participantCount, maxParticipants: 5 }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting team count:', error);
            return { status: 500, jsonBody: { error: 'Failed to get team count' } };
        }
    }
});

app.http('participations-update-team-roles', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'participations/{id}/team-membership/{teamId}/roles',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const teamId = request.params.teamId;
            const body = await request.json();
            const { isAdmin, isParticipant, confirmCommitmentIncrease = false } = body;

            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];

            if (!canManageUser(auth.user, participation.userId, participations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            if (isParticipant && !participation.roles?.includes('participant')) {
                if (participation.teamId && participation.teamId !== teamId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Already a participant on another team', existingTeamId: participation.teamId }
                    };
                }

                const capacityError = await enforceParticipantCapacity(
                    participation, teamId, participations, confirmCommitmentIncrease
                );
                if (capacityError) return capacityError;
            }

            participation.teamId = teamId;
            participation.isTeamAdmin = isAdmin;
            if (!participation.roles) participation.roles = [];
            if (isParticipant && !participation.roles.includes('participant')) {
                participation.roles.push('participant');
            } else if (!isParticipant) {
                participation.roles = participation.roles.filter(r => r !== 'participant');
            }

            const memberships = participation.teamMemberships || [];
            const membershipIndex = memberships.findIndex(m => m.teamId === teamId);
            if (membershipIndex >= 0) {
                memberships[membershipIndex].isAdmin = isAdmin;
                memberships[membershipIndex].isParticipant = isParticipant;
            }
            participation.teamMemberships = memberships;

            participation.updatedAt = new Date().toISOString();
            await participationsStorage.update(id, {
                teamId: participation.teamId,
                isTeamAdmin: participation.isTeamAdmin,
                roles: participation.roles,
                updatedAt: participation.updatedAt
            });

            context.log(`Legacy team roles updated for participation ${id}, team ${teamId}`);
            return { status: 200, jsonBody: participation };
        } catch (error) {
            await logError(context, error);
            context.error('Error updating team roles:', error);
            return { status: 500, jsonBody: { error: 'Failed to update roles' } };
        }
    }
});

function migrateRoles(participation) {
    const roles = [];

    if (participation.interestDate || participation.interestSource) {
        roles.push('interest');
    }

    if (participation.teamMemberships && participation.teamMemberships.length > 0) {
        for (const tm of participation.teamMemberships) {
            if (tm.isParticipant && !roles.includes('participant')) {
                roles.push('participant');
            }
        }
    }

    if (participation.teamId && !roles.includes('participant')) {
        roles.push('participant');
    }

    return roles;
}

function buildLegacyTeamMemberships(participation) {
    if (participation.teamMemberships && participation.teamMemberships.length > 0) {
        return participation.teamMemberships;
    }

    if (participation.teamId) {
        return [{
            teamId: participation.teamId,
            isAdmin: participation.isTeamAdmin || false,
            isParticipant: participation.roles?.includes('participant') || false
        }];
    }

    return [];
}

