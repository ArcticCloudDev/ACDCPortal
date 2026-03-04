// ACDC Portal - Participations API (v2)
// Unified participation model: one record per person per event
// Roles array: ['interest', 'participant', 'judge', 'committee', 'sponsor']
// Email is the anchor identity (present before userId)

const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const { Storage } = require('../shared/storage');

const participationsStorage = new Storage('participations');
const teamsStorage = new Storage('teams');
const eventsStorage = new Storage('events');
const usersStorage = new Storage('users');
const interestQueueStorage = new Storage('interest-queue');
const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');
const invitationsStorage = new Storage('invitations');
const sequenceProgressStorage = new Storage('sequence-progress');
const { sendEmail } = require('../shared/mail');
const { sendInterestAcknowledgmentEmail } = require('../shared/interest-acknowledgment');
const { sendTeamWelcomeEmail } = require('../shared/team-welcome');

// Valid roles
const VALID_ROLES = ['interest', 'participant', 'judge', 'committee', 'sponsor'];

// Helper to check if event status means it's active
function isActiveStatus(status) {
    return status === 'pre-registration' || status === 'registration' || status === 'live';
}

// Helper to generate ID
function generateId() {
    return uuidv4();
}

// ============================================================
// HELPERS: Sequence emails & interest queue
// ============================================================

async function triggerSequenceEmails(userId, eventId, context) {
    try {
        const users = await usersStorage.getAll();
        const user = users.find(u => u.id === userId);
        if (!user || !user.email) {
            context.log(`No user found for sequence emails: ${userId}`);
            return;
        }

        // Look up event to get its sequenceId
        const events = await eventsStorage.getAll();
        const event = events.find(e => e.id === eventId);
        if (!event || !event.sequenceEnabled || !event.sequenceId) {
            context.log(`Event ${eventId} not found or sequence not enabled`);
            return;
        }

        const campaignData = await campaignsStorage.getRaw();
        const sequenceCampaigns = (campaignData?.campaigns || [])
            .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence' && c.status === 'live')
            .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

        if (sequenceCampaigns.length === 0) {
            context.log(`No sequence campaigns for sequence ${event.sequenceId} (event ${eventId})`);
            return;
        }

        const deliveryData = await deliveriesStorage.getRaw() || { deliveries: [] };
        const userDeliveries = new Set(
            deliveryData.deliveries
                .filter(d => d.email.toLowerCase() === user.email.toLowerCase() && d.status === 'sent')
                .map(d => d.campaignId)
        );

        // Filter to only unsent campaigns
        const campaignsToSend = sequenceCampaigns.filter(c => !userDeliveries.has(c.id));
        if (campaignsToSend.length === 0) {
            context.log(`All sequence emails already sent to ${user.email}`);
            return;
        }

        // Build digest email with all unsent campaigns in one message
        const fs = require('fs').promises;
        const path = require('path');
        const { processTemplate } = require('../shared/mail');

        const messageBlocks = campaignsToSend.map((campaign, index) => `
            <tr>
                <td style="padding: 0;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                            <td style="background-color: #1e293b; padding: 14px 40px;">
                                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                                    <tr>
                                        <td>
                                            <span style="color: #94a3b8; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase;">UPDATE ${index + 1} OF ${campaignsToSend.length}</span>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td style="padding-top: 4px;">
                                            <span style="color: #ffffff; font-size: 18px; font-weight: 700;">${campaign.subject}</span>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding: 28px 40px 32px 40px; color: #334155; font-size: 15px; line-height: 1.75;">
                                ${campaign.content}
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        `).join('');

        const digestTemplatePath = path.join(__dirname, '../../../data/email-templates/sequence-digest.html');
        const digestTemplate = await fs.readFile(digestTemplatePath, 'utf-8');
        const digestHtml = processTemplate(digestTemplate, {
            eventName: event.name,
            firstName: user.firstName || 'Participant',
            digestCount: campaignsToSend.length.toString(),
            digestContent: messageBlocks,
            year: new Date().getFullYear().toString()
        });

        try {
            await sendEmail({
                to: user.email,
                subject: `${event.name} - Important Updates`,
                htmlContent: digestHtml
            });

            // Record deliveries for all campaigns included in the digest
            for (const campaign of campaignsToSend) {
                deliveryData.deliveries.push({
                    id: uuidv4(),
                    campaignId: campaign.id,
                    email: user.email,
                    userId: user.id,
                    status: 'sent',
                    sentAt: new Date().toISOString(),
                    sentVia: 'digest',
                    createdAt: new Date().toISOString()
                });
            }
            context.log(`Sent digest of ${campaignsToSend.length} sequence emails to ${user.email} for event ${eventId}`);
        } catch (err) {
            for (const campaign of campaignsToSend) {
                deliveryData.deliveries.push({
                    id: uuidv4(),
                    campaignId: campaign.id,
                    email: user.email,
                    userId: user.id,
                    status: 'failed',
                    error: err.message,
                    createdAt: new Date().toISOString()
                });
            }
            context.log(`Failed to send digest to ${user.email}: ${err.message}`);
        }

        await deliveriesStorage.saveRaw(deliveryData);
    } catch (error) {
        context.log(`Warning: Failed to trigger sequence emails: ${error.message}`);
    }
}

async function removeFromInterestQueue(userId, eventId, context) {
    try {
        const users = await usersStorage.getAll();
        const user = users.find(u => u.id === userId);
        if (!user || !user.email) return;

        const data = await interestQueueStorage.getRaw();
        if (!data || !data.entries) return;

        const entryIndex = data.entries.findIndex(e =>
            e.email.toLowerCase() === user.email.toLowerCase() && !e.registeredEventId
        );

        if (entryIndex >= 0) {
            data.entries[entryIndex].registeredEventId = eventId;
            data.entries[entryIndex].registeredAt = new Date().toISOString();
            await interestQueueStorage.saveRaw(data);
            context.log(`Marked interest queue entry for ${user.email} as registered for event ${eventId}`);
        }
    } catch (error) {
        context.log(`Warning: Failed to update interest queue: ${error.message}`);
    }
}


// ============================================================
// CORE CRUD
// ============================================================

// GET /api/participations/all - Get all participations (admin)
app.http('participations-get-all', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'participations/all',
    handler: async (request, context) => {
        try {
            const participations = await participationsStorage.getAll();
            // Migration: ensure roles array exists on all records
            participations.forEach(p => {
                if (!p.roles) p.roles = migrateRoles(p);
            });
            return { status: 200, jsonBody: participations };
        } catch (error) {
            context.error('Participations GET ALL error:', error);
            return { status: 500, jsonBody: { error: 'Internal server error' } };
        }
    }
});

// GET /api/participations - Get participation for user/email in event
app.http('participations-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'participations',
    handler: async (request, context) => {
        try {
            const userId = request.query.get('userId');
            const email = request.query.get('email');
            const eventId = request.query.get('eventId');

            if (!userId && !email) {
                return { status: 400, jsonBody: { error: 'userId or email is required' } };
            }

            const participations = await participationsStorage.getAll();

            // Determine target event
            let targetEventId = eventId;
            if (!targetEventId) {
                const events = await eventsStorage.getAll();
                const activeEvent = events.find(e => isActiveStatus(e.status));
                if (activeEvent) targetEventId = activeEvent.id;
            }

            // Find by userId or email
            const participation = participations.find(p => {
                const matchesUser = userId ? p.userId === userId : p.email?.toLowerCase() === email.toLowerCase();
                return matchesUser && p.eventId === targetEventId;
            });

            if (!participation) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            // Migration support
            if (!participation.roles) participation.roles = migrateRoles(participation);
            if (!participation.teamMemberships) participation.teamMemberships = buildLegacyTeamMemberships(participation);

            return { status: 200, jsonBody: participation };
        } catch (error) {
            context.error('Error getting participation:', error);
            return { status: 500, jsonBody: { error: 'Failed to get participation' } };
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
            const { userId, email, eventId, hotelNights, roles } = body;

            if (!eventId) {
                return { status: 400, jsonBody: { error: 'eventId is required' } };
            }
            if (!userId && !email) {
                return { status: 400, jsonBody: { error: 'userId or email is required' } };
            }

            // Resolve email from userId if not provided
            let resolvedEmail = email;
            if (!resolvedEmail && userId) {
                const users = await usersStorage.getAll();
                const user = users.find(u => u.id === userId);
                resolvedEmail = user?.email;
            }

            const participations = await participationsStorage.getAll();

            // Find existing: match by userId OR email for this event
            const existingIndex = participations.findIndex(p => {
                if (userId && p.userId === userId && p.eventId === eventId) return true;
                if (resolvedEmail && p.email?.toLowerCase() === resolvedEmail.toLowerCase() && p.eventId === eventId) return true;
                return false;
            });

            const now = new Date().toISOString();

            if (existingIndex >= 0) {
                // Update existing participation
                const existing = participations[existingIndex];
                const updated = {
                    ...existing,
                    userId: userId || existing.userId,
                    email: resolvedEmail || existing.email,
                    hotelNights: hotelNights !== undefined ? hotelNights : existing.hotelNights,
                    roles: existing.roles || migrateRoles(existing),
                    updatedAt: now
                };
                // Ensure legacy support
                updated.teamMemberships = buildLegacyTeamMemberships(updated);
                participations[existingIndex] = updated;
                await participationsStorage.saveAll(participations);

                context.log(`Participation updated for ${resolvedEmail || userId} in event ${eventId}`);
                return { status: 200, jsonBody: updated };
            } else {
                // Create new participation
                // Determine initial hotelPaidBy based on roles
                const initialRoles = roles || [];
                const initialHotelPaidBy = initialRoles.includes('committee') || initialRoles.includes('judge')
                    ? 'committee' : null;

                const newParticipation = {
                    id: generateId(),
                    userId: userId || null,
                    email: resolvedEmail || null,
                    eventId,
                    roles: initialRoles,
                    teamId: null,
                    isTeamAdmin: false,
                    hotelNights: hotelNights || {},
                    hotelPaidBy: initialHotelPaidBy,
                    createdAt: now,
                    updatedAt: now
                };
                // Legacy support
                newParticipation.teamMemberships = [];
                participations.push(newParticipation);
                await participationsStorage.saveAll(participations);

                context.log(`Participation created for ${resolvedEmail || userId} in event ${eventId}`);
                return { status: 201, jsonBody: newParticipation };
            }
        } catch (error) {
            context.error('Error upserting participation:', error);
            return { status: 500, jsonBody: { error: 'Failed to save participation' } };
        }
    }
});

// PUT /api/participations/:id - Update participation fields
app.http('participations-update', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'participations/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();

            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const existing = participations[index];
            const updated = {
                ...existing,
                ...(body.hotelNights !== undefined && { hotelNights: body.hotelNights }),
                ...(body.teamId !== undefined && { teamId: body.teamId }),
                ...(body.isTeamAdmin !== undefined && { isTeamAdmin: body.isTeamAdmin }),
                ...(body.userId !== undefined && { userId: body.userId }),
                ...(body.email !== undefined && { email: body.email }),
                ...(body.interestSource !== undefined && { interestSource: body.interestSource }),
                ...(body.interestVerified !== undefined && { interestVerified: body.interestVerified }),
                updatedAt: new Date().toISOString()
            };

            // Rebuild legacy support
            updated.teamMemberships = buildLegacyTeamMemberships(updated);
            participations[index] = updated;
            await participationsStorage.saveAll(participations);

            return { status: 200, jsonBody: updated };
        } catch (error) {
            context.error('Error updating participation:', error);
            return { status: 500, jsonBody: { error: 'Failed to update participation' } };
        }
    }
});

// DELETE /api/participations/:id - Delete a participation
app.http('participations-delete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'participations/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];
            const email = participation.email;
            const userId = participation.userId;
            const eventId = participation.eventId;

            // Remove the participation
            participations.splice(index, 1);
            await participationsStorage.saveAll(participations);

            // Cascade: clean up related data
            let cleaned = { invitations: 0, deliveries: 0, sequenceProgress: 0 };

            // 1. Clean up invitations for this email + event
            try {
                const invData = await invitationsStorage.getRaw();
                const invitations = invData?.invitations || [];
                const before = invitations.length;
                const filtered = invitations.filter(inv => 
                    !(inv.email?.toLowerCase() === email?.toLowerCase() && inv.eventId === eventId)
                );
                if (filtered.length < before) {
                    cleaned.invitations = before - filtered.length;
                    await invitationsStorage.saveRaw({ invitations: filtered });
                }
            } catch (e) { context.log(`Warning: invitation cleanup failed: ${e.message}`); }

            // 2. Clean up email deliveries for this user/email
            try {
                const delData = await deliveriesStorage.getRaw() || { deliveries: [] };
                const deliveries = delData.deliveries || [];
                const before = deliveries.length;
                const filtered = deliveries.filter(d => {
                    if (userId && d.userId === userId) return false;
                    if (email && d.email?.toLowerCase() === email.toLowerCase()) return false;
                    return true;
                });
                if (filtered.length < before) {
                    cleaned.deliveries = before - filtered.length;
                    await deliveriesStorage.saveRaw({ deliveries: filtered });
                }
            } catch (e) { context.log(`Warning: delivery cleanup failed: ${e.message}`); }

            // 3. Clean up sequence progress
            try {
                const progData = await sequenceProgressStorage.getRaw();
                const progress = progData?.progress || progData || [];
                if (Array.isArray(progress)) {
                    const before = progress.length;
                    const filtered = progress.filter(p => 
                        !(p.userId === userId && p.eventId === eventId)
                    );
                    if (filtered.length < before) {
                        cleaned.sequenceProgress = before - filtered.length;
                        await sequenceProgressStorage.saveRaw(progData?.progress ? { progress: filtered } : filtered);
                    }
                }
            } catch (e) { context.log(`Warning: sequence progress cleanup failed: ${e.message}`); }

            context.log(`Deleted participation ${id} (${email}). Cleaned: ${cleaned.invitations} invitations, ${cleaned.deliveries} deliveries, ${cleaned.sequenceProgress} sequence progress`);

            return { status: 200, jsonBody: { success: true, cleaned } };
        } catch (error) {
            context.error('Error deleting participation:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete participation' } };
        }
    }
});


// ============================================================
// ROLES MANAGEMENT
// ============================================================

// PUT /api/participations/:id/roles - Add or remove roles
app.http('participations-update-roles-v2', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'participations/{id}/roles',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            const { add, remove, set } = body;

            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];
            let roles = participation.roles || migrateRoles(participation);

            // 'set' replaces the entire roles array
            if (set && Array.isArray(set)) {
                const invalid = set.filter(r => !VALID_ROLES.includes(r));
                if (invalid.length > 0) {
                    return { status: 400, jsonBody: { error: `Invalid roles: ${invalid.join(', ')}. Valid: ${VALID_ROLES.join(', ')}` } };
                }
                roles = [...new Set(set)];
            } else {
                // 'add' appends roles
                if (add && Array.isArray(add)) {
                    const invalid = add.filter(r => !VALID_ROLES.includes(r));
                    if (invalid.length > 0) {
                        return { status: 400, jsonBody: { error: `Invalid roles: ${invalid.join(', ')}` } };
                    }
                    roles = [...new Set([...roles, ...add])];
                }
                // 'remove' removes roles
                if (remove && Array.isArray(remove)) {
                    roles = roles.filter(r => !remove.includes(r));
                }
            }

            participation.roles = roles;
            participation.updatedAt = new Date().toISOString();

            // If participant/judge/committee was just added, handle side effects
            const addedActionableRole = add?.some(r => ['participant', 'judge', 'committee'].includes(r));
            if (addedActionableRole && participation.userId) {
                await removeFromInterestQueue(participation.userId, participation.eventId, context);
                await triggerSequenceEmails(participation.userId, participation.eventId, context);

                if (participation.email) {
                    sendInterestAcknowledgmentEmail(participation.email, participation.eventId, context)
                        .then(result => {
                            if (result?.success) context.log(`Interest acknowledgment sent to ${participation.email}`);
                        })
                        .catch(err => context.error(`Failed interest ack to ${participation.email}:`, err));
                }
            }

            // Rebuild legacy support
            participation.teamMemberships = buildLegacyTeamMemberships(participation);
            participations[index] = participation;
            await participationsStorage.saveAll(participations);

            context.log(`Roles updated for participation ${id}: [${roles.join(', ')}]`);
            return { status: 200, jsonBody: participation };
        } catch (error) {
            context.error('Error updating roles:', error);
            return { status: 500, jsonBody: { error: 'Failed to update roles' } };
        }
    }
});


// ============================================================
// TEAM ASSIGNMENT
// ============================================================

// PUT /api/participations/:id/team - Assign to a team
app.http('participations-assign-team', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'participations/{id}/team',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            const { teamId, isTeamAdmin } = body;

            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];

            if (teamId) {
                // Validate team exists
                const teams = await teamsStorage.getAll();
                const team = teams.find(t => t.id === teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }

                // Check max team size
                const events = await eventsStorage.getAll();
                const event = events.find(e => e.id === participation.eventId);
                const maxSize = event?.maxTeamSize || 5;

                const currentCount = participations.filter(p =>
                    p.teamId === teamId && p.roles?.includes('participant') && p.id !== id
                ).length;

                if (currentCount >= maxSize) {
                    return {
                        status: 400,
                        jsonBody: { error: `Team has reached maximum of ${maxSize} participants`, currentCount }
                    };
                }

                // Auto-add 'participant' role if not present
                if (!participation.roles) participation.roles = [];
                if (!participation.roles.includes('participant')) {
                    participation.roles.push('participant');
                }
            }

            participation.teamId = teamId || null;
            participation.isTeamAdmin = isTeamAdmin || false;
            participation.updatedAt = new Date().toISOString();

            // Rebuild legacy
            participation.teamMemberships = buildLegacyTeamMemberships(participation);
            participations[index] = participation;
            await participationsStorage.saveAll(participations);

            // Side effects for joining a team
            if (teamId && participation.userId) {
                await removeFromInterestQueue(participation.userId, participation.eventId, context);
                await triggerSequenceEmails(participation.userId, participation.eventId, context);

                if (participation.email) {
                    sendInterestAcknowledgmentEmail(participation.email, participation.eventId, context)
                        .then(result => {
                            if (result?.success) context.log(`Interest acknowledgment sent to ${participation.email}`);
                        })
                        .catch(err => context.error(`Failed interest ack:`, err));
                }
            }

            context.log(`Team assignment updated for participation ${id}: team=${teamId}`);
            return { status: 200, jsonBody: participation };
        } catch (error) {
            context.error('Error assigning team:', error);
            return { status: 500, jsonBody: { error: 'Failed to assign team' } };
        }
    }
});


// ============================================================
// HOTEL
// ============================================================

// PUT /api/participations/:id/hotel - Update hotel nights
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
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            participations[index] = {
                ...participations[index],
                hotelNights,
                updatedAt: new Date().toISOString()
            };

            await participationsStorage.saveAll(participations);

            context.log(`Hotel nights updated for participation ${id}`);
            return { status: 200, jsonBody: participations[index] };
        } catch (error) {
            context.error('Error updating hotel nights:', error);
            return { status: 500, jsonBody: { error: 'Failed to update hotel nights' } };
        }
    }
});


// ============================================================
// QUERY ENDPOINTS
// ============================================================

// GET /api/participations/event/:eventId - All participations for an event (with optional role filter)
app.http('participations-by-event', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'participations/event/{eventId}',
    handler: async (request, context) => {
        try {
            const eventId = request.params.eventId;
            const role = request.query.get('role'); // Optional: filter by role

            const participations = await participationsStorage.getAll();
            let results = participations.filter(p => p.eventId === eventId);

            // Migration: ensure roles exist
            results.forEach(p => {
                if (!p.roles) p.roles = migrateRoles(p);
                if (!p.teamMemberships) p.teamMemberships = buildLegacyTeamMemberships(p);
            });

            // Filter by role if specified
            if (role) {
                results = results.filter(p => p.roles.includes(role));
            }

            return { status: 200, jsonBody: results };
        } catch (error) {
            context.error('Error getting participations by event:', error);
            return { status: 500, jsonBody: { error: 'Failed to get participations' } };
        }
    }
});

// GET /api/participations/person/:email - All participations for a person across events
app.http('participations-by-person', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'participations/person/{email}',
    handler: async (request, context) => {
        try {
            const email = decodeURIComponent(request.params.email);

            const participations = await participationsStorage.getAll();
            const personParticipations = participations.filter(p =>
                p.email?.toLowerCase() === email.toLowerCase()
            );

            // Also check by userId if we can resolve email -> user
            const users = await usersStorage.getAll();
            const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
            if (user) {
                participations.forEach(p => {
                    if (p.userId === user.id && !personParticipations.find(pp => pp.id === p.id)) {
                        personParticipations.push(p);
                    }
                });
            }

            // Migration
            personParticipations.forEach(p => {
                if (!p.roles) p.roles = migrateRoles(p);
            });

            // Enrich with event names
            const events = await eventsStorage.getAll();
            const enriched = personParticipations.map(p => ({
                ...p,
                eventName: events.find(e => e.id === p.eventId)?.name || 'Unknown Event'
            }));

            return { status: 200, jsonBody: enriched };
        } catch (error) {
            context.error('Error getting participations by person:', error);
            return { status: 500, jsonBody: { error: 'Failed to get participations' } };
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

            // New model: flat teamId
            let teamParticipations = participations.filter(p => p.teamId === teamId);

            // Legacy fallback: also check teamMemberships array
            if (teamParticipations.length === 0) {
                teamParticipations = participations.filter(p => {
                    const memberships = p.teamMemberships || [];
                    return memberships.some(m => m.teamId === teamId);
                });
            }

            // Migration
            teamParticipations.forEach(p => {
                if (!p.roles) p.roles = migrateRoles(p);
            });

            return { status: 200, jsonBody: teamParticipations };
        } catch (error) {
            context.error('Error getting participations by team:', error);
            return { status: 500, jsonBody: { error: 'Failed to get participations' } };
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
                // New model
                if (p.teamId === teamId && p.roles?.includes('participant')) {
                    participantCount++;
                    if (p.isTeamAdmin) adminCount++;
                    continue;
                }
                // Legacy fallback
                const membership = (p.teamMemberships || []).find(m => m.teamId === teamId);
                if (membership) {
                    if (membership.isAdmin) adminCount++;
                    if (membership.isParticipant) participantCount++;
                }
            }

            return {
                status: 200,
                jsonBody: { teamId, adminCount, participantCount, maxParticipants: 5 }
            };
        } catch (error) {
            context.error('Error getting team count:', error);
            return { status: 500, jsonBody: { error: 'Failed to get team count' } };
        }
    }
});


// ============================================================
// LEGACY COMPATIBILITY ENDPOINTS
// These keep existing frontend pages working during migration
// ============================================================

// POST /api/participations/:id/team-membership - Legacy: add team membership
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
                return { status: 400, jsonBody: { error: 'teamId is required' } };
            }

            const participations = await participationsStorage.getAll();
            const index = participations.findIndex(p => p.id === id);

            if (index < 0) {
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];

            // Check participant constraints
            if (isParticipant) {
                if (participation.teamId && participation.teamId !== teamId && participation.roles?.includes('participant')) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Already a participant on another team', existingTeamId: participation.teamId }
                    };
                }

                const events = await eventsStorage.getAll();
                const event = events.find(e => e.id === participation.eventId);
                const maxSize = event?.maxTeamSize || 5;

                const currentCount = participations.filter(p =>
                    p.teamId === teamId && p.roles?.includes('participant') && p.id !== id
                ).length;

                if (currentCount >= maxSize) {
                    return {
                        status: 400,
                        jsonBody: { error: `Team has reached maximum of ${maxSize} participants`, currentCount }
                    };
                }
            }

            // Update new model
            participation.teamId = teamId;
            participation.isTeamAdmin = isAdmin || false;
            if (!participation.roles) participation.roles = [];
            if (isParticipant && !participation.roles.includes('participant')) {
                participation.roles.push('participant');
            }

            // Also maintain legacy teamMemberships
            participation.teamMemberships = participation.teamMemberships || [];
            const existingIdx = participation.teamMemberships.findIndex(m => m.teamId === teamId);
            if (existingIdx >= 0) {
                participation.teamMemberships[existingIdx] = {
                    teamId, isAdmin: isAdmin || false, isParticipant: isParticipant || false
                };
            } else {
                participation.teamMemberships.push({
                    teamId, isAdmin: isAdmin || false, isParticipant: isParticipant || false
                });
            }

            // When joining a team as participant, team pays for hotel
            if (isParticipant) {
                participation.hotelPaidBy = 'team';
            }

            participation.updatedAt = new Date().toISOString();
            participations[index] = participation;
            await participationsStorage.saveAll(participations);

            // Side effects
            if (isParticipant && participation.userId) {
                await removeFromInterestQueue(participation.userId, participation.eventId, context);
                await triggerSequenceEmails(participation.userId, participation.eventId, context);

                if (participation.email) {
                    // Send team welcome email to new participant
                    sendTeamWelcomeEmail(participation.email, participation.eventId, context)
                        .then(result => {
                            if (result?.success) context.log(`Team welcome email sent to ${participation.email}: ${result.emailsSent} sent, ${result.emailsFailed} failed`);
                        })
                        .catch(err => context.error(`Failed team welcome email:`, err));

                    sendInterestAcknowledgmentEmail(participation.email, participation.eventId, context)
                        .then(result => { if (result?.success) context.log(`Interest ack sent to ${participation.email}`); })
                        .catch(err => context.error(`Failed interest ack:`, err));
                }
            }

            context.log(`Legacy team membership added for participation ${id}, team ${teamId}`);
            return { status: 200, jsonBody: participation };
        } catch (error) {
            context.error('Error adding team membership:', error);
            return { status: 500, jsonBody: { error: 'Failed to add team membership' } };
        }
    }
});

// DELETE /api/participations/:id/team-membership/:teamId - Legacy: remove team membership
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
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];

            // Clear from new model
            if (participation.teamId === teamId) {
                participation.teamId = null;
                participation.isTeamAdmin = false;
                participation.roles = (participation.roles || []).filter(r => r !== 'participant');
            }

            // Clear from legacy
            const memberships = participation.teamMemberships || [];
            const membershipIndex = memberships.findIndex(m => m.teamId === teamId);
            if (membershipIndex >= 0) {
                memberships.splice(membershipIndex, 1);
            }

            participation.teamMemberships = memberships;

            // Update hotelPaidBy: revert to committee if they have that role, otherwise clear
            const hasOtherTeams = memberships.some(m => m.isParticipant);
            if (!hasOtherTeams) {
                const roles = participation.roles || [];
                if (roles.includes('committee') || roles.includes('judge')) {
                    participation.hotelPaidBy = 'committee';
                } else {
                    participation.hotelPaidBy = null;
                    participation.hotelNights = {};
                }
            }

            participation.updatedAt = new Date().toISOString();
            participations[index] = participation;
            await participationsStorage.saveAll(participations);

            context.log(`Legacy team membership removed for participation ${id}, team ${teamId}`);
            return { status: 200, jsonBody: participation };
        } catch (error) {
            context.error('Error removing team membership:', error);
            return { status: 500, jsonBody: { error: 'Failed to remove team membership' } };
        }
    }
});

// PUT /api/participations/:id/team-membership/:teamId/participant - Legacy: toggle participant
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
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];

            // Update new model
            if (!participation.roles) participation.roles = [];
            if (isParticipant) {
                if (!participation.roles.includes('participant')) participation.roles.push('participant');
                participation.teamId = teamId;
            } else {
                participation.roles = participation.roles.filter(r => r !== 'participant');
                if (participation.teamId === teamId) {
                    participation.teamId = null;
                }
            }

            // Update legacy
            const memberships = participation.teamMemberships || [];
            const membershipIndex = memberships.findIndex(m => m.teamId === teamId);
            if (membershipIndex >= 0) {
                memberships[membershipIndex].isParticipant = isParticipant;
            }
            participation.teamMemberships = memberships;

            participation.updatedAt = new Date().toISOString();
            participations[index] = participation;
            await participationsStorage.saveAll(participations);

            // Side effects
            if (isParticipant && participation.userId) {
                await removeFromInterestQueue(participation.userId, participation.eventId, context);

                if (participation.email) {
                    sendInterestAcknowledgmentEmail(participation.email, participation.eventId, context)
                        .then(result => { if (result?.success) context.log(`Interest ack sent to ${participation.email}`); })
                        .catch(err => context.error(`Failed interest ack:`, err));
                }
            }

            context.log(`Legacy participant toggled for participation ${id}, team ${teamId}: ${isParticipant}`);
            return { status: 200, jsonBody: participation };
        } catch (error) {
            context.error('Error toggling participant:', error);
            return { status: 500, jsonBody: { error: 'Failed to toggle participant' } };
        }
    }
});

// PUT /api/participations/:id/team-membership/:teamId/roles - Legacy: update roles on team membership
app.http('participations-update-team-roles', {
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
                return { status: 404, jsonBody: { error: 'Participation not found' } };
            }

            const participation = participations[index];

            // Check participant constraints
            if (isParticipant && !participation.roles?.includes('participant')) {
                if (participation.teamId && participation.teamId !== teamId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Already a participant on another team', existingTeamId: participation.teamId }
                    };
                }

                const events = await eventsStorage.getAll();
                const event = events.find(e => e.id === participation.eventId);
                const maxSize = event?.maxTeamSize || 5;

                const currentCount = participations.filter(p =>
                    p.teamId === teamId && p.roles?.includes('participant') && p.id !== id
                ).length;

                if (currentCount >= maxSize) {
                    return {
                        status: 400,
                        jsonBody: { error: `Team has reached maximum of ${maxSize} participants`, currentCount }
                    };
                }
            }

            // Update new model
            participation.teamId = teamId;
            participation.isTeamAdmin = isAdmin;
            if (!participation.roles) participation.roles = [];
            if (isParticipant && !participation.roles.includes('participant')) {
                participation.roles.push('participant');
            } else if (!isParticipant) {
                participation.roles = participation.roles.filter(r => r !== 'participant');
            }

            // Update legacy
            const memberships = participation.teamMemberships || [];
            const membershipIndex = memberships.findIndex(m => m.teamId === teamId);
            if (membershipIndex >= 0) {
                memberships[membershipIndex].isAdmin = isAdmin;
                memberships[membershipIndex].isParticipant = isParticipant;
            }
            participation.teamMemberships = memberships;

            participation.updatedAt = new Date().toISOString();
            participations[index] = participation;
            await participationsStorage.saveAll(participations);

            context.log(`Legacy team roles updated for participation ${id}, team ${teamId}`);
            return { status: 200, jsonBody: participation };
        } catch (error) {
            context.error('Error updating team roles:', error);
            return { status: 500, jsonBody: { error: 'Failed to update roles' } };
        }
    }
});


// ============================================================
// MIGRATION HELPERS
// ============================================================

// Derive roles from old teamMemberships structure
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

// Build legacy teamMemberships from new flat model
function buildLegacyTeamMemberships(participation) {
    if (participation.teamMemberships && participation.teamMemberships.length > 0) {
        return participation.teamMemberships;
    }

    if (participation.teamId) {
        return [{
            teamId: participation.teamId,
            isAdmin: participation.isTeamAdmin || false,
            isParticipant: participation.roles?.includes('participant') || false
        }];
    }

    return [];
}


console.log('Participations API v2 loaded (with roles[])');
