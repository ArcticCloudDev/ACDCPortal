// Teams API - Get team info and members
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const { sendTeamWelcomeEmail } = require('../shared/team-welcome');

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
            const teamId = Date.now().toString(36) + Math.random().toString(36).substr(2);
            
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
            
            // Send welcome email to team admin (async, don't wait)
            if (newTeam.adminEmail && newTeam.eventId) {
                sendTeamWelcomeEmail(newTeam.adminEmail, newTeam.eventId, context)
                    .then(result => {
                        if (result.success) {
                            context.log(`Team welcome email sent to ${newTeam.adminEmail}: ${result.emailsSent} sent, ${result.emailsFailed} failed`);
                        }
                    })
                    .catch(error => {
                        context.error(`Failed to send team welcome email to ${newTeam.adminEmail}:`, error);
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
