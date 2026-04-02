// Members API - Add and remove team members
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const Email = require('../shared/email');
const { sendTeamWelcomeEmail } = require('../shared/team-welcome');
const { sendInterestAcknowledgmentEmail } = require('../shared/interest-acknowledgment');

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
            const team = await Storage.teams.getById(teamId);
            if (!team) {
                return {
                    status: 404,
                    jsonBody: { message: 'Team not found' }
                };
            }
            
            // Check team capacity
            const currentMembers = await Storage.users.getByTeamId(teamId);
            if (currentMembers.length >= team.numberOfParticipants) {
                return {
                    status: 400,
                    jsonBody: { message: `Team is at maximum capacity (${team.numberOfParticipants} members)` }
                };
            }
            
            // Check if email already exists
            const existingUser = await Storage.users.getByEmail(email);
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
            
            await Storage.users.create(newUser);
            
            // Add to allowed emails
            await Storage.allowedEmails.add(email, team.adminUserId);
            
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

                // Send interest acknowledgment email if member was a verified interest lead
                sendInterestAcknowledgmentEmail(email, team.eventId, context)
                    .then(result => {
                        if (result.success) {
                            context.log(`Interest acknowledgment email sent to ${email}`);
                        }
                    })
                    .catch(error => {
                        context.error(`Failed to send interest acknowledgment email to ${email}:`, error);
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
            await logError(context, error);
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
            let teamId = null;

            try {
                const body = await request.json();
                teamId = body?.teamId || null;
            } catch {
                // DELETE bodies may be omitted by some clients; teamId remains null.
            }
            
            if (!memberId) {
                return {
                    status: 400,
                    jsonBody: { message: 'Member ID required' }
                };
            }
            
            // Get user
            const user = await Storage.users.getById(memberId);
            if (!user) {
                return {
                    status: 404,
                    jsonBody: { message: 'Member not found' }
                };
            }
            
            // Note: Team admin status should be checked via participations.teamMemberships[].isAdmin
            // For now, allow removal (TODO: add proper team admin check)

            // Resolve team/event context for cleanup.
            let team = null;
            if (teamId) {
                team = await Storage.teams.getById(teamId);
            } else if (user.teamId) {
                team = await Storage.teams.getById(user.teamId);
                teamId = user.teamId;
            }

            const eventId = team?.eventId || null;

            // Remove related participation(s) for this user in the same team/event context.
            const participationsStorage = new GenericStorage('participations');
            const invitationsStorage = new GenericStorage('invitations');
            const deliveriesStorage = new GenericStorage('email-deliveries');
            const sequenceProgressStorage = new GenericStorage('sequence-progress');

            const allParticipations = await participationsStorage.getAll();
            const matchedParticipations = allParticipations.filter(p => {
                if (p.userId !== memberId) return false;
                if (teamId && p.teamId === teamId) return true;
                if (eventId && p.eventId === eventId) return true;
                return !teamId && !eventId;
            });

            const cleaned = {
                participations: 0,
                invitations: 0,
                deliveries: 0,
                sequenceProgress: 0
            };

            for (const participation of matchedParticipations) {
                await participationsStorage.delete(participation.id);
                cleaned.participations += 1;

                const pEmail = participation.email;
                const pUserId = participation.userId;
                const pEventId = participation.eventId;

                // Clean invitations for this person/event.
                const invitations = await invitationsStorage.getAll();
                const filteredInvitations = invitations.filter(inv => {
                    const emailMatch = pEmail && inv.email && inv.email.toLowerCase() === pEmail.toLowerCase();
                    return !(emailMatch && inv.eventId === pEventId);
                });
                if (filteredInvitations.length < invitations.length) {
                    cleaned.invitations += invitations.length - filteredInvitations.length;
                    await invitationsStorage.saveAll(filteredInvitations);
                }

                // Clean deliveries tied to this user/email.
                const deliveries = await deliveriesStorage.getAll();
                const filteredDeliveries = deliveries.filter(d => {
                    if (pUserId && d.userId === pUserId) return false;
                    if (pEmail && d.email && d.email.toLowerCase() === pEmail.toLowerCase()) return false;
                    return true;
                });
                if (filteredDeliveries.length < deliveries.length) {
                    cleaned.deliveries += deliveries.length - filteredDeliveries.length;
                    await deliveriesStorage.saveAll(filteredDeliveries);
                }

                // Clean sequence progress if present (legacy JSON-backed dataset).
                const progressRows = await sequenceProgressStorage.getAll();
                if (Array.isArray(progressRows) && progressRows.length > 0) {
                    const filteredProgress = progressRows.filter(p => !(p.userId === pUserId && p.eventId === pEventId));
                    if (filteredProgress.length < progressRows.length) {
                        cleaned.sequenceProgress += progressRows.length - filteredProgress.length;
                        await sequenceProgressStorage.saveAll(filteredProgress);
                    }
                }
            }
            
            // Remove from allowed emails
            await Storage.allowedEmails.remove(user.email);
            
            // Delete user
            await Storage.users.delete(memberId);
            
            context.log(`Member ${memberId} removed. Cleaned ${cleaned.participations} participations, ${cleaned.invitations} invitations, ${cleaned.deliveries} deliveries, ${cleaned.sequenceProgress} sequence progress rows.`);
            return {
                status: 200,
                jsonBody: {
                    message: 'Member removed successfully',
                    cleaned
                }
            };
            
        } catch (error) {
            await logError(context, error);
            context.error('Members DELETE error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
