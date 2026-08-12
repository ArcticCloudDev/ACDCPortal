// ACDC Portal - Email Deliveries API
const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { sendEmail } = require('../shared/mail');

const deliveriesStorage = new Storage('email-deliveries');
const leadsStorage = new Storage('interest-leads');
const campaignsStorage = new Storage('email-campaigns');
const eventsStorage = new Storage('events');
const usersStorage = new Storage('users');
const participationsStorage = new Storage('participations');
const runsStorage = new Storage('scheduled-runs');

// GET /api/deliveries/scheduled-runs - Get recent scheduled email runs
app.http('deliveries-scheduled-runs', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'deliveries/scheduled-runs',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const allRuns = await runsStorage.getAll();
            const recentRuns = allRuns
                .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
                .slice(0, 10);
            
            return {
                status: 200,
                jsonBody: { runs: recentRuns }
            };
        } catch (err) {
            await logError(context, err);
            context.error('Failed to get scheduled runs:', err);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get scheduled runs' }
            };
        }
    }
});

// GET /api/deliveries/event/:eventId - Get all deliveries for an event's sequence
app.http('deliveries-event', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'deliveries/event/{eventId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;

            // Get event to find its sequence
            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === eventId);
            
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            // Check if event has a sequence (show deliveries even if sequence is now disabled)
            if (!event.sequenceId) {
                return { 
                    status: 200, 
                    jsonBody: { 
                        deliveries: [],
                        leads: [],
                        campaigns: []
                    } 
                };
            }

            // Get all campaigns for this sequence
            const sequenceCampaigns = (await campaignsStorage.getAll())
                .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence')
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

            const campaignIds = new Set(
                sequenceCampaigns
                    .map(c => (c.id || '').toString().toLowerCase())
                    .filter(Boolean)
            );

            // Get all deliveries for these campaigns
            const allEventDeliveries = await deliveriesStorage.getAll();
            const eventDeliveries = allEventDeliveries.filter(d =>
                campaignIds.has((d.campaignId || '').toString().toLowerCase())
            );

            // Get all verified leads for this event
            const eventLeads = (await leadsStorage.getAll())
                .filter(l => l.eventId === eventId && l.verified);

            // Get all participations for this event to find judges, committee, and participants
            const eventParticipations = (await participationsStorage.getAll())
                .filter(p => p.eventId === eventId);

            // Build recipients from participations (with their roles)
            const users = await usersStorage.getAll();
            const recipients = eventParticipations
                .map(p => {
                    const user = users.find(u => u.id === p.userId);
                    if (!user) return null;
                    // Determine primary role
                    const roles = p.roles || [];
                    let type = 'participant';
                    if (roles.includes('judge')) type = 'judge';
                    else if (roles.includes('committee')) type = 'committee';
                    return {
                        id: user.id,
                        email: user.email,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        type: type
                    };
                })
                .filter(Boolean);

            // Exclude leads who have been converted to participations (they show under their current role)
            const recipientEmails = new Set(recipients.map(r => r.email.toLowerCase()));
            const filteredLeads = eventLeads.filter(l => !recipientEmails.has(l.email.toLowerCase()));

            return {
                status: 200,
                jsonBody: {
                    deliveries: eventDeliveries,
                    leads: filteredLeads,
                    recipients: recipients,
                    campaigns: sequenceCampaigns,
                    totalSequenceEmails: sequenceCampaigns.length
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting deliveries:', error);
            return { status: 500, jsonBody: { error: 'Failed to get deliveries' } };
        }
    }
});

// POST /api/deliveries/retry - Retry a failed delivery
app.http('deliveries-retry', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'deliveries/retry',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { deliveryId } = body;

            if (!deliveryId) {
                return { status: 400, jsonBody: { error: 'deliveryId is required' } };
            }

            // Get the delivery record
            const delivery = await deliveriesStorage.getById(deliveryId);

            if (!delivery) {
                return { status: 404, jsonBody: { error: 'Delivery not found' } };
            }

            // Get campaign details
            const campaign = await campaignsStorage.getById(delivery.campaignId);

            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            // Get lead details
            const lead = await leadsStorage.getById(delivery.leadId);

            if (!lead) {
                return { status: 404, jsonBody: { error: 'Lead not found' } };
            }

            // Attempt to send the email
            try {
                context.log(`[RETRY] Sending email to ${delivery.email}: "${campaign.subject}"`);
                
                await sendEmail({
                    to: delivery.email,
                    subject: campaign.subject,
                    htmlContent: campaign.content,
                    firstName: lead.firstName || 'Friend',
                    ctaUrl: campaign.ctaUrl,
                    ctaText: campaign.ctaText
                });

                context.log(`[RETRY] Email sent successfully!`);
                
                const updatedDelivery = await deliveriesStorage.update(deliveryId, {
                    status: 'sent',
                    sentAt: new Date().toISOString(),
                    errorMessage: null
                });

                return {
                    status: 200,
                    jsonBody: { 
                        message: 'Email sent successfully',
                        delivery: updatedDelivery
                    }
                };
            } catch (err) {
                await logError(context, err);
                context.log(`[RETRY] ERROR sending email: ${err.message}`);
                context.error(err);
                
                const failedDelivery = await deliveriesStorage.update(deliveryId, {
                    status: 'failed',
                    errorMessage: err.message
                });

                return {
                    status: 500,
                    jsonBody: { 
                        error: 'Failed to send email',
                        message: err.message,
                        delivery: failedDelivery
                    }
                };
            }
        } catch (error) {
            await logError(context, error);
            context.error('Error retrying delivery:', error);
            return { status: 500, jsonBody: { error: 'Failed to retry delivery' } };
        }
    }
});

// DELETE /api/deliveries/recipient - Remove all delivery records for a given email (admin cleanup)
app.http('deliveries-delete-recipient', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'deliveries/recipient',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { email } = body;

            if (!email) {
                return { status: 400, jsonBody: { error: 'email is required' } };
            }

            const normalizedEmail = email.toLowerCase().trim();
            const all = await deliveriesStorage.getAll();
            const toDelete = all.filter(d => d.email?.toLowerCase() === normalizedEmail);

            for (const d of toDelete) {
                await deliveriesStorage.delete(d.id);
            }

            context.log(`Deleted ${toDelete.length} delivery record(s) for ${normalizedEmail}`);
            return {
                status: 200,
                jsonBody: { message: `Deleted ${toDelete.length} delivery record(s) for ${normalizedEmail}`, count: toDelete.length }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error deleting deliveries for recipient:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete deliveries' } };
        }
    }
});
