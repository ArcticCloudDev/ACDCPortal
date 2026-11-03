const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const StorageModule = require('../shared/storage');
const { sendEmail } = require('../shared/mail');
const { generateId, isGuid } = require('../shared/id');
const { isHttpUrl, isEmail } = require('../shared/validate');
const q = require('../shared/admin-queries');

const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');
const sequencesStorage = new Storage('sequences');

const CAMPAIGN_STATUSES = ['draft', 'live'];

function generateDeliveryId() {
    return generateId();
}

// Validates the writable campaign fields present in `body`. Returns an error string or null.
function validateCampaignBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object';
    if (body.subject !== undefined && (typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 500)) {
        return 'subject must be a non-empty string of at most 500 characters';
    }
    if (body.content !== undefined && typeof body.content !== 'string') return 'content must be a string';
    if (body.ctaUrl !== undefined && body.ctaUrl !== null && body.ctaUrl !== '' && !isHttpUrl(body.ctaUrl)) return 'ctaUrl must be an http(s) URL';
    if (body.ctaText !== undefined && body.ctaText !== null && (typeof body.ctaText !== 'string' || body.ctaText.length > 200)) return 'ctaText must be at most 200 characters';
    if (body.status !== undefined && !CAMPAIGN_STATUSES.includes(body.status)) return `status must be one of: ${CAMPAIGN_STATUSES.join(', ')}`;
    if (body.sequenceOrder !== undefined && body.sequenceOrder !== null && !(Number.isInteger(body.sequenceOrder) && body.sequenceOrder >= 0)) {
        return 'sequenceOrder must be a non-negative integer';
    }
    if (body.scheduledSendTime !== undefined && body.scheduledSendTime !== null && body.scheduledSendTime !== '') {
        if (typeof body.scheduledSendTime !== 'string' || Number.isNaN(new Date(body.scheduledSendTime).getTime())) return 'scheduledSendTime must be an ISO date-time';
    }
    if (body.createdBy !== undefined && body.createdBy !== null && !isGuid(body.createdBy)) return 'createdBy must be a GUID';
    return null;
}

// Recipients list for send: [{ email, userId?, firstName? }]
function validateRecipients(recipients) {
    if (!Array.isArray(recipients) || recipients.length === 0) return 'recipients array is required';
    if (recipients.length > 2000) return 'recipients: at most 2000 per request';
    for (const r of recipients) {
        if (!r || !isEmail(r.email)) return 'Every recipient needs a valid email';
        if (r.userId !== undefined && r.userId !== null && !isGuid(r.userId)) return 'recipient userId must be a GUID';
    }
    return null;
}

function withUserNames(deliveries, users, fallbackToEmail) {
    return deliveries.map(d => {
        const user = users.find(u => (u.email || '').toLowerCase() === (d.email || '').toLowerCase());
        return {
            ...d,
            userName: user ? `${user.firstName} ${user.lastName}` : (fallbackToEmail ? d.email : null)
        };
    });
}

const byRecency = (a, b) => new Date(b.sentAt || b.createdAt) - new Date(a.sentAt || a.createdAt);

app.http('email-campaigns-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/campaigns',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.query.get('eventId');
            let campaigns;

            if (eventId) {
                // Campaigns have no EventId; they belong to the event through its sequence.
                if (!isGuid(eventId)) {
                    return { status: 400, jsonBody: { error: 'eventId must be a GUID' } };
                }
                const event = await StorageModule.events.getById(eventId);
                if (!event) {
                    return { status: 404, jsonBody: { error: 'Event not found' } };
                }
                campaigns = event.sequenceId ? await q.campaignsForSequence(event.sequenceId) : [];
            } else {
                campaigns = await campaignsStorage.getAll();
            }

            campaigns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            const stats = await q.deliveryStatsForCampaigns(campaigns.map(c => c.id));
            campaigns = campaigns.map(campaign => {
                const s = stats[String(campaign.id).toLowerCase()] || { total: 0, sent: 0, failed: 0, pending: 0 };
                return {
                    ...campaign,
                    stats: {
                        total: s.total,
                        sent: s.sent,
                        failed: s.failed,
                        pending: s.pending
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

app.http('email-campaigns-get', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/campaigns/{id}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            const campaign = isGuid(campaignId) ? await campaignsStorage.getById(campaignId) : null;

            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            const deliveries = (await q.deliveriesForCampaigns([campaignId])).sort(byRecency);
            const users = await q.usersByEmails(deliveries.map(d => d.email));
            const enrichedDeliveries = withUserNames(deliveries, users, true);

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

app.http('email-campaigns-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'email/campaigns',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { sequenceId, subject, content, ctaUrl, ctaText, createdBy, status, scheduledSendTime } = body || {};

            if (!sequenceId || !subject || !content) {
                return { status: 400, jsonBody: { error: 'sequenceId, subject, and content are required' } };
            }
            if (!isGuid(sequenceId)) {
                return { status: 400, jsonBody: { error: 'sequenceId must be a GUID' } };
            }
            const validationError = validateCampaignBody(body);
            if (validationError) {
                return { status: 400, jsonBody: { error: validationError } };
            }

            const sequence = await sequencesStorage.getById(sequenceId);
            if (!sequence) {
                return { status: 404, jsonBody: { error: 'Sequence not found' } };
            }

            const sequenceOrder = await q.nextSequenceOrder(sequenceId);

            const campaign = {
                id: generateId(),
                sequenceId,
                subject: subject.trim(),
                content,
                ctaUrl: ctaUrl || null,
                ctaText: ctaText || null,
                type: 'sequence',
                sequenceOrder,
                status: status || 'draft',
                scheduledSendTime: scheduledSendTime || null,
                createdAt: new Date().toISOString(),
                createdBy: createdBy || auth.user.userId || null
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

app.http('email-campaigns-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'email/campaigns/{id}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            const body = await request.json();

            const campaign = isGuid(campaignId) ? await campaignsStorage.getById(campaignId) : null;
            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            const validationError = validateCampaignBody(body);
            if (validationError) {
                return { status: 400, jsonBody: { error: validationError } };
            }

            const updates = {};
            if (body.subject !== undefined) updates.subject = body.subject.trim();
            if (body.content !== undefined) updates.content = body.content;
            if (body.ctaUrl !== undefined) updates.ctaUrl = body.ctaUrl || null;
            if (body.ctaText !== undefined) updates.ctaText = body.ctaText || null;
            if (body.sequenceOrder !== undefined) updates.sequenceOrder = body.sequenceOrder;
            if (body.status !== undefined) updates.status = body.status;
            if (body.scheduledSendTime !== undefined) updates.scheduledSendTime = body.scheduledSendTime || null;
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

app.http('email-campaigns-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'email/campaigns/{id}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;

            const existsEmail = isGuid(campaignId) ? await campaignsStorage.getById(campaignId) : null;
            if (!existsEmail) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            // Deliveries first (either GUID case), then the campaign.
            await q.deleteDeliveriesForCampaigns([campaignId]);
            await campaignsStorage.delete(campaignId);

            return { status: 200, jsonBody: { message: 'Campaign deleted' } };
        } catch (error) {
            await logError(context, error);
            context.error('Campaign delete error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete campaign' } };
        }
    }
});

app.http('email-campaigns-send', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'email/campaigns/{id}/send',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            const body = await request.json();
            const { recipients } = body || {};

            const recipientsError = validateRecipients(recipients);
            if (recipientsError) {
                return { status: 400, jsonBody: { error: recipientsError } };
            }

            const campaign = isGuid(campaignId) ? await campaignsStorage.getById(campaignId) : null;
            if (!campaign) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }

            const existingEmails = new Set(
                (await q.deliveriesForCampaigns([campaignId]))
                    .filter(d => d.status === 'sent')
                    .map(d => d.email.toLowerCase())
            );

            const results = { sent: 0, failed: 0, skipped: 0, errors: [] };

            for (const recipient of recipients) {
                const email = recipient.email.trim();
                if (existingEmails.has(email.toLowerCase())) {
                    results.skipped++;
                    continue;
                }
                existingEmails.add(email.toLowerCase());

                const delivery = {
                    id: generateDeliveryId(),
                    campaignId: campaign.id,
                    email,
                    userId: recipient.userId || null,
                    status: 'pending',
                    createdAt: new Date().toISOString()
                };

                try {
                    await sendEmail({
                        to: email,
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
                    results.errors.push({ email, error: 'Delivery failed' });
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

app.http('email-campaigns-deliveries', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/campaigns/{id}/deliveries',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const campaignId = request.params.id;
            if (!isGuid(campaignId)) {
                return { status: 404, jsonBody: { error: 'Campaign not found' } };
            }
            const deliveries = (await q.deliveriesForCampaigns([campaignId])).sort(byRecency);
            const users = await q.usersByEmails(deliveries.map(d => d.email));
            const enriched = withUserNames(deliveries, users, false);

            return { status: 200, jsonBody: { deliveries: enriched } };
        } catch (error) {
            await logError(context, error);
            context.error('Get deliveries error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get deliveries' } };
        }
    }
});
