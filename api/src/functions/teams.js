const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, isTeamAuthorized, isTeamMember } = require('../shared/auth');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const { sendWelcomeEmail } = require('../shared/welcome-email');

const eventsStorage = new GenericStorage('events');
const soloQueueStorage = new GenericStorage('solo-queue');
const participationsStorage = new GenericStorage('participations');

function isActiveStatus(status) {
    return status === 'pre-registration' || status === 'registration' || status === 'live';
}

async function getActiveEventId() {
    const events = await eventsStorage.getAll();
    const activeEvent = events.find(e => isActiveStatus(e.status));
    return activeEvent ? activeEvent.id : null;
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

            let teams = await Storage.teams.getAll();

            if (eventId) {
                teams = teams.filter(t => t.eventId === eventId);
            }

            if (!auth.user.isPortalAdmin) {
                const participations = await new GenericStorage('participations').getAll();
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

            const participations = await new GenericStorage('participations').getAll();
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

            const teamData = await request.json();

            if (!teamData.teamName) {
                return {
                    status: 400,
                    jsonBody: { message: 'Team name is required' }
                };
            }

            if (!teamData.committedParticipants) {
                return {
                    status: 400,
                    jsonBody: { message: 'Committed participants is required' }
                };
            }

            const teamId = uuidv4();

            const eventId = teamData.eventId || await getActiveEventId();

            const adminEmail = teamData.adminEmail;

            const newTeam = {
                id: teamId,
                eventId: eventId,
                teamName: teamData.teamName,
                numberOfParticipants: teamData.committedParticipants,
                adminUserId: auth.user.userId,
                createdAt: new Date().toISOString()
            };

            const savedTeam = await Storage.teams.create(newTeam);
            try {
                const creatorParticipates = teamData.creatorParticipates !== false;
                const participations = await participationsStorage.getAll();
                const participation = participations.find(item =>
                    item.userId === auth.user.userId && item.eventId === eventId
                );

                if (!participation) {
                    throw new Error('Participation not found for team creator');
                }

                const roles = (participation.roles || []).filter(role => role !== 'participant');
                if (creatorParticipates) roles.push('participant');

                await participationsStorage.update(participation.id, {
                    teamId,
                    isTeamAdmin: true,
                    roles,
                    profileVerification: true,
                    updatedAt: new Date().toISOString()
                });
            } catch (assignmentError) {
                await Storage.teams.delete(teamId);
                throw assignmentError;
            }

            if (auth.user.userId && newTeam.eventId) {
                try {
                    const queue = await soloQueueStorage.getAll();
                    const entry = queue.find(q => q.userId === auth.user.userId && q.eventId === newTeam.eventId);
                    if (entry) {
                        await soloQueueStorage.delete(entry.id);
                        context.log(`Removed ${auth.user.userId} from solo queue after team creation`);
                    }
                } catch (e) {
                    context.log(`Warning: could not remove user from solo queue: ${e.message}`);
                }
            }

            context.log(`Team created and assigned to creator: ${newTeam.teamName}`);
            return {
                status: 201,
                jsonBody: savedTeam
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
            const updateData = await request.json();

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

            const participations = await new GenericStorage('participations').getAll();
            if (!isTeamAuthorized(auth.user, team, participations)) {
                return {
                    status: 403,
                    jsonBody: { message: 'You do not have permission to modify this team' }
                };
            }

            const allowedFields = ['teamName', 'numberOfParticipants', 'committedParticipants', 'presentationFile', 'deliveryVideo'];
            for (const field of allowedFields) {
                if (updateData[field] !== undefined) {
                    team[field] = updateData[field];
                }
            }
            team.updatedAt = new Date().toISOString();

            const updatedTeam = await Storage.teams.update(teamId, team);

            context.log(`Team updated: ${team.teamName}`);
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

            const participationsStorage = new GenericStorage('participations');
            const allParticipations = await participationsStorage.getAll();

            if (!isTeamAuthorized(auth.user, team, allParticipations)) {
                return {
                    status: 403,
                    jsonBody: { message: 'You do not have permission to delete this team' }
                };
            }
            let participationsChanged = 0;
            const noRemainingTeamEmails = [];

            for (const p of allParticipations) {
                const memberships = p.teamMemberships || [];
                const hadMembership = memberships.some(m => m.teamId === teamId) || p.teamId === teamId;

                if (hadMembership) {
                    p.teamMemberships = memberships.filter(m => m.teamId !== teamId);

                    if (p.teamId === teamId) {
                        p.teamId = null;
                        p.isTeamAdmin = false;
                    }

                    const hasOtherTeams = p.teamMemberships.some(m => m.isParticipant);
                    const roles = p.roles || [];
                    const hasNonParticipantRole = roles.some(r => r !== 'participant');

                    if (!hasOtherTeams) {
                        if (hasNonParticipantRole) {
                            p.hotelPaidBy = 'committee';
                            context.log(`Hotel payer reverted to committee for ${p.email}`);
                        } else {
                            p.hotelPaidBy = null;
                            p.hotelNights = {};
                            context.log(`Cleared hotel for ${p.email} (no remaining teams)`);
                            if (p.email) noRemainingTeamEmails.push(p.email.toLowerCase());
                        }
                    }

                    p.updatedAt = new Date().toISOString();
                    await participationsStorage.update(p.id, {
                        teamId: p.teamId,
                        isTeamAdmin: p.isTeamAdmin,
                        hotelPaidBy: p.hotelPaidBy,
                        hotelNights: p.hotelNights,
                        updatedAt: p.updatedAt
                    });
                    participationsChanged++;
                }
            }

            if (participationsChanged > 0) {
                context.log(`Cleaned ${participationsChanged} participation(s) for team ${teamId}`);
            }

            let deliveriesRemoved = 0;
            if (noRemainingTeamEmails.length > 0) {
                const deliveriesStorage = new GenericStorage('email-deliveries');
                const allDeliveries = await deliveriesStorage.getAll();
                const removedDeliveries = allDeliveries.filter(d =>
                    d.email && noRemainingTeamEmails.includes(d.email.toLowerCase())
                );
                deliveriesRemoved = removedDeliveries.length;
                for (const d of removedDeliveries) {
                    await deliveriesStorage.delete(d.id);
                }
                if (deliveriesRemoved > 0) {
                    context.log(`Removed ${deliveriesRemoved} orphaned delivery record(s) for team ${teamId}`);
                }
            }

            const badgeClaimsStorage = new GenericStorage('badge-claims');
            const allClaims = await badgeClaimsStorage.getAll();
            const removedClaims = allClaims.filter(c => c.teamId === teamId);
            const claimsRemoved = removedClaims.length;

            for (const c of removedClaims) {
                await badgeClaimsStorage.delete(c.id);
            }
            if (claimsRemoved > 0) {
                context.log(`Removed ${claimsRemoved} badge claim(s) for team ${teamId}`);
            }

            const invitationsStorage = new GenericStorage('invitations');
            const allInvitations = await invitationsStorage.getAll();
            const removedInvitations = allInvitations.filter(i => i.teamId === teamId);
            const invitationsRemoved = removedInvitations.length;

            for (const inv of removedInvitations) {
                await invitationsStorage.delete(inv.id);
            }
            if (invitationsRemoved > 0) {
                context.log(`Removed ${invitationsRemoved} invitation(s) for team ${teamId}`);
            }

            const deleted = await Storage.teams.delete(teamId);

            if (!deleted) {
                return {
                    status: 500,
                    jsonBody: { message: 'Failed to delete team' }
                };
            }

            context.log(`Team deleted: ${team.teamName} (${teamId})`);
            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: `Team "${team.teamName}" deleted`,
                    cleanup: {
                        participationsUpdated: participationsChanged,
                        badgeClaimsRemoved: claimsRemoved,
                        invitationsRemoved: invitationsRemoved,
                        deliveriesRemoved: deliveriesRemoved
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

            const participations = await new GenericStorage('participations').getAll();
            if (!isTeamMember(auth.user, teamId, participations)) {
                return {
                    status: 403,
                    jsonBody: { message: 'You do not have permission to view this team\'s members' }
                };
            }

            const members = await Storage.users.getByTeamId(teamId);

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
