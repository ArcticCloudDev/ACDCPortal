// Members API - Add and remove team members
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const Email = require('../shared/email');
const Graph = require('../shared/graph');
const { sendTeamWelcomeEmail } = require('../shared/team-welcome');

// Add member to team
app.http('members-add', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'members',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { teamId, email } = body;
            
            if (!teamId || !email) {
                return {
                    status: 400,
                    jsonBody: { message: 'Team ID and email are required' }
                };
            }
            
            // Get team
            const team = Storage.teams.getById(teamId);
            if (!team) {
                return {
                    status: 404,
                    jsonBody: { message: 'Team not found' }
                };
            }
            
            // Check team capacity
            const currentMembers = Storage.users.getByTeamId(teamId);
            if (currentMembers.length >= team.numberOfParticipants) {
                return {
                    status: 400,
                    jsonBody: { message: `Team is at maximum capacity (${team.numberOfParticipants} members)` }
                };
            }
            
            // Check if email already exists
            const existingUser = Storage.users.getByEmail(email);
            if (existingUser) {
                return {
                    status: 400,
                    jsonBody: { message: 'This email is already registered' }
                };
            }
            
            // Create new user (minimal profile - they'll complete it on login)
            const now = new Date().toISOString();
            const newUser = {
                id: uuidv4(),
                email: email.toLowerCase().trim(),
                firstName: null,
                lastName: null,
                phone: null,
                allergies: null,
                hotelWedThu: false,
                hotelThuSun: true,
                hotelSunMon: false,
                profileComplete: false,
                createdAt: now,
                updatedAt: now
            };
            
            Storage.users.create(newUser);
            
            // Add to allowed emails
            Storage.allowedEmails.add(email, team.adminUserId);
            
            // Create user in Entra External ID for Email OTP login
            try {
                const entraResult = await Graph.createEntraUser(email);
                context.log(`Entra user creation for ${email}: ${entraResult.exists ? 'already existed' : 'created new'}`);
            } catch (entraError) {
                // Log error but don't fail - user can still be created later
                context.error('Failed to create Entra user (will retry on next login):', entraError.message);
            }
            
            // Send notification email
            await Email.sendVerificationCode(email, 'You have been added to team: ' + team.teamName);
            
            // Send welcome email to new member (async, don't wait)
            if (team.eventId) {
                sendTeamWelcomeEmail(email, team.eventId, context)
                    .then(result => {
                        if (result.success) {
                            context.log(`Team welcome email sent to ${email}: ${result.emailsSent} sent, ${result.emailsFailed} failed`);
                        }
                    })
                    .catch(error => {
                        context.error(`Failed to send team welcome email to ${email}:`, error);
                    });
            }
            
            context.log(`Member ${email} added to team ${teamId}`);
            return {
                status: 200,
                jsonBody: { 
                    message: 'Member added successfully',
                    user: newUser
                }
            };
            
        } catch (error) {
            context.error('Members POST error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

// Remove member from team
app.http('members-remove', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'members/{id}',
    handler: async (request, context) => {
        try {
            const memberId = request.params.id;
            
            if (!memberId) {
                return {
                    status: 400,
                    jsonBody: { message: 'Member ID required' }
                };
            }
            
            // Get user
            const user = Storage.users.getById(memberId);
            if (!user) {
                return {
                    status: 404,
                    jsonBody: { message: 'Member not found' }
                };
            }
            
            // Note: Team admin status should be checked via participations.teamMemberships[].isAdmin
            // For now, allow removal (TODO: add proper team admin check)
            
            // Remove from allowed emails
            Storage.allowedEmails.remove(user.email);
            
            // Delete user from Entra External ID
            try {
                await Graph.deleteEntraUser(user.email);
                context.log(`Deleted Entra user: ${user.email}`);
            } catch (entraError) {
                // Log error but don't fail - user will just exist in Entra without access
                context.error('Failed to delete Entra user:', entraError.message);
            }
            
            // Delete user
            Storage.users.delete(memberId);
            
            context.log(`Member ${memberId} removed`);
            return {
                status: 200,
                jsonBody: { message: 'Member removed successfully' }
            };
            
        } catch (error) {
            context.error('Members DELETE error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
