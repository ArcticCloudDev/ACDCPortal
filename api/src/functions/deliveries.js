const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const StorageModule = require('../shared/storage');
const { sendEmail } = require('../shared/mail');
const { isGuid } = require('../shared/id');
const { isEmail } = require('../shared/validate');
const q = require('../shared/admin-queries');

const deliveriesStorage = new Storage('email-deliveries');
const leadsStorage = new Storage('interest-leads');
const campaignsStorage = new Storage('email-campaigns');

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

            const event = isGuid(eventId) ? await StorageModule.events.getById(eventId) : null;

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

            const sequenceCampaigns = await q.campaignsForSequence(event.sequenceId, { type: 'sequence' });
            const eventDeliveries = await q.deliveriesForCampaigns(sequenceCampaigns.map(c => c.id));
            const eventLeads = await q.verifiedLeadsForEvent(eventId);
            const eventParticipations = await q.participationsForEvent(eventId);
            const users = await q.usersByIds(eventParticipations.map(p => p.userId));

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

// Deliveries are created for interest leads (leadId), participants (userId) or plain
// addresses; the greeting name comes from whichever record exists.
async function recipientFirstName(delivery) {
    if (delivery.leadId && isGuid(delivery.leadId)) {
        const lead = await leadsStorage.getById(delivery.leadId);
        if (lead?.firstName) return lead.firstName;
    }
    if (delivery.userId && isGuid(delivery.userId)) {
        const user = await StorageModule.users.getById(delivery.userId);
        if (user?.firstName) return user.firstName;
    }
    if (delivery.email) {
        const user = await StorageModule.users.getByEmail(delivery.email);
        if (user?.firstName) return user.firstName;
    }
    return 'Friend';
}

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
            const { deliveryId } = body || {};

            if (!deliveryId) {
                return { status: 400, jsonBody: { error: 'deliveryId is required' } };
            }
            if (!isGuid(deliveryId)) {
                return { status: 400, jsonBody: { error: 'deliveryId must be a GUID' } };
            }

            const delivery = await deliveriesStorage.getById(deliveryId);

            if (!delivery) {
                return { status: 404, jsonBody: { error: 'Delivery not found' } };
            }

            const campaign = isGuid(delivery.campaignId) ? await campaignsStorage.getById(delivery.campaignId) : null;

            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }
            if (!isEmail(delivery.email)) {
                return { status: 400, jsonBody: { error: 'Delivery has no valid recipient address' } };
            }

            const firstName = await recipientFirstName(delivery);

            try {
                context.log(`[RETRY] Sending email to ${delivery.email}: "${campaign.subject}"`);

                await sendEmail({
                    to: delivery.email,
                    subject: campaign.subject,
                    htmlContent: campaign.content,
                    firstName,
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
                context.error(`[RETRY] ERROR sending email: ${err.message}`);

                const failedDelivery = await deliveriesStorage.update(deliveryId, {
                    status: 'failed',
                    errorMessage: err.message
                });

                return {
                    status: 502,
                    jsonBody: {
                        error: 'Failed to send email',
                        message: 'The mail provider rejected the message; the delivery stays marked as failed.',
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
            const { email } = body || {};

            if (!email) {
                return { status: 400, jsonBody: { error: 'email is required' } };
            }
            if (!isEmail(email)) {
                return { status: 400, jsonBody: { error: 'email must be a valid address' } };
            }

            const normalizedEmail = email.toLowerCase().trim();
            const count = await q.deleteDeliveriesForEmail(normalizedEmail);

            context.log(`Deleted ${count} delivery record(s) for ${normalizedEmail}`);
            return {
                status: 200,
                jsonBody: { message: `Deleted ${count} delivery record(s) for ${normalizedEmail}`, count }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error deleting deliveries for recipient:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete deliveries' } };
        }
    }
});
