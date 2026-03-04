// Teams API - Get team info and members
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const { sendTeamRegistrationEmail } = require('../shared/team-registration');
const { sendInterestAcknowledgmentEmail } = require('../shared/interest-acknowledgment');

const eventsStorage = new GenericStorage('events');

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
            
            let teams = Storage.teams.getAll();
            
            // Filter by eventId if provided
            if (eventId) {
                teams = teams.filter(t => t.eventId === eventId);
            }
            
            return {
                status: 200,
                jsonBody: teams
            };
            
        } catch (error) {
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
            
            const team = Storage.teams.getById(teamId);
            
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
            
            const newTeam = {
                id: teamId,
                eventId: eventId,
                teamName: teamData.teamName,
                committedParticipants: teamData.committedParticipants,
                adminEmail: teamData.adminEmail,
                adminUserId: teamData.adminUserId,
                createdAt: new Date().toISOString()
            };
            
            // Save team
            const savedTeam = Storage.teams.create(newTeam);
            
            // Send registration confirmation email to team admin (async, don't wait)
            if (newTeam.adminEmail && newTeam.eventId) {
                sendTeamRegistrationEmail(newTeam.adminEmail, newTeam.eventId, newTeam.teamName, newTeam.committedParticipants, context)
                    .then(result => {
                        if (result.success) {
                            context.log(`Team registration email sent to ${newTeam.adminEmail}`);
                        }
                    })
                    .catch(error => {
                        context.error(`Failed to send team registration email to ${newTeam.adminEmail}:`, error);
                    });

                // Send interest acknowledgment email if member was a verified interest lead
                sendInterestAcknowledgmentEmail(newTeam.adminEmail, newTeam.eventId, context)
                    .then(result => {
                        if (result.success) {
                            context.log(`Interest acknowledgment email sent to ${newTeam.adminEmail}`);
                        }
                    })
                    .catch(error => {
                        context.error(`Failed to send interest acknowledgment email to ${newTeam.adminEmail}:`, error);
                    });
            }
            
            context.log(`Team created: ${newTeam.teamName}`);
            return {
                status: 201,
                jsonBody: savedTeam
            };
            
        } catch (error) {
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
            
            const team = Storage.teams.getById(teamId);
            
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
            const updatedTeam = Storage.teams.update(teamId, team);
            
            context.log(`Team updated: ${team.teamName}`);
            return {
                status: 200,
                jsonBody: updatedTeam
            };
            
        } catch (error) {
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

            const team = Storage.teams.getById(teamId);

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

            for (const p of allParticipations) {
                const memberships = p.teamMemberships || [];
                const hadMembership = memberships.some(m => m.teamId === teamId);
                
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
                            // Pure participant with no team — clear everything
                            p.hotelPaidBy = null;
                            p.hotelNights = {};
                            context.log(`Cleared hotel for ${p.email} (no remaining teams)`);
                        }
                    }
                    
                    p.updatedAt = new Date().toISOString();
                    participationsChanged++;
                }
            }

            if (participationsChanged > 0) {
                await participationsStorage.saveAll(allParticipations);
                context.log(`Cleaned ${participationsChanged} participation(s) for team ${teamId}`);
            }

            // 2. Delete badge claims that belong to this team
            const badgeClaimsStorage = new GenericStorage('badge-claims');
            const allClaims = await badgeClaimsStorage.getAll();
            const remainingClaims = allClaims.filter(c => c.teamId !== teamId);
            const claimsRemoved = allClaims.length - remainingClaims.length;

            if (claimsRemoved > 0) {
                await badgeClaimsStorage.saveAll(remainingClaims);
                context.log(`Removed ${claimsRemoved} badge claim(s) for team ${teamId}`);
            }

            // 3. Cancel/remove pending invitations for this team
            const invitationsStorage = new GenericStorage('invitations');
            const allInvitations = await invitationsStorage.getAll();
            const remainingInvitations = allInvitations.filter(i => i.teamId !== teamId);
            const invitationsRemoved = allInvitations.length - remainingInvitations.length;

            if (invitationsRemoved > 0) {
                await invitationsStorage.saveAll(remainingInvitations);
                context.log(`Removed ${invitationsRemoved} invitation(s) for team ${teamId}`);
            }

            // 4. Delete the team itself
            const deleted = Storage.teams.delete(teamId);

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
                        invitationsRemoved: invitationsRemoved
                    }
                }
            };

        } catch (error) {
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
            
            const team = Storage.teams.getById(teamId);
            
            if (!team) {
                return {
                    status: 404,
                    jsonBody: { message: 'Team not found' }
                };
            }
            
            const members = Storage.users.getByTeamId(teamId);
            
            return {
                status: 200,
                jsonBody: members
            };
            
        } catch (error) {
            context.error('Teams members GET error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
