// Members API - Add and remove team members
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth } = require('../shared/auth');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const Email = require('../shared/email');
const { sendWelcomeEmail } = require('../shared/welcome-email');

// Add member to team
app.http('members-add', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'members',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

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
                sendWelcomeEmail(email, team.eventId, context, { teamName: team.teamName })
                    .then(result => {
                        if (result.success) context.log(`Welcome email sent to ${email}`);
                    })
                    .catch(error => context.error(`Failed to send welcome email to ${email}:`, error));

                // Interest acknowledgment is only sent from interest.js when interest is first recorded
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
    authLevel: 'function',
    route: 'members/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

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
            const interestLeadsStorage = new GenericStorage('interest-leads');

            const allParticipations = await participationsStorage.getAll();
            const matchedParticipations = allParticipations.filter(p => {
                // Match by userId if set; fall back to email match for leads registered
                // before the user had a system account (userId was null on those rows).
                const byUserId = p.userId && p.userId === memberId;
                const byEmail = user.email && p.email &&
                    p.email.toLowerCase() === user.email.toLowerCase();
                if (!byUserId && !byEmail) return false;
                if (teamId && (p.teamId === teamId || (p.teamMemberships || []).some(m => m.teamId === teamId))) return true;
                if (eventId && p.eventId === eventId) return true;
                return !teamId && !eventId;
            });

            const cleaned = {
                participations: 0,
                invitations: 0,
                deliveries: 0,
                sequenceProgress: 0,
                interestLeads: 0
            };

            for (const participation of matchedParticipations) {
                await participationsStorage.delete(participation.id);
                cleaned.participations += 1;

                const pEmail = participation.email;
                const pUserId = participation.userId;
                const pEventId = participation.eventId;

                // Clean invitations for this person/event.
                const invitations = await invitationsStorage.getAll();
                const removedInvitations = invitations.filter(inv => {
                    const emailMatch = pEmail && inv.email && inv.email.toLowerCase() === pEmail.toLowerCase();
                    return emailMatch && inv.eventId === pEventId;
                });
                if (removedInvitations.length > 0) {
                    cleaned.invitations += removedInvitations.length;
                    for (const inv of removedInvitations) {
                        await invitationsStorage.delete(inv.id);
                    }
                }

                // Clean deliveries tied to this user/email.
                const deliveries = await deliveriesStorage.getAll();
                const removedDeliveries = deliveries.filter(d => {
                    if (pUserId && d.userId === pUserId) return true;
                    if (pEmail && d.email && d.email.toLowerCase() === pEmail.toLowerCase()) return true;
                    return false;
                });
                if (removedDeliveries.length > 0) {
                    cleaned.deliveries += removedDeliveries.length;
                    for (const d of removedDeliveries) {
                        await deliveriesStorage.delete(d.id);
                    }
                }

                // Clean sequence progress if present (legacy JSON-backed dataset).
                const progressRows = await sequenceProgressStorage.getAll();
                if (Array.isArray(progressRows) && progressRows.length > 0) {
                    const removedProgress = progressRows.filter(p => p.userId === pUserId && p.eventId === pEventId);
                    if (removedProgress.length > 0) {
                        cleaned.sequenceProgress += removedProgress.length;
                        for (const prog of removedProgress) {
                            await sequenceProgressStorage.delete(prog.id);
                        }
                    }
                }
            }

            // Clean up InterestLeads by email (independent of participation records).
            const allLeads = await interestLeadsStorage.getAll();
            const removedLeads = allLeads.filter(lead =>
                lead.email && lead.email.toLowerCase() === user.email.toLowerCase()
            );
            if (removedLeads.length > 0) {
                cleaned.interestLeads = removedLeads.length;
                for (const lead of removedLeads) {
                    await interestLeadsStorage.delete(lead.id);
                }
            }

            // Safety-net: if no participations were found above (can happen when
            // the lead had userId=null), still clean deliveries by email.
            if (cleaned.participations === 0) {
                const allDeliveries = await deliveriesStorage.getAll();
                const removedDeliveries = allDeliveries.filter(d =>
                    d.email && d.email.toLowerCase() === user.email.toLowerCase()
                );
                if (removedDeliveries.length > 0) {
                    cleaned.deliveries += removedDeliveries.length;
                    for (const d of removedDeliveries) {
                        await deliveriesStorage.delete(d.id);
                    }
                }
            }

            // Remove from allowed emails
            await Storage.allowedEmails.remove(user.email);
            
            // Delete user
            await Storage.users.delete(memberId);
            
            context.log(`Member ${memberId} removed. Cleaned ${cleaned.participations} participations, ${cleaned.invitations} invitations, ${cleaned.deliveries} deliveries, ${cleaned.sequenceProgress} sequence-progress rows, ${cleaned.interestLeads} interest leads.`);
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
