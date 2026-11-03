const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const StorageModule = require('../shared/storage');
const { isGuid } = require('../shared/id');
const { isEmail } = require('../shared/validate');
const q = require('../shared/admin-queries');

app.http('deliveries-event', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'deliveries/event/{eventId}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
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

app.http('deliveries-delete-recipient', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'deliveries/recipient',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
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
