// Email Campaigns API
// Stores email templates once, tracks deliveries per recipient
const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { sendEmail } = require('../shared/mail');
const { v4: uuidv4 } = require('uuid');

const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');
const usersStorage = new Storage('users');
const participationsStorage = new Storage('participations');
const teamsStorage = new Storage('teams');

function generateId() {
    return uuidv4();
}

function generateDeliveryId() {
    return uuidv4();
}

// GET /api/email/campaigns - List campaigns for an event
app.http('email-campaigns-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/campaigns',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.query.get('eventId');
            let campaigns = await campaignsStorage.getAll();

            if (eventId) {
                campaigns = campaigns.filter(c => c.eventId === eventId);
            }

            // Sort by createdAt desc
            campaigns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            // Add delivery stats
            const deliveries = await deliveriesStorage.getAll();
            campaigns = campaigns.map(campaign => {
                const campaignDeliveries = deliveries.filter(d => d.campaignId === campaign.id);
                return {
                    ...campaign,
                    stats: {
                        total: campaignDeliveries.length,
                        sent: campaignDeliveries.filter(d => d.status === 'sent').length,
                        failed: campaignDeliveries.filter(d => d.status === 'failed').length,
                        pending: campaignDeliveries.filter(d => d.status === 'pending').length
                    }
                };
            });

            return { status: 200, jsonBody: { campaigns } };
        } catch (error) {
            await logError(context, error);
            context.error('Campaigns list error:', error);
            return { status: 500, jsonBody: { error: 'Failed to list campaigns' } };
        }
    }
});

// GET /api/campaigns/:id - Get campaign by ID (short route)
app.http('campaigns-get', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'campaigns/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            const campaign = await campaignsStorage.getById(campaignId);

            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            return { status: 200, jsonBody: campaign };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign get error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get campaign' } };
        }
    }
});

// GET /api/email/campaigns/:id - Get campaign with deliveries
app.http('email-campaigns-get', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/campaigns/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            const campaign = await campaignsStorage.getById(campaignId);

            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            // Get deliveries for this campaign
            const allDeliveries = await deliveriesStorage.getAll();
            const deliveries = allDeliveries
                .filter(d => d.campaignId === campaignId)
                .sort((a, b) => new Date(b.sentAt || b.createdAt) - new Date(a.sentAt || a.createdAt));

            // Enrich with user names
            const users = await usersStorage.getAll();
            const enrichedDeliveries = deliveries.map(d => {
                const user = users.find(u => u.email === d.email);
                return {
                    ...d,
                    userName: user ? `${user.firstName} ${user.lastName}` : d.email
                };
            });

            return {
                status: 200,
                jsonBody: {
                    campaign,
                    deliveries: enrichedDeliveries,
                    stats: {
                        total: deliveries.length,
                        sent: deliveries.filter(d => d.status === 'sent').length,
                        failed: deliveries.filter(d => d.status === 'failed').length
                    }
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign get error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get campaign' } };
        }
    }
});

// POST /api/campaigns - Create campaign (short route)
app.http('campaigns-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'campaigns',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { sequenceId, subject, content, ctaUrl, ctaText, type, sequenceOrder, status, scheduledSendTime } = body;

            if (!subject || !content) {
                return { status: 400, jsonBody: { error: 'subject and content are required' } };
            }

            const campaign = {
                id: generateId(),
                sequenceId: sequenceId || null,
                subject,
                content,
                ctaUrl: ctaUrl || null,
                ctaText: ctaText || null,
                type: type || 'sequence',
                sequenceOrder: sequenceOrder || null,
                status: status || 'draft',
                scheduledSendTime: scheduledSendTime || null,
                createdAt: new Date().toISOString()
            };

            await campaignsStorage.create(campaign);

            return { status: 201, jsonBody: campaign };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign create error:', error);
            return { status: 500, jsonBody: { error: 'Failed to create campaign' } };
        }
    }
});

// POST /api/email/campaigns - Create a new campaign
app.http('email-campaigns-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'email/campaigns',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { sequenceId, subject, content, ctaUrl, ctaText, createdBy, status, scheduledSendTime } = body;

            if (!sequenceId || !subject || !content) {
                return { status: 400, jsonBody: { error: 'sequenceId, subject, and content are required' } };
            }

            // Calculate sequence order within this sequence
            const allExistingCampaigns = await campaignsStorage.getAll();
            const sequenceEmails = allExistingCampaigns.filter(c => c.sequenceId === sequenceId);
            const sequenceOrder = sequenceEmails.length + 1;

            const campaign = {
                id: generateId(),
                sequenceId,
                subject,
                content,
                ctaUrl: ctaUrl || null,
                ctaText: ctaText || null,
                type: 'sequence',
                sequenceOrder,
                status: status || 'draft',
                scheduledSendTime: scheduledSendTime || null,
                createdAt: new Date().toISOString(),
                createdBy: createdBy || null
            };

            await campaignsStorage.create(campaign);

            return { status: 201, jsonBody: campaign };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign create error:', error);
            return { status: 500, jsonBody: { error: 'Failed to create campaign' } };
        }
    }
});

// PUT /api/campaigns/:id - Update campaign (short route)
app.http('campaigns-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'campaigns/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            const body = await request.json();

            const campaign = await campaignsStorage.getById(campaignId);
            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            const updates = {};
            if (body.subject !== undefined) updates.subject = body.subject;
            if (body.content !== undefined) updates.content = body.content;
            if (body.ctaUrl !== undefined) updates.ctaUrl = body.ctaUrl;
            if (body.ctaText !== undefined) updates.ctaText = body.ctaText;
            if (body.type !== undefined) updates.type = body.type;
            if (body.sequenceOrder !== undefined) updates.sequenceOrder = body.sequenceOrder;
            if (body.status !== undefined) updates.status = body.status;
            if (body.scheduledSendTime !== undefined) updates.scheduledSendTime = body.scheduledSendTime;
            updates.updatedAt = new Date().toISOString();

            const updated = await campaignsStorage.update(campaignId, updates);

            return { status: 200, jsonBody: updated };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign update error:', error);
            return { status: 500, jsonBody: { error: 'Failed to update campaign' } };
        }
    }
});

// PUT /api/email/campaigns/:id - Update campaign
app.http('email-campaigns-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'email/campaigns/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            const body = await request.json();

            const campaign = await campaignsStorage.getById(campaignId);
            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            // Update allowed fields
            const updates = {};
            if (body.subject !== undefined) updates.subject = body.subject;
            if (body.content !== undefined) updates.content = body.content;
            if (body.ctaUrl !== undefined) updates.ctaUrl = body.ctaUrl;
            if (body.ctaText !== undefined) updates.ctaText = body.ctaText;
            if (body.sequenceOrder !== undefined) updates.sequenceOrder = body.sequenceOrder;
            if (body.status !== undefined) updates.status = body.status;
            if (body.scheduledSendTime !== undefined) updates.scheduledSendTime = body.scheduledSendTime;
            updates.updatedAt = new Date().toISOString();

            const updated = await campaignsStorage.update(campaignId, updates);

            return { status: 200, jsonBody: updated };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign update error:', error);
            return { status: 500, jsonBody: { error: 'Failed to update campaign' } };
        }
    }
});

// DELETE /api/campaigns/:id - Delete campaign (short route)
app.http('campaigns-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'campaigns/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;

            const exists = await campaignsStorage.getById(campaignId);
            if (!exists) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }
            await campaignsStorage.delete(campaignId);

            const allDeliveriesForCampaign = await deliveriesStorage.getAll();
            for (const d of allDeliveriesForCampaign.filter(d => d.campaignId === campaignId)) {
                await deliveriesStorage.delete(d.id);
            }

            return { status: 200, jsonBody: { message: 'Campaign deleted' } };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign delete error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete campaign' } };
        }
    }
});

// DELETE /api/email/campaigns/:id - Delete campaign and its deliveries
app.http('email-campaigns-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'email/campaigns/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;

            const existsEmail = await campaignsStorage.getById(campaignId);
            if (!existsEmail) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }
            await campaignsStorage.delete(campaignId);

            const allDeliveriesForEmailCampaign = await deliveriesStorage.getAll();
            for (const d of allDeliveriesForEmailCampaign.filter(d => d.campaignId === campaignId)) {
                await deliveriesStorage.delete(d.id);
            }

            return { status: 200, jsonBody: { message: 'Campaign deleted' } };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign delete error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete campaign' } };
        }
    }
});

// POST /api/email/campaigns/:id/send - Send campaign to recipients
app.http('email-campaigns-send', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'email/campaigns/{id}/send',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            const body = await request.json();
            const { recipients } = body; // Array of { email, userId?, firstName? }

            if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
                return { status: 400, jsonBody: { error: 'recipients array is required' } };
            }

            // Get campaign
            const campaign = await campaignsStorage.getById(campaignId);
            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            // Get existing deliveries to avoid duplicates
            const existingDeliveries = await deliveriesStorage.getAll();
            const existingEmails = new Set(
                existingDeliveries
                    .filter(d => d.campaignId === campaignId && d.status === 'sent')
                    .map(d => d.email.toLowerCase())
            );

            const results = { sent: 0, failed: 0, skipped: 0, errors: [] };

            for (const recipient of recipients) {
                // Skip if already sent
                if (existingEmails.has(recipient.email.toLowerCase())) {
                    results.skipped++;
                    continue;
                }

                const delivery = {
                    id: generateDeliveryId(),
                    campaignId,
                    email: recipient.email,
                    userId: recipient.userId || null,
                    status: 'pending',
                    createdAt: new Date().toISOString()
                };

                try {
                    // Send the email
                    await sendEmail({
                        to: recipient.email,
                        subject: campaign.subject,
                        htmlContent: campaign.content,
                        firstName: recipient.firstName || 'Participant',
                        ctaUrl: campaign.ctaUrl,
                        ctaText: campaign.ctaText
                    });

                    delivery.status = 'sent';
                    delivery.sentAt = new Date().toISOString();
                    results.sent++;
                } catch (err) {
                    await logError(context, err);
                    delivery.status = 'failed';
                    delivery.errorMessage = err.message;
                    results.failed++;
                    results.errors.push({ email: recipient.email, error: err.message });
                }

                await deliveriesStorage.create(delivery);
            }

            return { status: 200, jsonBody: results };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign send error:', error);
            return { status: 500, jsonBody: { error: 'Failed to send campaign' } };
        }
    }
});

// POST /api/email/trigger-sequence - Send sequence emails to a user for an event
// Called when user joins an event
app.http('email-trigger-sequence', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'email/trigger-sequence',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { userId, eventId } = body;

            if (!userId || !eventId) {
                return { status: 400, jsonBody: { error: 'userId and eventId are required' } };
            }

            // Get user
            const users = await usersStorage.getAll();
            const user = users.find(u => u.id === userId);
            if (!user) {
                return { status: 404, jsonBody: { error: 'User not found' } };
            }

            // Get sequence campaigns for this event
            const allCampaignsForEvent = await campaignsStorage.getAll();
            const sequenceCampaigns = allCampaignsForEvent
                .filter(c => c.eventId === eventId && c.type === 'sequence')
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

            if (sequenceCampaigns.length === 0) {
                return { status: 200, jsonBody: { message: 'No sequence emails for this event', sent: 0 } };
            }

            // Get existing deliveries for this user
            const existingUserDeliveries = await deliveriesStorage.getAll();
            const userDeliveries = new Set(
                existingUserDeliveries
                    .filter(d => d.email.toLowerCase() === user.email.toLowerCase() && d.status === 'sent')
                    .map(d => d.campaignId)
            );

            const results = { sent: 0, failed: 0, skipped: 0 };

            for (const campaign of sequenceCampaigns) {
                // Skip if already sent
                if (userDeliveries.has(campaign.id)) {
                    results.skipped++;
                    continue;
                }

                const delivery = {
                    id: generateDeliveryId(),
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
                    results.sent++;
                } catch (err) {
                    await logError(context, err);
                    delivery.status = 'failed';
                    delivery.errorMessage = err.message;
                    results.failed++;
                }

                await deliveriesStorage.create(delivery);
            }

            context.log(`Sequence emails for user ${user.email} on event ${eventId}: sent=${results.sent}, skipped=${results.skipped}`);
            return { status: 200, jsonBody: results };
        } catch (error) {
            await logError(context, error);
            context.error('Trigger sequence error:', error);
            return { status: 500, jsonBody: { error: 'Failed to trigger sequence emails' } };
        }
    }
});

// GET /api/email/campaigns/:id/deliveries - Get deliveries for a campaign
app.http('email-campaigns-deliveries', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/campaigns/{id}/deliveries',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            const allDeliveriesById = await deliveriesStorage.getAll();
            const deliveries = allDeliveriesById
                .filter(d => d.campaignId === campaignId)
                .sort((a, b) => new Date(b.sentAt || b.createdAt) - new Date(a.sentAt || a.createdAt));

            // Enrich with user names
            const users = await usersStorage.getAll();
            const enriched = deliveries.map(d => {
                const user = users.find(u => u.email === d.email);
                return {
                    ...d,
                    userName: user ? `${user.firstName} ${user.lastName}` : null
                };
            });

            return { status: 200, jsonBody: { deliveries: enriched } };
        } catch (error) {
            await logError(context, error);
            context.error('Get deliveries error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get deliveries' } };
        }
    }
});
