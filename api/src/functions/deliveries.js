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

            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === eventId);

            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

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

            const sequenceCampaigns = (await campaignsStorage.getAll())
                .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence')
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

            const campaignIds = new Set(
                sequenceCampaigns
                    .map(c => (c.id || '').toString().toLowerCase())
                    .filter(Boolean)
            );

            const allEventDeliveries = await deliveriesStorage.getAll();
            const eventDeliveries = allEventDeliveries.filter(d =>
                campaignIds.has((d.campaignId || '').toString().toLowerCase())
            );

            const eventLeads = (await leadsStorage.getAll())
                .filter(l => l.eventId === eventId && l.verified);

            const eventParticipations = (await participationsStorage.getAll())
                .filter(p => p.eventId === eventId);

            const users = await usersStorage.getAll();
            const recipients = eventParticipations
                .map(p => {
                    const user = users.find(u => u.id === p.userId);
                    if (!user) return null;
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

            const delivery = await deliveriesStorage.getById(deliveryId);

            if (!delivery) {
                return { status: 404, jsonBody: { error: 'Delivery not found' } };
            }

            const campaign = await campaignsStorage.getById(delivery.campaignId);

            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            const lead = await leadsStorage.getById(delivery.leadId);

            if (!lead) {
                return { status: 404, jsonBody: { error: 'Lead not found' } };
            }

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
