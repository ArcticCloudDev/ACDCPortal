// ACDC Portal - Participations API
// Links users to events with team memberships and hotel choices
// Team memberships: { teamId, isAdmin, isParticipant }
// Rules: 
//   - Can be admin on N teams
//   - Can be participant on only 1 team per event
//   - Max 5 participants per team

const { app } = require('@azure/functions');
const { Storage } = require('../shared/storage');

const participationsStorage = new Storage('participations');
const teamsStorage = new Storage('teams');
const eventsStorage = new Storage('events');
const usersStorage = new Storage('users');
const interestQueueStorage = new Storage('interest-queue');
const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');
const { sendEmail } = require('../shared/mail');

// Helper to generate ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Helper to trigger sequence emails when user joins an event
async function triggerSequenceEmails(userId, eventId, context) {
    try {
        // Get user
        const users = await usersStorage.getAll();
        const user = users.find(u => u.id === userId);
        if (!user || !user.email) {
            context.log(`No user found for sequence emails: ${userId}`);
            return;
        }

        // Get sequence campaigns for this event
        const campaignData = await campaignsStorage.getRaw();
        const sequenceCampaigns = (campaignData?.campaigns || [])
            .filter(c => c.eventId === eventId && c.type === 'sequence')
            .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

        if (sequenceCampaigns.length === 0) {
            context.log(`No sequence campaigns for event ${eventId}`);
            return;
        }

        // Get existing deliveries for this user
        const deliveryData = await deliveriesStorage.getRaw() || { deliveries: [] };
        const userDeliveries = new Set(
            deliveryData.deliveries
                .filter(d => d.email.toLowerCase() === user.email.toLowerCase() && d.status === 'sent')
                .map(d => d.campaignId)
        );

        let sent = 0;
        for (const campaign of sequenceCampaigns) {
            // Skip if already sent
            if (userDeliveries.has(campaign.id)) {
                continue;
            }

            const delivery = {
                id: 'del_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6),
                campaignId: campaign.id,
                email: user.email,
                userId: user.id,
                status: 'pending',
                createdAt: new Date().toISOString()
            };

            try {
                await sendEmail({
                    to: user.email,
                    subject: campaign.subject,
                    htmlContent: campaign.content,
                    firstName: user.firstName || 'Participant',
                    ctaUrl: campaign.ctaUrl,
                    ctaText: campaign.ctaText
                });

                delivery.status = 'sent';
                delivery.sentAt = new Date().toISOString();
                sent++;
            } catch (err) {
                delivery.status = 'failed';
                delivery.error = err.message;
                context.log(`Failed to send sequence email to ${user.email}: ${err.message}`);
            }

            deliveryData.deliveries.push(delivery);
        }

        if (deliveryData.deliveries.length > 0) {
            await deliveriesStorage.saveRaw(deliveryData);
        }

        context.log(`Sent ${sent} sequence emails to ${user.email} for event ${eventId}`);
    } catch (error) {
        // Don't fail the main operation if this fails
        context.log(`Warning: Failed to trigger sequence emails: ${error.message}`);
    }
}

// Helper to remove user from interest queue when they register
async function removeFromInterestQueue(userId, eventId, context) {
    try {
        // Get user email
        const users = await usersStorage.getAll();
        const user = users.find(u => u.id === userId);
        if (!user || !user.email) return;

        // Check interest queue
        const data = await interestQueueStorage.getRaw();
        if (!data || !data.entries) return;

        const entryIndex = data.entries.findIndex(e => 
            e.email.toLowerCase() === user.email.toLowerCase() && !e.registeredEventId
        );

        if (entryIndex >= 0) {
            // Mark as registered instead of removing
            data.entries[entryIndex].registeredEventId = eventId;
            data.entries[entryIndex].registeredAt = new Date().toISOString();
            await interestQueueStorage.saveRaw(data);
            context.log(`Marked interest queue entry for ${user.email} as registered for event ${eventId}`);
        }
    } catch (error) {
        // Don't fail the main operation if this fails
        context.log(`Warning: Failed to update interest queue: ${error.message}`);
    }
}

// GET /api/participations/all - Get all participations (admin)
app.http('participations-get-all', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'participations/all',
    handler: async (request, context) => {
        try {
            const participations = await participationsStorage.getAll();
            return {
                status: 200,
                jsonBody: participations
            };
        } catch (error) {
            context.error('Participations GET ALL error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Internal server error' }
            };
        }
    }
});

// GET /api/participations - Get participation for user in event
app.http('participations-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'participations',
    handler: async (request, context) => {
        try {
            const userId = request.query.get('userId');
            const eventId = request.query.get('eventId');
            
            if (!userId) {
                return {
                    status: 400,
                    jsonBody: { error: 'userId is required' }
                };
            }
            
            const participations = await participationsStorage.getAll();
            
            // If eventId not provided, get active event
            let targetEventId = eventId;
            if (!targetEventId) {
                const events = await eventsStorage.getAll();
                const activeEvent = events.find(e => e.isActive);
                if (activeEvent) {
                    targetEventId = activeEvent.id;
                }
            }
            
            const participation = participations.find(p => 
                p.userId === userId && p.eventId === targetEventId
            );
            
            if (!participation) {
                return {
                    status: 404,
                    jsonBody: { error: 'Participation not found' }
                };
            }
            
            // Ensure teamMemberships array exists (migration support)
            if (!participation.teamMemberships) {
                participation.teamMemberships = [];
            }
            
            return {
                status: 200,
                jsonBody: participation
            };
        } catch (error) {
            context.error('Error getting participation:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get participation' }
            };
        }
    }
});

// POST /api/participations - Create or update participation
app.http('participations-upsert', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'participations',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { userId, eventId, hotelNights } = body;
            
            if (!userId || !eventId) {
                return {
                    status: 400,
                    jsonBody: { error: 'userId and eventId are required' }
                };
            }
            
            const participations = await participationsStorage.getAll();
            const existingIndex = participations.findIndex(p => 
                p.userId === userId && p.eventId === eventId
            );
            
            const now = new Date().toISOString();
            
            if (existingIndex >= 0) {
                // Update existing participation
                const existing = participations[existingIndex];
                const updated = {
                    ...existing,
                    hotelNights: hotelNights !== undefined ? hotelNights : existing.hotelNights,
                    teamMemberships: existing.teamMemberships || [],
                    updatedAt: now
                };
                participations[existingIndex] = updated;
                await participationsStorage.saveAll(participations);
                
                context.log(`Participation updated for user ${userId} in event ${eventId}`);
                return {
                    status: 200,
                    jsonBody: updated
                };
            } else {
                // Create new participation
                const newParticipation = {
                    id: generateId(),
                    userId,
                    eventId,
                    teamMemberships: [],
                    hotelNights: hotelNights || {},
                    createdAt: now,
                    updatedAt: now
                };
                participations.push(newParticipation);
                await participationsStorage.saveAll(participations);
                
                context.log(`Participation created for user ${userId} in event ${eventId}`);
                return {
                    status: 201,
                    jsonBody: newParticipation
                };
            }
        } catch (error) {
            context.error('Error upserting participation:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to save participation' }
            };
        }
    }
});

// PUT /api/participations/:id/hotel - Update hotel nights only
app.http('participations-update-hotel', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'participations/{id}/hotel',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            const { hotelNights } = body;
            
            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);
            
            if (index < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Participation not found' }
                };
            }
            
            participations[index] = {
                ...participations[index],
                hotelNights,
                updatedAt: new Date().toISOString()
            };
            
            await participationsStorage.saveAll(participations);
            
            context.log(`Hotel nights updated for participation ${id}`);
            return {
                status: 200,
                jsonBody: participations[index]
            };
        } catch (error) {
            context.error('Error updating hotel nights:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to update hotel nights' }
            };
        }
    }
});

// POST /api/participations/:id/team-membership - Add or update team membership
app.http('participations-add-team-membership', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'participations/{id}/team-membership',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            const { teamId, isAdmin, isParticipant } = body;
            
            if (!teamId) {
                return {
                    status: 400,
                    jsonBody: { error: 'teamId is required' }
                };
            }
            
            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);
            
            if (index < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Participation not found' }
                };
            }
            
            const participation = participations[index];
            const memberships = participation.teamMemberships || [];
            
            // Check if trying to add as participant when already participant on another team
            if (isParticipant) {
                const existingParticipantTeam = memberships.find(m => m.isParticipant && m.teamId !== teamId);
                if (existingParticipantTeam) {
                    return {
                        status: 400,
                        jsonBody: { 
                            error: 'Already a participant on another team',
                            existingTeamId: existingParticipantTeam.teamId
                        }
                    };
                }
                
                // Check if team would exceed max 5 participants
                const teams = await teamsStorage.getAll();
                const team = teams.find(t => t.id === teamId);
                if (team) {
                    // Count current participants for this team
                    let participantCount = 0;
                    for (const p of participations) {
                        const tm = (p.teamMemberships || []).find(m => m.teamId === teamId && m.isParticipant);
                        if (tm && p.id !== id) { // Don't count current user if updating
                            participantCount++;
                        }
                    }
                    
                    if (participantCount >= 5) {
                        return {
                            status: 400,
                            jsonBody: { 
                                error: 'Team has reached maximum of 5 participants',
                                currentCount: participantCount
                            }
                        };
                    }
                    
                    // Warning if would exceed numberOfParticipants
                    if (participantCount >= team.numberOfParticipants) {
                        context.log(`Warning: Team ${teamId} exceeding expected ${team.numberOfParticipants} participants`);
                    }
                }
            }
            
            // Find existing membership for this team
            const existingMembershipIndex = memberships.findIndex(m => m.teamId === teamId);
            
            if (existingMembershipIndex >= 0) {
                // Update existing membership
                memberships[existingMembershipIndex] = {
                    teamId,
                    isAdmin: isAdmin !== undefined ? isAdmin : memberships[existingMembershipIndex].isAdmin,
                    isParticipant: isParticipant !== undefined ? isParticipant : memberships[existingMembershipIndex].isParticipant
                };
            } else {
                // Add new membership
                memberships.push({
                    teamId,
                    isAdmin: isAdmin || false,
                    isParticipant: isParticipant || false
                });
            }
            
            participations[index] = {
                ...participation,
                teamMemberships: memberships,
                updatedAt: new Date().toISOString()
            };
            
            await participationsStorage.saveAll(participations);
            
            // If user became a participant, check interest queue and trigger sequence emails
            if (isParticipant) {
                await removeFromInterestQueue(participation.userId, participation.eventId, context);
                await triggerSequenceEmails(participation.userId, participation.eventId, context);
            }
            
            context.log(`Team membership updated for participation ${id}, team ${teamId}`);
            return {
                status: 200,
                jsonBody: participations[index]
            };
        } catch (error) {
            context.error('Error adding team membership:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to add team membership' }
            };
        }
    }
});

// DELETE /api/participations/:id/team-membership/:teamId - Remove team membership
app.http('participations-remove-team-membership', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'participations/{id}/team-membership/{teamId}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const teamId = request.params.teamId;
            
            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);
            
            if (index < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Participation not found' }
                };
            }
            
            const participation = participations[index];
            const memberships = participation.teamMemberships || [];
            
            const membershipIndex = memberships.findIndex(m => m.teamId === teamId);
            if (membershipIndex < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Team membership not found' }
                };
            }
            
            // Check if user is admin - cannot remove if only admin
            const membership = memberships[membershipIndex];
            if (membership.isAdmin) {
                // Check if there are other admins for this team
                let otherAdminCount = 0;
                for (const p of participations) {
                    if (p.id !== id) {
                        const tm = (p.teamMemberships || []).find(m => m.teamId === teamId && m.isAdmin);
                        if (tm) otherAdminCount++;
                    }
                }
                
                if (otherAdminCount === 0) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Cannot remove last admin from team' }
                    };
                }
            }
            
            memberships.splice(membershipIndex, 1);
            
            participations[index] = {
                ...participation,
                teamMemberships: memberships,
                updatedAt: new Date().toISOString()
            };
            
            await participationsStorage.saveAll(participations);
            
            context.log(`Team membership removed for participation ${id}, team ${teamId}`);
            return {
                status: 200,
                jsonBody: participations[index]
            };
        } catch (error) {
            context.error('Error removing team membership:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to remove team membership' }
            };
        }
    }
});

// PUT /api/participations/:id/team-membership/:teamId/participant - Toggle participant status
app.http('participations-toggle-participant', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'participations/{id}/team-membership/{teamId}/participant',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const teamId = request.params.teamId;
            const body = await request.json();
            const { isParticipant } = body;
            
            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);
            
            if (index < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Participation not found' }
                };
            }
            
            const participation = participations[index];
            const memberships = participation.teamMemberships || [];
            const membershipIndex = memberships.findIndex(m => m.teamId === teamId);
            
            if (membershipIndex < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Team membership not found' }
                };
            }
            
            // If setting isParticipant true, check constraints
            if (isParticipant) {
                // Check if already participant on another team
                const existingParticipantTeam = memberships.find(m => m.isParticipant && m.teamId !== teamId);
                if (existingParticipantTeam) {
                    return {
                        status: 400,
                        jsonBody: { 
                            error: 'Already a participant on another team',
                            existingTeamId: existingParticipantTeam.teamId
                        }
                    };
                }
                
                // Check max participants
                const teams = await teamsStorage.getAll();
                const team = teams.find(t => t.id === teamId);
                if (team) {
                    let participantCount = 0;
                    for (const p of participations) {
                        const tm = (p.teamMemberships || []).find(m => m.teamId === teamId && m.isParticipant);
                        if (tm && p.id !== id) {
                            participantCount++;
                        }
                    }
                    
                    if (participantCount >= 5) {
                        return {
                            status: 400,
                            jsonBody: { 
                                error: 'Team has reached maximum of 5 participants',
                                currentCount: participantCount
                            }
                        };
                    }
                }
            }
            
            memberships[membershipIndex].isParticipant = isParticipant;
            
            participations[index] = {
                ...participation,
                teamMemberships: memberships,
                updatedAt: new Date().toISOString()
            };
            
            await participationsStorage.saveAll(participations);
            
            // If user became a participant, check interest queue
            if (isParticipant) {
                await removeFromInterestQueue(participation.userId, participation.eventId, context);
            }
            
            context.log(`Participant status toggled for participation ${id}, team ${teamId}: ${isParticipant}`);
            return {
                status: 200,
                jsonBody: participations[index]
            };
        } catch (error) {
            context.error('Error toggling participant status:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to toggle participant status' }
            };
        }
    }
});

// PUT /api/participations/:id/team-membership/:teamId/roles - Update both isAdmin and isParticipant
app.http('participations-update-roles', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'participations/{id}/team-membership/{teamId}/roles',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const teamId = request.params.teamId;
            const body = await request.json();
            const { isAdmin, isParticipant } = body;
            
            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);
            
            if (index < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Participation not found' }
                };
            }
            
            const participation = participations[index];
            const memberships = participation.teamMemberships || [];
            const membershipIndex = memberships.findIndex(m => m.teamId === teamId);
            
            if (membershipIndex < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Team membership not found' }
                };
            }
            
            // If setting isParticipant true, check constraints
            if (isParticipant && !memberships[membershipIndex].isParticipant) {
                // Check if already participant on another team
                const existingParticipantTeam = memberships.find(m => m.isParticipant && m.teamId !== teamId);
                if (existingParticipantTeam) {
                    return {
                        status: 400,
                        jsonBody: { 
                            error: 'Already a participant on another team',
                            existingTeamId: existingParticipantTeam.teamId
                        }
                    };
                }
                
                // Check max participants
                const teams = await teamsStorage.getAll();
                const team = teams.find(t => t.id === teamId);
                if (team) {
                    let participantCount = 0;
                    for (const p of participations) {
                        const tm = (p.teamMemberships || []).find(m => m.teamId === teamId && m.isParticipant);
                        if (tm && p.id !== id) {
                            participantCount++;
                        }
                    }
                    
                    // Get max from event
                    const events = await require('../shared/storage').getStorage('events').getAll();
                    const event = events.find(e => e.id === participation.eventId);
                    const maxParticipants = event?.maxTeamSize || 5;
                    
                    if (participantCount >= maxParticipants) {
                        return {
                            status: 400,
                            jsonBody: { 
                                error: `Team has reached maximum of ${maxParticipants} participants`,
                                currentCount: participantCount
                            }
                        };
                    }
                }
            }
            
            // Update both roles
            memberships[membershipIndex].isAdmin = isAdmin;
            memberships[membershipIndex].isParticipant = isParticipant;
            
            participations[index] = {
                ...participation,
                teamMemberships: memberships,
                updatedAt: new Date().toISOString()
            };
            
            await participationsStorage.saveAll(participations);
            
            context.log(`Roles updated for participation ${id}, team ${teamId}: isAdmin=${isAdmin}, isParticipant=${isParticipant}`);
            return {
                status: 200,
                jsonBody: participations[index]
            };
        } catch (error) {
            context.error('Error updating roles:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to update roles' }
            };
        }
    }
});

// GET /api/participations/event/:eventId - Get all participations for an event
app.http('participations-by-event', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'participations/event/{eventId}',
    handler: async (request, context) => {
        try {
            const eventId = request.params.eventId;
            const participations = await participationsStorage.getAll();
            const eventParticipations = participations.filter(p => p.eventId === eventId);
            
            // Ensure teamMemberships array exists for all
            eventParticipations.forEach(p => {
                if (!p.teamMemberships) p.teamMemberships = [];
            });
            
            return {
                status: 200,
                jsonBody: eventParticipations
            };
        } catch (error) {
            context.error('Error getting participations by event:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get participations' }
            };
        }
    }
});

// GET /api/participations/team/:teamId - Get all participations for a team
app.http('participations-by-team', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'participations/team/{teamId}',
    handler: async (request, context) => {
        try {
            const teamId = request.params.teamId;
            const participations = await participationsStorage.getAll();
            
            // Filter to participations that have membership in this team
            const teamParticipations = participations.filter(p => {
                const memberships = p.teamMemberships || [];
                return memberships.some(m => m.teamId === teamId);
            });
            
            return {
                status: 200,
                jsonBody: teamParticipations
            };
        } catch (error) {
            context.error('Error getting participations by team:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get participations' }
            };
        }
    }
});

// GET /api/participations/team/:teamId/count - Get participant count for a team
app.http('participations-team-count', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'participations/team/{teamId}/count',
    handler: async (request, context) => {
        try {
            const teamId = request.params.teamId;
            const participations = await participationsStorage.getAll();
            
            let adminCount = 0;
            let participantCount = 0;
            
            for (const p of participations) {
                const membership = (p.teamMemberships || []).find(m => m.teamId === teamId);
                if (membership) {
                    if (membership.isAdmin) adminCount++;
                    if (membership.isParticipant) participantCount++;
                }
            }
            
            return {
                status: 200,
                jsonBody: {
                    teamId,
                    adminCount,
                    participantCount,
                    maxParticipants: 5
                }
            };
        } catch (error) {
            context.error('Error getting team count:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get team count' }
            };
        }
    }
});

console.log('Participations API loaded');
