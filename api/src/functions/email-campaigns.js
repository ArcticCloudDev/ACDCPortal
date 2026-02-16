// Email Campaigns API
// Stores email templates once, tracks deliveries per recipient
const { app } = require('@azure/functions');
const { Storage } = require('../shared/storage');
const { sendEmail } = require('../shared/mail');

const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');
const usersStorage = new Storage('users');
const participationsStorage = new Storage('participations');
const teamsStorage = new Storage('teams');

function generateId() {
    return 'camp_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function generateDeliveryId() {
    return 'del_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// GET /api/email/campaigns - List campaigns for an event
app.http('email-campaigns-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'email/campaigns',
    handler: async (request, context) => {
        try {
            const eventId = request.query.get('eventId');
            const data = await campaignsStorage.getRaw();
            let campaigns = data?.campaigns || [];

            if (eventId) {
                campaigns = campaigns.filter(c => c.eventId === eventId);
            }

            // Sort by createdAt desc
            campaigns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            // Add delivery stats
            const deliveries = (await deliveriesStorage.getRaw())?.deliveries || [];
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
            context.error('Campaigns list error:', error);
            return { status: 500, jsonBody: { error: 'Failed to list campaigns' } };
        }
    }
});

// GET /api/campaigns/:id - Get campaign by ID (short route)
app.http('campaigns-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'campaigns/{id}',
    handler: async (request, context) => {
        try {
            const campaignId = request.params.id;
            const data = await campaignsStorage.getRaw();
            const campaign = (data?.campaigns || []).find(c => c.id === campaignId);

            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            return { status: 200, jsonBody: campaign };
        } catch (error) {
            context.error('Campaign get error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get campaign' } };
        }
    }
});

// GET /api/email/campaigns/:id - Get campaign with deliveries
app.http('email-campaigns-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'email/campaigns/{id}',
    handler: async (request, context) => {
        try {
            const campaignId = request.params.id;
            const data = await campaignsStorage.getRaw();
            const campaign = (data?.campaigns || []).find(c => c.id === campaignId);

            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            // Get deliveries for this campaign
            const deliveriesData = await deliveriesStorage.getRaw();
            const deliveries = (deliveriesData?.deliveries || [])
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
            context.error('Campaign get error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get campaign' } };
        }
    }
});

// POST /api/campaigns - Create campaign (short route)
app.http('campaigns-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'campaigns',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { sequenceId, subject, content, ctaUrl, ctaText, type, sequenceOrder, status, scheduledSendTime } = body;

            if (!subject || !content) {
                return { status: 400, jsonBody: { error: 'subject and content are required' } };
            }

            const data = await campaignsStorage.getRaw() || { campaigns: [] };

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

            data.campaigns.push(campaign);
            await campaignsStorage.saveRaw(data);

            return { status: 201, jsonBody: campaign };
        } catch (error) {
            context.error('Campaign create error:', error);
            return { status: 500, jsonBody: { error: 'Failed to create campaign' } };
        }
    }
});

// POST /api/email/campaigns - Create a new campaign
app.http('email-campaigns-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'email/campaigns',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { sequenceId, subject, content, ctaUrl, ctaText, createdBy, status, scheduledSendTime } = body;

            if (!sequenceId || !subject || !content) {
                return { status: 400, jsonBody: { error: 'sequenceId, subject, and content are required' } };
            }

            const data = await campaignsStorage.getRaw() || { campaigns: [] };

            // Calculate sequence order within this sequence
            const sequenceEmails = data.campaigns.filter(c => c.sequenceId === sequenceId);
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
                status: status || 'draft', // draft or live
                scheduledSendTime: scheduledSendTime || null, // ISO timestamp
                createdAt: new Date().toISOString(),
                createdBy: createdBy || null
            };

            data.campaigns.push(campaign);
            await campaignsStorage.saveRaw(data);

            return { status: 201, jsonBody: campaign };
        } catch (error) {
            context.error('Campaign create error:', error);
            return { status: 500, jsonBody: { error: 'Failed to create campaign' } };
        }
    }
});

// PUT /api/campaigns/:id - Update campaign (short route)
app.http('campaigns-update', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'campaigns/{id}',
    handler: async (request, context) => {
        try {
            const campaignId = request.params.id;
            const body = await request.json();
            const data = await campaignsStorage.getRaw();

            const index = (data?.campaigns || []).findIndex(c => c.id === campaignId);
            if (index === -1) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            const campaign = data.campaigns[index];
            if (body.subject !== undefined) campaign.subject = body.subject;
            if (body.content !== undefined) campaign.content = body.content;
            if (body.ctaUrl !== undefined) campaign.ctaUrl = body.ctaUrl;
            if (body.ctaText !== undefined) campaign.ctaText = body.ctaText;
            if (body.type !== undefined) campaign.type = body.type;
            if (body.sequenceOrder !== undefined) campaign.sequenceOrder = body.sequenceOrder;
            if (body.status !== undefined) campaign.status = body.status;
            if (body.scheduledSendTime !== undefined) campaign.scheduledSendTime = body.scheduledSendTime;
            campaign.updatedAt = new Date().toISOString();

            data.campaigns[index] = campaign;
            await campaignsStorage.saveRaw(data);

            return { status: 200, jsonBody: campaign };
        } catch (error) {
            context.error('Campaign update error:', error);
            return { status: 500, jsonBody: { error: 'Failed to update campaign' } };
        }
    }
});

// PUT /api/email/campaigns/:id - Update campaign
app.http('email-campaigns-update', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'email/campaigns/{id}',
    handler: async (request, context) => {
        try {
            const campaignId = request.params.id;
            const body = await request.json();
            const data = await campaignsStorage.getRaw();

            const index = (data?.campaigns || []).findIndex(c => c.id === campaignId);
            if (index === -1) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            // Update allowed fields
            const campaign = data.campaigns[index];
            if (body.subject !== undefined) campaign.subject = body.subject;
            if (body.content !== undefined) campaign.content = body.content;
            if (body.ctaUrl !== undefined) campaign.ctaUrl = body.ctaUrl;
            if (body.ctaText !== undefined) campaign.ctaText = body.ctaText;
            if (body.sequenceOrder !== undefined) campaign.sequenceOrder = body.sequenceOrder;
            if (body.status !== undefined) campaign.status = body.status; // draft or live
            if (body.scheduledSendTime !== undefined) campaign.scheduledSendTime = body.scheduledSendTime;
            campaign.updatedAt = new Date().toISOString();

            data.campaigns[index] = campaign;
            await campaignsStorage.saveRaw(data);

            return { status: 200, jsonBody: campaign };
        } catch (error) {
            context.error('Campaign update error:', error);
            return { status: 500, jsonBody: { error: 'Failed to update campaign' } };
        }
    }
});

// DELETE /api/campaigns/:id - Delete campaign (short route)
app.http('campaigns-delete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'campaigns/{id}',
    handler: async (request, context) => {
        try {
            const campaignId = request.params.id;

            const campaignData = await campaignsStorage.getRaw();
            const index = (campaignData?.campaigns || []).findIndex(c => c.id === campaignId);
            if (index === -1) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }
            campaignData.campaigns.splice(index, 1);
            await campaignsStorage.saveRaw(campaignData);

            const deliveryData = await deliveriesStorage.getRaw();
            if (deliveryData?.deliveries) {
                deliveryData.deliveries = deliveryData.deliveries.filter(d => d.campaignId !== campaignId);
                await deliveriesStorage.saveRaw(deliveryData);
            }

            return { status: 200, jsonBody: { message: 'Campaign deleted' } };
        } catch (error) {
            context.error('Campaign delete error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete campaign' } };
        }
    }
});

// DELETE /api/email/campaigns/:id - Delete campaign and its deliveries
app.http('email-campaigns-delete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'email/campaigns/{id}',
    handler: async (request, context) => {
        try {
            const campaignId = request.params.id;

            // Delete campaign
            const campaignData = await campaignsStorage.getRaw();
            const index = (campaignData?.campaigns || []).findIndex(c => c.id === campaignId);
            if (index === -1) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }
            campaignData.campaigns.splice(index, 1);
            await campaignsStorage.saveRaw(campaignData);

            // Delete associated deliveries
            const deliveryData = await deliveriesStorage.getRaw();
            if (deliveryData?.deliveries) {
                deliveryData.deliveries = deliveryData.deliveries.filter(d => d.campaignId !== campaignId);
                await deliveriesStorage.saveRaw(deliveryData);
            }

            return { status: 200, jsonBody: { message: 'Campaign deleted' } };
        } catch (error) {
            context.error('Campaign delete error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete campaign' } };
        }
    }
});

// POST /api/email/campaigns/:id/send - Send campaign to recipients
app.http('email-campaigns-send', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'email/campaigns/{id}/send',
    handler: async (request, context) => {
        try {
            const campaignId = request.params.id;
            const body = await request.json();
            const { recipients } = body; // Array of { email, userId?, firstName? }

            if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
                return { status: 400, jsonBody: { error: 'recipients array is required' } };
            }

            // Get campaign
            const campaignData = await campaignsStorage.getRaw();
            const campaign = (campaignData?.campaigns || []).find(c => c.id === campaignId);
            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            // Get existing deliveries to avoid duplicates
            const deliveryData = await deliveriesStorage.getRaw() || { deliveries: [] };
            const existingEmails = new Set(
                deliveryData.deliveries
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
                    delivery.status = 'failed';
                    delivery.error = err.message;
                    results.failed++;
                    results.errors.push({ email: recipient.email, error: err.message });
                }

                deliveryData.deliveries.push(delivery);
            }

            await deliveriesStorage.saveRaw(deliveryData);

            return { status: 200, jsonBody: results };
        } catch (error) {
            context.error('Campaign send error:', error);
            return { status: 500, jsonBody: { error: 'Failed to send campaign' } };
        }
    }
});

// POST /api/email/trigger-sequence - Send sequence emails to a user for an event
// Called when user joins an event
app.http('email-trigger-sequence', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'email/trigger-sequence',
    handler: async (request, context) => {
        try {
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
            const campaignData = await campaignsStorage.getRaw();
            const sequenceCampaigns = (campaignData?.campaigns || [])
                .filter(c => c.eventId === eventId && c.type === 'sequence')
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

            if (sequenceCampaigns.length === 0) {
                return { status: 200, jsonBody: { message: 'No sequence emails for this event', sent: 0 } };
            }

            // Get existing deliveries for this user
            const deliveryData = await deliveriesStorage.getRaw() || { deliveries: [] };
            const userDeliveries = new Set(
                deliveryData.deliveries
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
                    delivery.status = 'failed';
                    delivery.error = err.message;
                    results.failed++;
                }

                deliveryData.deliveries.push(delivery);
            }

            await deliveriesStorage.saveRaw(deliveryData);

            context.log(`Sequence emails for user ${user.email} on event ${eventId}: sent=${results.sent}, skipped=${results.skipped}`);
            return { status: 200, jsonBody: results };
        } catch (error) {
            context.error('Trigger sequence error:', error);
            return { status: 500, jsonBody: { error: 'Failed to trigger sequence emails' } };
        }
    }
});

// GET /api/email/campaigns/:id/deliveries - Get deliveries for a campaign
app.http('email-campaigns-deliveries', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'email/campaigns/{id}/deliveries',
    handler: async (request, context) => {
        try {
            const campaignId = request.params.id;
            const deliveryData = await deliveriesStorage.getRaw();
            const deliveries = (deliveryData?.deliveries || [])
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
            context.error('Get deliveries error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get deliveries' } };
        }
    }
});
