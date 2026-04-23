// Teams API - Get team info and members
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const { sendTeamRegistrationEmail } = require('../shared/team-registration');
const { sendInterestAcknowledgmentEmail } = require('../shared/interest-acknowledgment');

const eventsStorage = new GenericStorage('events');
const soloQueueStorage = new GenericStorage('solo-queue');

// Helper to check if event status means it's active (visible to public)
function isActiveStatus(status) {
    return status === 'pre-registration' || status === 'registration' || status === 'live';
}

// Helper to get active event ID
async function getActiveEventId() {
    const events = await eventsStorage.getAll();
    const activeEvent = events.find(e => isActiveStatus(e.status));
    return activeEvent ? activeEvent.id : null;
}

// List all teams (optionally filtered by eventId)
app.http('teams-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'teams',
    handler: async (request, context) => {
        try {
            const eventId = request.query.get('eventId');
            
            let teams = await Storage.teams.getAll();
            
            // Filter by eventId if provided
            if (eventId) {
                teams = teams.filter(t => t.eventId === eventId);
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

// Get team by ID
app.http('teams-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'teams/{id}',
    handler: async (request, context) => {
        try {
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

// Create team
app.http('teams-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'teams',
    handler: async (request, context) => {
        try {
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
            
            // Generate team ID
            const teamId = uuidv4();

            // Get active event ID
            const eventId = teamData.eventId || await getActiveEventId();

            // Extract adminEmail separately — not a DB column, used only for email sending
            const adminEmail = teamData.adminEmail;

            const newTeam = {
                id: teamId,
                eventId: eventId,
                teamName: teamData.teamName,
                numberOfParticipants: teamData.committedParticipants,
                adminUserId: teamData.adminUserId,
                createdAt: new Date().toISOString()
            };

            // Save team
            const savedTeam = await Storage.teams.create(newTeam);

            // Send registration confirmation email to team admin (async, don't wait)
            if (adminEmail && newTeam.eventId) {
                sendTeamRegistrationEmail(adminEmail, newTeam.eventId, newTeam.teamName, newTeam.numberOfParticipants, context)
                    .then(result => {
                        if (result.success) {
                            context.log(`Team registration email sent to ${adminEmail}`);
                        }
                    })
                    .catch(error => {
                        context.error(`Failed to send team registration email to ${adminEmail}:`, error);
                    });

                // Send interest acknowledgment email if member was a verified interest lead
                sendInterestAcknowledgmentEmail(adminEmail, newTeam.eventId, context)
                    .then(result => {
                        if (result.success) {
                            context.log(`Interest acknowledgment email sent to ${adminEmail}`);
                        }
                    })
                    .catch(error => {
                        context.error(`Failed to send interest acknowledgment email to ${adminEmail}:`, error);
                    });
            }
            
            // Auto-remove creator from solo queue for this event (if they were in it)
            if (teamData.adminUserId && newTeam.eventId) {
                try {
                    const queue = await soloQueueStorage.getAll();
                    const entry = queue.find(q => q.userId === teamData.adminUserId && q.eventId === newTeam.eventId);
                    if (entry) {
                        await soloQueueStorage.delete(entry.id);
                        context.log(`Removed ${teamData.adminUserId} from solo queue after team creation`);
                    }
                } catch (e) {
                    context.log(`Warning: could not remove user from solo queue: ${e.message}`);
                }
            }

            context.log(`Team created: ${newTeam.teamName}`);
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

// Update team
app.http('teams-update', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'teams/{id}',
    handler: async (request, context) => {
        try {
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
            
            // Update allowed fields
            const allowedFields = ['teamName', 'numberOfParticipants', 'committedParticipants', 'presentationFile', 'deliveryVideo'];
            for (const field of allowedFields) {
                if (updateData[field] !== undefined) {
                    team[field] = updateData[field];
                }
            }
            team.updatedAt = new Date().toISOString();
            
            // Save updated team
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

// Delete team (cascade: clean up participations, badge claims, invitations)
app.http('teams-delete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'teams/{id}',
    handler: async (request, context) => {
        try {
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

            // --- Cascade cleanup ---

            // 1. Clean up participations: remove teamMembership entries for this team
            const participationsStorage = new GenericStorage('participations');
            const allParticipations = await participationsStorage.getAll();
            let participationsChanged = 0;
            const noRemainingTeamEmails = []; // emails of participants who end up with no team

            for (const p of allParticipations) {
                const memberships = p.teamMemberships || [];
                const hadMembership = memberships.some(m => m.teamId === teamId) || p.teamId === teamId;
                
                if (hadMembership) {
                    // Remove membership for this team
                    p.teamMemberships = memberships.filter(m => m.teamId !== teamId);
                    
                    // Clear legacy teamId/isTeamAdmin if they reference this team
                    if (p.teamId === teamId) {
                        p.teamId = null;
                        p.isTeamAdmin = false;
                    }
                    
                    // Update hotelPaidBy and hotel nights based on remaining roles
                    const hasOtherTeams = p.teamMemberships.some(m => m.isParticipant);
                    const roles = p.roles || [];
                    const hasNonParticipantRole = roles.some(r => r !== 'participant');
                    
                    if (!hasOtherTeams) {
                        if (hasNonParticipantRole) {
                            // Revert to committee/judge paying
                            p.hotelPaidBy = 'committee';
                            context.log(`Hotel payer reverted to committee for ${p.email}`);
                        } else {
                            // Pure participant with no team — clear everything and mark
                            // their email so we can clean up sequence deliveries below.
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

            // 1b. Remove EmailDeliveries for pure participants who have no remaining team.
            // These records are orphaned — the person is no longer a participant of any
            // team for this event so the "sent" status in the sequence overview is stale.
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

            // 2. Delete badge claims that belong to this team
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

            // 3. Cancel/remove pending invitations for this team
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

            // 4. Delete the team itself
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

// Get team members
app.http('teams-members', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'teams/{id}/members',
    handler: async (request, context) => {
        try {
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
