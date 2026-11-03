const { app } = require('@azure/functions');
const { requireAuth, canManageUser, isTeamAuthorized, isTeamMember, hasEventRole } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { generateId, isGuid, sameId } = require('../shared/id');
const { Validator, readJson, INVALID_JSON } = require('../shared/validate');

const participationsStorage = new Storage('participations');
const teamsStorage = new Storage('teams');
const eventsStorage = new Storage('events');
const usersStorage = new Storage('users');
const deliveriesStorage = new Storage('email-deliveries');
const invitationsStorage = new Storage('invitations');
const soloQueueStorage = new Storage('solo-queue');
const { deleteParticipationRows } = require('../shared/event-financials');
const { sendSequenceDigest } = require('../shared/sequence-digest');

const VALID_ROLES = ['interest', 'participant', 'judge', 'committee', 'sponsor'];
const HOTEL_NIGHT_KEYS = ['mon-tue', 'tue-wed', 'wed-thu', 'thu-fri', 'fri-sat', 'sat-sun', 'sun-mon'];

function isActiveStatus(status) {
    return status === 'pre-registration' || status === 'registration' || status === 'live';
}

// Deterministic default: the active event that starts first (ties broken by id).
async function getDefaultEventId() {
    const events = (await eventsStorage.getAll()).filter(e => isActiveStatus(e.status));
    events.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || String(a.id).localeCompare(String(b.id)));
    return events.length > 0 ? events[0].id : null;
}

// Rows the authorization helpers need: the caller's and the target's participations.
async function participationsFor(...userIds) {
    return participationsStorage.findBy({ userId: userIds.filter(Boolean) });
}

function cleanHotelNights(value, v) {
    if (value === undefined) return undefined;
    if (value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        v.errors.push('hotelNights must be an object');
        return undefined;
    }
    const nights = {};
    for (const key of HOTEL_NIGHT_KEYS) nights[key] = !!value[key];
    return nights;
}

// Returns an error response when adding this participation to `teamId` as a participant
// would exceed the event's maximum or the team's committed size (409 asks for confirmation).
async function enforceParticipantCapacity(participation, teamId, confirmCommitmentIncrease = false) {
    if (!teamId) return null;
    // Already counted as a participant on this very team: nothing changes.
    if (participation.roles?.includes('participant') && sameId(participation.teamId, teamId)) return null;

    const team = await teamsStorage.getById(teamId);
    if (!team) return { status: 404, jsonBody: { error: 'Team not found' } };

    const event = await eventsStorage.getById(participation.eventId);
    const maxSize = event?.maxTeamSize || 5;
    const teamParticipations = await participationsStorage.findBy({ teamId });
    const currentCount = teamParticipations.filter(candidate =>
        candidate.roles?.includes('participant')
        && !sameId(candidate.id, participation.id)
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

async function triggerSequenceEmails(userId, eventId, context) {
    const user = await usersStorage.getById(userId);
    if (!user || !user.email) {
        context.log(`No user found for sequence emails: ${userId}`);
        return;
    }
    return sendSequenceDigest({ eventId, email: user.email, firstName: user.firstName, userId }, context);
}

// Joining a team means leaving the solo queue for that event.
async function leaveSoloQueue(userId, eventId, context) {
    if (!userId || !eventId) return;
    for (const entry of await soloQueueStorage.findBy({ userId, eventId })) {
        await soloQueueStorage.delete(entry.id);
        context.log(`Removed solo queue entry ${entry.id} after team assignment`);
    }
}

async function isEventStaff(user, eventId) {
    if (user.isAdmin) return true;
    const own = await participationsStorage.findBy({ userId: user.userId, eventId });
    return hasEventRole(user, eventId, 'judge', own) || hasEventRole(user, eventId, 'committee', own);
}

app.http('participations-get-all', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'participations/all',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const userId = request.query.get('userId');
            const email = request.query.get('email');
            const eventId = request.query.get('eventId');

            if (!userId && !email) {
                return { status: 400, jsonBody: { error: 'userId or email is required' } };
            }
            if (eventId && !isGuid(eventId)) {
                return { status: 400, jsonBody: { error: 'Invalid event ID' } };
            }

            const targetEventId = eventId || await getDefaultEventId();
            if (!targetEventId) {
                return { status: 200, jsonBody: null };
            }

            const participation = userId
                ? await participationsStorage.findOneBy({ userId, eventId: targetEventId })
                : await participationsStorage.findOneBy({ email, eventId: targetEventId });

            if (!participation) {
                return { status: 200, jsonBody: null };
            }

            const isSelf =
                (participation.userId && sameId(participation.userId, auth.user.userId)) ||
                (participation.email && auth.user.email &&
                    participation.email.toLowerCase() === auth.user.email.toLowerCase());

            if (!isSelf) {
                const related = await participationsFor(auth.user.userId, participation.userId);
                if (!canManageUser(auth.user, participation.userId, related)) {
                    return {
                        status: 403,
                        jsonBody: { error: 'You do not have permission to view this participation' }
                    };
                }
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await readJson(request);
            if (!body) return INVALID_JSON;
            const { userId, email, eventId, hotelNights, roles } = body;

            if (!eventId) {
                return { status: 400, jsonBody: { error: 'eventId is required' } };
            }
            if (!userId && !email) {
                return { status: 400, jsonBody: { error: 'userId or email is required' } };
            }

            const isSelfById = userId && sameId(userId, auth.user.userId);
            const isSelfByEmail = email && auth.user.email && String(email).toLowerCase() === auth.user.email.toLowerCase();
            if (!isSelfById && !isSelfByEmail && !auth.user.isAdmin) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            const isAdmin = auth.user.isAdmin;
            if (!isAdmin && roles !== undefined) {
                return { status: 403, jsonBody: { error: 'Only administrators can assign participation roles' } };
            }

            const v = new Validator();
            const cleanEventId = v.guid(eventId, 'eventId', { required: true });
            const requestedUserId = isAdmin ? v.guid(userId, 'userId') : auth.user.userId;
            const requestedEmail = isAdmin ? (email ? v.email(email, 'email') : undefined) : auth.user.email;
            const cleanHotel = cleanHotelNights(hotelNights, v);
            if (v.failed) return v.failure();

            const event = await eventsStorage.getById(cleanEventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            let resolvedEmail = requestedEmail ? String(requestedEmail).toLowerCase() : undefined;
            if (!resolvedEmail && requestedUserId) {
                const user = await usersStorage.getById(requestedUserId);
                resolvedEmail = user?.email;
            }

            const existing = (requestedUserId && await participationsStorage.findOneBy({ userId: requestedUserId, eventId: cleanEventId }))
                || (resolvedEmail && await participationsStorage.findOneBy({ email: resolvedEmail, eventId: cleanEventId }))
                || null;

            const now = new Date().toISOString();

            if (existing) {
                const updated = {
                    ...existing,
                    userId: requestedUserId || existing.userId,
                    email: resolvedEmail || existing.email,
                    hotelNights: cleanHotel !== undefined ? cleanHotel : existing.hotelNights,
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

                context.log(`Participation ${existing.id} updated for event ${cleanEventId}`);
                return { status: 200, jsonBody: updated };
            } else {
                const initialRoles = isAdmin ? [...new Set(Array.isArray(roles) ? roles : [])] : [];
                const invalidRoles = initialRoles.filter(role => !VALID_ROLES.includes(role));
                if (invalidRoles.length) {
                    return { status: 400, jsonBody: { error: `Invalid roles: ${invalidRoles.join(', ')}` } };
                }
                if (!resolvedEmail) {
                    return { status: 400, jsonBody: { error: 'A user or email is required' } };
                }
                const initialHotelPaidBy = initialRoles.includes('committee') || initialRoles.includes('judge')
                    ? 'committee' : null;

                const newParticipation = {
                    id: generateId(),
                    userId: requestedUserId || null,
                    email: resolvedEmail,
                    eventId: cleanEventId,
                    roles: initialRoles,
                    teamId: null,
                    isTeamAdmin: false,
                    hotelNights: cleanHotel || {},
                    hotelPaidBy: initialHotelPaidBy,
                    createdAt: now,
                    updatedAt: now
                };
                await participationsStorage.create(newParticipation);
                newParticipation.teamMemberships = [];

                context.log(`Participation ${newParticipation.id} created for event ${cleanEventId}`);
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await readJson(request);
            if (!body) return INVALID_JSON;

            const existing = await participationsStorage.getById(id);
            if (!existing) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const related = await participationsFor(auth.user.userId, existing.userId);
            if (!canManageUser(auth.user, existing.userId, related)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            if (!auth.user.isAdmin && Object.keys(body).some(key => key !== 'hotelNights')) {
                return { status: 403, jsonBody: { error: 'Only administrators can modify participation identity or membership fields' } };
            }

            const v = new Validator();
            const changes = {};
            const hotelNights = cleanHotelNights(body.hotelNights, v);
            if (hotelNights !== undefined) changes.hotelNights = hotelNights;
            if (body.teamId !== undefined) {
                changes.teamId = body.teamId === null ? null : v.guid(body.teamId, 'teamId');
            }
            if (body.isTeamAdmin !== undefined) {
                const flag = v.boolean(body.isTeamAdmin, 'isTeamAdmin');
                if (flag !== undefined) changes.isTeamAdmin = flag;
            }
            if (body.userId !== undefined) {
                changes.userId = body.userId === null ? null : v.guid(body.userId, 'userId');
            }
            if (body.email !== undefined) {
                const cleanEmail = v.email(body.email, 'email');
                if (cleanEmail) changes.email = cleanEmail;
            }
            if (v.failed) return v.failure();

            if (changes.teamId) {
                const team = await teamsStorage.getById(changes.teamId);
                if (!team) return { status: 404, jsonBody: { error: 'Team not found' } };
                if (!sameId(team.eventId, existing.eventId)) {
                    return { status: 400, jsonBody: { error: 'Team belongs to a different event' } };
                }
            }
            if (changes.userId && !(await usersStorage.getById(changes.userId))) {
                return { status: 404, jsonBody: { error: 'User not found' } };
            }

            changes.updatedAt = new Date().toISOString();
            await participationsStorage.update(id, changes);

            const updated = { ...existing, ...changes };
            updated.teamMemberships = buildLegacyTeamMemberships(updated);
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const participation = await participationsStorage.getById(id);

            if (!participation) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const related = await participationsFor(auth.user.userId, participation.userId);
            if (!canManageUser(auth.user, participation.userId, related)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to delete this participation' } };
            }

            const email = participation.email;
            const userId = participation.userId;
            const eventId = participation.eventId;

            await participationsStorage.delete(id);

            let cleaned = { invitations: 0, deliveries: 0 };

            try {
                const invToDelete = email ? await invitationsStorage.findBy({ email, eventId }) : [];
                for (const inv of invToDelete) await invitationsStorage.delete(inv.id);
                cleaned.invitations = invToDelete.length;
            } catch (e) { context.log(`Warning: invitation cleanup failed: ${e.message}`); }

            try {
                const delToDelete = [
                    ...(userId ? await deliveriesStorage.findBy({ userId }) : []),
                    ...(email ? await deliveriesStorage.findBy({ email }) : [])
                ];
                const seen = new Set();
                for (const d of delToDelete) {
                    const key = String(d.id).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    await deliveriesStorage.delete(d.id);
                    cleaned.deliveries++;
                }
            } catch (e) { context.log(`Warning: delivery cleanup failed: ${e.message}`); }

            context.log(`Deleted participation ${id}. Cleaned: ${cleaned.invitations} invitations, ${cleaned.deliveries} deliveries`);

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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await readJson(request);
            if (!body) return INVALID_JSON;
            const { add, remove, set, confirmCommitmentIncrease = false } = body;

            const participation = await participationsStorage.getById(id);
            if (!participation) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const related = await participationsFor(auth.user.userId, participation.userId);
            if (!canManageUser(auth.user, participation.userId, related)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            // Roles of a team member may only be changed by that team's administrator.
            const requestedTeamId = participation.teamId;
            if (!auth.user.isAdmin && requestedTeamId) {
                const team = await teamsStorage.getById(requestedTeamId);
                if (!team || !isTeamAuthorized(auth.user, team, related)) {
                    return { status: 403, jsonBody: { error: 'Only the team administrator can change team assignment' } };
                }
            }

            const requestedRoles = [...(Array.isArray(set) ? set : []), ...(Array.isArray(add) ? add : [])];
            const grantsPrivilegedRole = requestedRoles.some(r => ['judge', 'committee'].includes(r));
            if (grantsPrivilegedRole && !auth.user.isAdmin) {
                return { status: 403, jsonBody: { error: 'Only admins can grant judge or committee roles' } };
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
                    confirmCommitmentIncrease
                );
                if (capacityError) return capacityError;
            }

            participation.roles = roles;
            participation.updatedAt = new Date().toISOString();

            participation.teamMemberships = buildLegacyTeamMemberships(participation);
            await participationsStorage.update(id, {
                roles: participation.roles,
                updatedAt: participation.updatedAt
            });

            const addedActionableRole = Array.isArray(add) && add.some(r => ['participant', 'judge', 'committee'].includes(r));
            if (addedActionableRole && participation.userId) {
                await triggerSequenceEmails(participation.userId, participation.eventId, context);
            }

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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await readJson(request);
            if (!body) return INVALID_JSON;
            const { teamId, isTeamAdmin, isParticipant = true, confirmCommitmentIncrease = false } = body;

            const participation = await participationsStorage.getById(id);
            if (!participation) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const related = await participationsFor(auth.user.userId, participation.userId);
            if (!canManageUser(auth.user, participation.userId, related)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            const assignedTeamId = teamId || participation.teamId;
            if (!auth.user.isAdmin && assignedTeamId) {
                const team = await teamsStorage.getById(assignedTeamId);
                if (!team || !isTeamAuthorized(auth.user, team, related)) {
                    return { status: 403, jsonBody: { error: 'Only the team administrator can change team assignment' } };
                }
            }

            if (teamId) {
                if (!isGuid(teamId)) {
                    return { status: 400, jsonBody: { error: 'Invalid team ID' } };
                }
                const team = await teamsStorage.getById(teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }
                if (!sameId(team.eventId, participation.eventId)) {
                    return { status: 400, jsonBody: { error: 'Team belongs to a different event' } };
                }

                if (!participation.roles) participation.roles = [];
                if (isParticipant) {
                    const capacityError = await enforceParticipantCapacity(
                        participation, teamId, confirmCommitmentIncrease
                    );
                    if (capacityError) return capacityError;
                    if (!participation.roles.includes('participant')) participation.roles.push('participant');
                } else {
                    participation.roles = participation.roles.filter(role => role !== 'participant');
                }
            }

            participation.teamId = teamId || null;
            participation.isTeamAdmin = !!isTeamAdmin;
            participation.updatedAt = new Date().toISOString();

            participation.teamMemberships = buildLegacyTeamMemberships(participation);
            await participationsStorage.update(id, {
                teamId: participation.teamId,
                isTeamAdmin: participation.isTeamAdmin,
                roles: participation.roles,
                updatedAt: participation.updatedAt
            });

            if (teamId && participation.userId) {
                await leaveSoloQueue(participation.userId, participation.eventId, context);
                await triggerSequenceEmails(participation.userId, participation.eventId, context);
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await readJson(request);
            if (!body) return INVALID_JSON;
            const { hotelNights, profileVerification } = body;

            const participation = await participationsStorage.getById(id);
            if (!participation) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const hotelParticipations = await participationsFor(auth.user.userId, participation.userId);
            if (!canManageUser(auth.user, participation.userId, hotelParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            const v = new Validator();
            const cleanNights = cleanHotelNights(hotelNights, v);
            if (profileVerification !== undefined && typeof profileVerification !== 'boolean') {
                v.errors.push('profileVerification must be true or false');
            }
            if (v.failed) return v.failure();

            const updatedAt = new Date().toISOString();
            const changes = { updatedAt };

            if (cleanNights !== undefined) changes.hotelNights = cleanNights;
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const role = request.query.get('role');

            let results = await participationsStorage.findBy({ eventId });

            results.forEach(p => {
                if (!p.roles) p.roles = migrateRoles(p);
                if (!p.teamMemberships) p.teamMemberships = buildLegacyTeamMemberships(p);
            });

            if (role) {
                results = results.filter(p => p.roles.includes(role));
            }

            const isStaff = await isEventStaff(auth.user, eventId);

            if (isStaff) {
                // Staff (judges, committee, admins) run the event: they get each person's name and
                // contact details with the roster, so judges need no access to the global people list.
                const userIds = [...new Set(results.map(p => p.userId).filter(Boolean))];
                const people = userIds.length ? await usersStorage.findBy({ id: userIds }) : [];
                results = results.map(p => {
                    const person = people.find(u => sameId(u.id, p.userId));
                    if (!person) return p;
                    return {
                        ...p,
                        email: person.email || p.email,
                        firstName: person.firstName,
                        lastName: person.lastName,
                        phone: person.phone,
                        allergies: person.allergies
                    };
                });
            } else {
                const callerTeamIds = new Set(
                    results
                        .filter(p => sameId(p.userId, auth.user.userId))
                        .flatMap(p => (p.teamMemberships || []).map(m => String(m.teamId).toLowerCase()))
                );
                // Regular participants only get membership data, never other people's contact or hotel details.
                // Teammates also see hotel nights and whether each member has confirmed their details
                // (without that flag every teammate showed "Confirm information").
                results = results.map(p => {
                    const sharesTeam = (p.teamMemberships || []).some(m => callerTeamIds.has(String(m.teamId).toLowerCase()));
                    return {
                        id: p.id,
                        userId: p.userId,
                        eventId: p.eventId,
                        teamId: p.teamId,
                        isTeamAdmin: p.isTeamAdmin,
                        roles: p.roles,
                        teamMemberships: p.teamMemberships,
                        ...(sharesTeam ? { hotelNights: p.hotelNights, profileVerification: p.profileVerification } : {})
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const email = decodeURIComponent(request.params.email);

            const isSelf = auth.user.email && email.toLowerCase() === auth.user.email.toLowerCase();
            if (!isSelf && !auth.user.isAdmin) {
                return { status: 403, jsonBody: { error: 'You do not have permission to view these participations' } };
            }

            const personParticipations = await participationsStorage.findBy({ email });

            const user = await usersStorage.findOneBy({ email });
            if (user) {
                for (const p of await participationsStorage.findBy({ userId: user.id })) {
                    if (!personParticipations.find(pp => sameId(pp.id, p.id))) {
                        personParticipations.push(p);
                    }
                }
            }

            personParticipations.forEach(p => {
                if (!p.roles) p.roles = migrateRoles(p);
            });

            const eventIds = [...new Set(personParticipations.map(p => p.eventId).filter(Boolean))];
            const events = eventIds.length > 0 ? await eventsStorage.findBy({ id: eventIds }) : [];
            const enriched = personParticipations.map(p => ({
                ...p,
                eventName: events.find(e => sameId(e.id, p.eventId))?.name || 'Unknown Event'
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const teamId = request.params.teamId;
            const team = await teamsStorage.getById(teamId);
            if (!team) {
                return { status: 404, jsonBody: { error: 'Team not found' } };
            }

            // Team members and event staff only.
            const own = await participationsStorage.findBy({ userId: auth.user.userId, eventId: team.eventId });
            const allowed = isTeamMember(auth.user, teamId, own)
                || hasEventRole(auth.user, team.eventId, 'judge', own)
                || hasEventRole(auth.user, team.eventId, 'committee', own);
            if (!allowed) {
                return { status: 403, jsonBody: { error: 'You do not have permission to view this team' } };
            }

            const members = await participationsStorage.findBy({ teamId });
            let adminCount = 0;
            let participantCount = 0;
            for (const p of members) {
                if (p.roles?.includes('participant')) {
                    participantCount++;
                    if (p.isTeamAdmin) adminCount++;
                } else if (p.isTeamAdmin) {
                    adminCount++;
                }
            }

            const event = await eventsStorage.getById(team.eventId);
            const maxParticipants = event?.maxTeamSize || 5;

            return {
                status: 200,
                jsonBody: { teamId, adminCount, participantCount, maxParticipants }
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const teamId = request.params.teamId;
            const body = await readJson(request);
            if (!body) return INVALID_JSON;
            const { isAdmin, isParticipant, confirmCommitmentIncrease = false } = body;

            const participation = await participationsStorage.getById(id);
            if (!participation) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const related = await participationsFor(auth.user.userId, participation.userId);
            if (!canManageUser(auth.user, participation.userId, related)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this participation' } };
            }

            const team = await teamsStorage.getById(teamId);
            if (!team || (!auth.user.isAdmin && !isTeamAuthorized(auth.user, team, related))) {
                return { status: 403, jsonBody: { error: 'Only the team administrator can change team roles' } };
            }
            if (!sameId(team.eventId, participation.eventId)) {
                return { status: 400, jsonBody: { error: 'Team belongs to a different event' } };
            }

            if (isParticipant && !participation.roles?.includes('participant')) {
                if (participation.teamId && !sameId(participation.teamId, teamId)) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Already a participant on another team', existingTeamId: participation.teamId }
                    };
                }

                const capacityError = await enforceParticipantCapacity(
                    participation, teamId, confirmCommitmentIncrease
                );
                if (capacityError) return capacityError;
            }

            participation.teamId = teamId;
            participation.isTeamAdmin = !!isAdmin;
            if (!participation.roles) participation.roles = [];
            if (isParticipant && !participation.roles.includes('participant')) {
                participation.roles.push('participant');
            } else if (!isParticipant) {
                participation.roles = participation.roles.filter(r => r !== 'participant');
            }

            participation.updatedAt = new Date().toISOString();
            await participationsStorage.update(id, {
                teamId: participation.teamId,
                isTeamAdmin: participation.isTeamAdmin,
                roles: participation.roles,
                updatedAt: participation.updatedAt
            });
            participation.teamMemberships = buildLegacyTeamMemberships(participation);

            context.log(`Team roles updated for participation ${id}, team ${teamId}`);
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
    if (participation.teamId) {
        return [{
            teamId: participation.teamId,
            isAdmin: participation.isTeamAdmin || false,
            isParticipant: participation.roles?.includes('participant') || false
        }];
    }

    return [];
}
