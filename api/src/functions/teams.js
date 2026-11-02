const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, isTeamAuthorized, isTeamMember } = require('../shared/auth');
const { generateId, isGuid, sameId } = require('../shared/id');
const Storage = require('../shared/storage');
const { Storage: GenericStorage, withTransaction } = require('../shared/storage');
const SharePointStorage = require('../shared/sharepoint');
const { Validator, readJson, INVALID_JSON } = require('../shared/validate');

const eventsStorage = new GenericStorage('events');
const soloQueueStorage = new GenericStorage('solo-queue');
const participationsStorage = new GenericStorage('participations');
const usersStorage = new GenericStorage('users');
const badgeClaimsStorage = new GenericStorage('badge-claims');
const invitationsStorage = new GenericStorage('invitations');
const deliveriesStorage = new GenericStorage('email-deliveries');

function isActiveStatus(status) {
    return status === 'pre-registration' || status === 'registration' || status === 'live';
}

// Deterministic default: the active event that starts first (ties broken by id).
async function getDefaultEventId() {
    const events = (await eventsStorage.getAll()).filter(e => isActiveStatus(e.status));
    events.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || String(a.id).localeCompare(String(b.id)));
    return events.length > 0 ? events[0].id : null;
}

function teamSizeBounds(event) {
    const min = Number.isInteger(event?.minTeamSize) && event.minTeamSize > 0 ? event.minTeamSize : 1;
    const max = Number.isInteger(event?.maxTeamSize) && event.maxTeamSize >= min ? event.maxTeamSize : Math.max(min, 5);
    return { min, max };
}

async function participantCount(teamId) {
    const members = await participationsStorage.findBy({ teamId });
    return members.filter(p => (p.roles || []).includes('participant')).length;
}

// Trimmed 2-100 character name, unique (case-insensitively) within the event.
async function validateTeamName(v, rawName, eventId, excludeTeamId = null) {
    const name = v.string(rawName, 'teamName', { min: 2, max: 100, required: true });
    if (name === undefined || name === null) return { name: undefined };
    const clash = await Storage.teams.getByNameInEvent(name, eventId);
    if (clash && !sameId(clash.id, excludeTeamId)) {
        return { name, conflict: { status: 409, jsonBody: { message: 'A team with that name already exists for this event' } } };
    }
    return { name };
}

function memberProjection(user, participation, full) {
    const base = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        gamertag: user.gamertag ?? null,
        profileComplete: !!user.profileComplete,
        participationId: participation?.id ?? null,
        isTeamAdmin: !!participation?.isTeamAdmin,
        roles: participation?.roles || [],
        profileVerification: !!participation?.profileVerification
    };
    return full ? { ...base, phone: user.phone ?? null, allergies: user.allergies ?? null } : base;
}

app.http('teams-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'teams',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const eventId = request.query.get('eventId');
            if (eventId && !isGuid(eventId)) {
                return { status: 400, jsonBody: { message: 'Invalid event ID' } };
            }

            let teams = eventId ? await Storage.teams.findByEvent(eventId) : await Storage.teams.getAll();

            if (!auth.user.isPortalAdmin) {
                const participations = await participationsStorage.findBy({ userId: auth.user.userId });
                teams = teams.filter(t => isTeamMember(auth.user, t.id, participations));
            }

            return {
                status: 200,
                jsonBody: teams
            };

        } catch (error) {
            await logError(context, error);
            context.error('Teams LIST error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

app.http('teams-get', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'teams/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const teamId = request.params.id;

            if (!teamId) {
                return {
                    status: 400,
                    jsonBody: { message: 'Team ID required' }
                };
            }

            const team = await Storage.teams.getById(teamId);

            if (!team) {
                return {
                    status: 404,
                    jsonBody: { message: 'Team not found' }
                };
            }

            const participations = await participationsStorage.findBy({ userId: auth.user.userId });
            if (!isTeamMember(auth.user, teamId, participations)) {
                return {
                    status: 403,
                    jsonBody: { message: 'You do not have permission to view this team' }
                };
            }

            return {
                status: 200,
                jsonBody: team
            };

        } catch (error) {
            await logError(context, error);
            context.error('Teams GET error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

app.http('teams-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'teams',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const teamData = await readJson(request);
            if (!teamData) return INVALID_JSON;

            if (!teamData.teamName) {
                return {
                    status: 400,
                    jsonBody: { message: 'Team name is required' }
                };
            }

            const sizeRaw = teamData.committedParticipants ?? teamData.numberOfParticipants;
            if (sizeRaw === undefined || sizeRaw === null || sizeRaw === '') {
                return {
                    status: 400,
                    jsonBody: { message: 'Committed participants is required' }
                };
            }

            if (!auth.user.userId) {
                return { status: 400, jsonBody: { message: 'Complete your registration before creating a team' } };
            }

            const v = new Validator();
            const eventId = teamData.eventId ? v.guid(teamData.eventId, 'eventId') : await getDefaultEventId();
            if (v.failed) return v.failure();
            if (!eventId) {
                return { status: 400, jsonBody: { message: 'No event is open for team registration' } };
            }

            const event = await Storage.events.getById(eventId);
            if (!event) {
                return { status: 404, jsonBody: { message: 'Event not found' } };
            }
            if (!isActiveStatus(event.status)) {
                return { status: 400, jsonBody: { message: 'This event is not open for team registration' } };
            }

            const { min, max } = teamSizeBounds(event);
            const numberOfParticipants = v.integer(sizeRaw, 'numberOfParticipants', { min, max, required: true });
            const { name: teamName, conflict } = await validateTeamName(v, teamData.teamName, eventId);
            if (v.failed) return v.failure();
            if (conflict) return conflict;

            const creatorParticipates = teamData.creatorParticipates !== false;

            const result = await withTransaction(async () => {
                const participation = await participationsStorage.findOneBy({ userId: auth.user.userId, eventId });
                if (!participation) {
                    return { error: { status: 400, jsonBody: { message: 'Participation not found for team creator' } } };
                }
                if (participation.teamId) {
                    return { error: { status: 400, jsonBody: { message: 'You are already on a team for this event' } } };
                }
                if (await Storage.teams.getByNameInEvent(teamName, eventId)) {
                    return { error: { status: 409, jsonBody: { message: 'A team with that name already exists for this event' } } };
                }

                const now = new Date().toISOString();
                const teamId = generateId();
                const newTeam = {
                    id: teamId,
                    eventId: eventId,
                    teamName,
                    numberOfParticipants,
                    adminUserId: auth.user.userId,
                    createdAt: now,
                    updatedAt: now
                };
                await Storage.teams.create(newTeam);

                const roles = (participation.roles || []).filter(role => role !== 'participant');
                if (creatorParticipates) roles.push('participant');

                await participationsStorage.update(participation.id, {
                    teamId,
                    isTeamAdmin: true,
                    roles,
                    profileVerification: true,
                    updatedAt: now
                });

                for (const entry of await soloQueueStorage.findBy({ userId: auth.user.userId, eventId })) {
                    await soloQueueStorage.delete(entry.id);
                }

                return { team: newTeam };
            });

            if (result.error) return result.error;

            context.log(`Team created and assigned to creator: ${result.team.id}`);
            return {
                status: 201,
                jsonBody: result.team
            };

        } catch (error) {
            await logError(context, error);
            context.error('Teams POST error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

app.http('teams-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'teams/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const teamId = request.params.id;

            if (!teamId) {
                return {
                    status: 400,
                    jsonBody: { message: 'Team ID required' }
                };
            }

            const team = await Storage.teams.getById(teamId);

            if (!team) {
                return {
                    status: 404,
                    jsonBody: { message: 'Team not found' }
                };
            }

            const updateData = await readJson(request);
            if (!updateData) return INVALID_JSON;

            const participations = await participationsStorage.findBy({ userId: auth.user.userId });
            if (!isTeamAuthorized(auth.user, team, participations)) {
                return {
                    status: 403,
                    jsonBody: { message: 'You do not have permission to modify this team' }
                };
            }

            const v = new Validator();
            const updates = {};

            if (updateData.teamName !== undefined) {
                const { name, conflict } = await validateTeamName(v, updateData.teamName, team.eventId, teamId);
                if (conflict) return conflict;
                if (name) updates.teamName = name;
            }

            // Team size lives in NumberOfParticipants; committedParticipants is the UI's alias for it.
            const sizeRaw = updateData.numberOfParticipants ?? updateData.committedParticipants;
            if (sizeRaw !== undefined) {
                const event = await Storage.events.getById(team.eventId);
                const { min, max } = teamSizeBounds(event);
                const size = v.integer(sizeRaw, 'numberOfParticipants', { min, max });
                if (size !== undefined) {
                    const current = await participantCount(teamId);
                    if (size < current) {
                        return { status: 400, jsonBody: { message: `Team size cannot be lower than the current ${current} participants` } };
                    }
                    updates.numberOfParticipants = size;
                }
            }

            if (v.failed) return v.failure();

            if (Object.keys(updates).length === 0) {
                return { status: 200, jsonBody: team };
            }

            updates.updatedAt = new Date().toISOString();
            const updatedTeam = await Storage.teams.update(teamId, updates);

            context.log(`Team updated: ${teamId}`);
            return {
                status: 200,
                jsonBody: updatedTeam
            };

        } catch (error) {
            await logError(context, error);
            context.error('Teams UPDATE error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

app.http('teams-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'teams/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const teamId = request.params.id;

            if (!teamId) {
                return {
                    status: 400,
                    jsonBody: { message: 'Team ID required' }
                };
            }

            const team = await Storage.teams.getById(teamId);

            if (!team) {
                return {
                    status: 404,
                    jsonBody: { message: 'Team not found' }
                };
            }

            if (!auth.user.isPortalAdmin) {
                return {
                    status: 403,
                    jsonBody: { message: 'Only portal administrators can delete teams' }
                };
            }

            if (!SharePointStorage.isConfigured()) {
                return {
                    status: 503,
                    jsonBody: { message: 'Team file storage is not configured; team deletion was not completed' }
                };
            }

            const eventFolder = team.eventId ? `Events/${team.eventId}/${teamId}` : null;
            if (eventFolder) {
                await SharePointStorage.deleteFolder(eventFolder);
            }

            const result = await withTransaction(async () => {
                const now = new Date().toISOString();
                let participationsChanged = 0;
                const noRemainingTeamEmails = [];

                for (const p of await participationsStorage.findBy({ teamId })) {
                    const roles = p.roles || [];
                    const hasNonParticipantRole = roles.some(r => r !== 'participant');
                    const changes = { teamId: null, isTeamAdmin: false, updatedAt: now };

                    if (hasNonParticipantRole) {
                        changes.hotelPaidBy = 'committee';
                        context.log(`Hotel payer reverted to committee for participation ${p.id}`);
                    } else {
                        changes.hotelPaidBy = null;
                        changes.hotelNights = {};
                        if (p.email) noRemainingTeamEmails.push(p.email.toLowerCase());
                    }

                    await participationsStorage.update(p.id, changes);
                    participationsChanged++;
                }

                let usersUpdated = 0;
                for (const user of await usersStorage.findBy({ teamId })) {
                    await usersStorage.update(user.id, { teamId: null, updatedAt: now });
                    usersUpdated++;
                }

                let deliveriesRemoved = 0;
                if (noRemainingTeamEmails.length > 0) {
                    for (const d of await deliveriesStorage.findBy({ email: noRemainingTeamEmails })) {
                        await deliveriesStorage.delete(d.id);
                        deliveriesRemoved++;
                    }
                }

                let claimsRemoved = 0;
                for (const c of await badgeClaimsStorage.findBy({ teamId })) {
                    await badgeClaimsStorage.delete(c.id);
                    claimsRemoved++;
                }

                let invitationsRemoved = 0;
                for (const inv of await invitationsStorage.findBy({ teamId })) {
                    await invitationsStorage.delete(inv.id);
                    invitationsRemoved++;
                }

                const deleted = await Storage.teams.delete(teamId);
                return { deleted, participationsChanged, usersUpdated, deliveriesRemoved, claimsRemoved, invitationsRemoved };
            });

            if (!result.deleted) {
                return {
                    status: 500,
                    jsonBody: { message: 'Failed to delete team' }
                };
            }

            context.log(`Team deleted: ${teamId}`);
            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: `Team "${team.teamName}" deleted`,
                    cleanup: {
                        participationsUpdated: result.participationsChanged,
                        usersUpdated: result.usersUpdated,
                        badgeClaimsRemoved: result.claimsRemoved,
                        invitationsRemoved: result.invitationsRemoved,
                        deliveriesRemoved: result.deliveriesRemoved
                    }
                }
            };

        } catch (error) {
            await logError(context, error);
            context.error('Teams DELETE error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

app.http('teams-members', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'teams/{id}/members',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const teamId = request.params.id;

            if (!teamId) {
                return {
                    status: 400,
                    jsonBody: { message: 'Team ID required' }
                };
            }

            const team = await Storage.teams.getById(teamId);

            if (!team) {
                return {
                    status: 404,
                    jsonBody: { message: 'Team not found' }
                };
            }

            const participations = await participationsStorage.findBy({ userId: auth.user.userId });
            if (!isTeamMember(auth.user, teamId, participations)) {
                return {
                    status: 403,
                    jsonBody: { message: 'You do not have permission to view this team\'s members' }
                };
            }

            // Membership lives in Participations; the legacy Users.TeamId column is never set.
            const memberParticipations = await participationsStorage.findBy({ teamId });
            const userIds = [...new Set(memberParticipations.map(p => p.userId).filter(Boolean))];
            const users = userIds.length > 0 ? await Storage.users.getByIds(userIds) : [];
            const full = isTeamAuthorized(auth.user, team, participations);
            const members = users.map(user => memberProjection(user, memberParticipations.find(p => sameId(p.userId, user.id)), full));

            return {
                status: 200,
                jsonBody: members
            };

        } catch (error) {
            await logError(context, error);
            context.error('Teams members GET error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
