// ACDC Portal - Email Deliveries API
const { app } = require('@azure/functions');
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
    authLevel: 'anonymous',
    route: 'deliveries/scheduled-runs',
    handler: async (request, context) => {
        try {
            const data = await runsStorage.getRaw() || { runs: [] };
            
            // Return last 10 runs
            const recentRuns = data.runs.slice(0, 10);
            
            return {
                status: 200,
                jsonBody: { runs: recentRuns }
            };
        } catch (err) {
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
    authLevel: 'anonymous',
    route: 'deliveries/event/{eventId}',
    handler: async (request, context) => {
        try {
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
            const campaignData = await campaignsStorage.getRaw();
            const sequenceCampaigns = (campaignData?.campaigns || [])
                .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence')
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

            const campaignIds = new Set(sequenceCampaigns.map(c => c.id));

            // Get all deliveries for these campaigns
            const deliveryData = await deliveriesStorage.getRaw() || { deliveries: [] };
            const eventDeliveries = deliveryData.deliveries.filter(d => campaignIds.has(d.campaignId));

            // Get all verified leads for this event
            const leadsData = await leadsStorage.getRaw();
            const eventLeads = (leadsData.leads || [])
                .filter(l => l.eventId === eventId && l.verified);

            // Get all participations for this event to find judges, committee, and participants
            const participationsData = await participationsStorage.getRaw();
            const eventParticipations = (participationsData?.participations || [])
                .filter(p => p.eventId === eventId);

            // Build recipients from participations (with their roles)
            const leadEmails = new Set(eventLeads.map(l => l.email.toLowerCase()));
            const users = await usersStorage.getAll();
            const recipients = eventParticipations
                .map(p => {
                    const user = users.find(u => u.id === p.userId);
                    if (!user) return null;
                    // Skip if already an interest lead (they appear in leads)
                    if (leadEmails.has(user.email.toLowerCase())) return null;
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

            return {
                status: 200,
                jsonBody: {
                    deliveries: eventDeliveries,
                    leads: eventLeads,
                    recipients: recipients,
                    campaigns: sequenceCampaigns,
                    totalSequenceEmails: sequenceCampaigns.length
                }
            };
        } catch (error) {
            context.error('Error getting deliveries:', error);
            return { status: 500, jsonBody: { error: 'Failed to get deliveries' } };
        }
    }
});

// POST /api/deliveries/retry - Retry a failed delivery
app.http('deliveries-retry', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'deliveries/retry',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { deliveryId } = body;

            if (!deliveryId) {
                return { status: 400, jsonBody: { error: 'deliveryId is required' } };
            }

            // Get the delivery record
            const deliveryData = await deliveriesStorage.getRaw() || { deliveries: [] };
            const deliveryIndex = deliveryData.deliveries.findIndex(d => d.id === deliveryId);

            if (deliveryIndex < 0) {
                return { status: 404, jsonBody: { error: 'Delivery not found' } };
            }

            const delivery = deliveryData.deliveries[deliveryIndex];

            // Get campaign details
            const campaignData = await campaignsStorage.getRaw();
            const campaign = campaignData?.campaigns?.find(c => c.id === delivery.campaignId);

            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            // Get lead details
            const leadsData = await leadsStorage.getRaw();
            const lead = leadsData.leads?.find(l => l.id === delivery.leadId);

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
                
                // Update delivery record
                deliveryData.deliveries[deliveryIndex] = {
                    ...delivery,
                    status: 'sent',
                    sentAt: new Date().toISOString(),
                    error: null,
                    retriedAt: new Date().toISOString()
                };

                await deliveriesStorage.saveRaw(deliveryData);

                return {
                    status: 200,
                    jsonBody: { 
                        message: 'Email sent successfully',
                        delivery: deliveryData.deliveries[deliveryIndex]
                    }
                };
            } catch (err) {
                context.log(`[RETRY] ERROR sending email: ${err.message}`);
                context.error(err);
                
                // Update delivery record with new error
                deliveryData.deliveries[deliveryIndex] = {
                    ...delivery,
                    status: 'failed',
                    error: err.message,
                    retriedAt: new Date().toISOString()
                };

                await deliveriesStorage.saveRaw(deliveryData);

                return {
                    status: 500,
                    jsonBody: { 
                        error: 'Failed to send email',
                        message: err.message,
                        delivery: deliveryData.deliveries[deliveryIndex]
                    }
                };
            }
        } catch (error) {
            context.error('Error retrying delivery:', error);
            return { status: 500, jsonBody: { error: 'Failed to retry delivery' } };
        }
    }
});
