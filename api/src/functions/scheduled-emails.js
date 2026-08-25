const crypto = require('crypto');
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { sendEmail } = require('../shared/mail');

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

const campaignsStorage = new Storage('email-campaigns');
const leadsStorage = new Storage('interest-leads');
const deliveriesStorage = new Storage('email-deliveries');
const eventsStorage = new Storage('events');
const runsStorage = new Storage('scheduled-runs');
const emailLogStorage = new Storage('email-log');
const participationsStorage = new Storage('participations');
const usersStorage = new Storage('users');

function generateGuid() {
    return crypto.randomUUID();
}

app.http('scheduled-emails-run', {
    methods: ['POST'],
    // Anonymous on purpose: called by an external scheduler, guarded by x-scheduler-secret below.
    authLevel: 'anonymous',
    route: 'scheduled-emails/run',
    handler: async (request, context) => {
        const expectedSecret = process.env.SCHEDULER_SECRET;
        if (expectedSecret) {
            const provided = request.headers.get('x-scheduler-secret');
            if (!provided || !safeEqual(provided, expectedSecret)) {
                context.warn('[SCHEDULED] Unauthorized call - bad or missing secret');
                return { status: 401, jsonBody: { error: 'Unauthorized' } };
            }
        }
        context.log('[MANUAL] Triggering scheduled email check');
        const result = await processScheduledEmails(context);
        return {
            status: 200,
            jsonBody: result
        };
    }
});

async function processScheduledEmails(context) {
    const startTime = new Date();
    context.log(`[SCHEDULED] Starting scheduled email check at ${startTime.toISOString()}`);

    try {
        const now = new Date();
        let emailsSent = 0;
        let emailsFailed = 0;
        const processedCampaigns = [];

        const campaigns = await campaignsStorage.getAll();

        const dueCampaigns = campaigns.filter(c =>
            c.status === 'live' &&
            c.scheduledSendTime &&
            new Date(c.scheduledSendTime) <= now &&
            c.type === 'sequence'
        );

        context.log(`[SCHEDULED] Found ${dueCampaigns.length} campaigns due to send`);

        if (dueCampaigns.length === 0) {
            const result = await recordRun(startTime, 0, 0, [], context);
            return result;
        }

        const leads = (await leadsStorage.getAll()).filter(l => l.verified);
        context.log(`[SCHEDULED] Found ${leads.length} verified leads`);

        const allParticipations = await participationsStorage.getAll();
        const allUsers = await usersStorage.getAll();

        const existingDeliveries = await deliveriesStorage.getAll();

        const events = await eventsStorage.getAll();

        for (const campaign of dueCampaigns) {
            context.log(`[SCHEDULED] Processing campaign: ${campaign.subject}`);

            const event = events.find(e => e.sequenceId === campaign.sequenceId);
            if (!event) {
                context.log(`[SCHEDULED] No event found for sequence ${campaign.sequenceId}`);
                continue;
            }

            const eventParticipations = allParticipations.filter(p => p.eventId === event.id);
            const eventParticipants = eventParticipations
                .map(p => {
                    const user = allUsers.find(u => u.id === p.userId);
                    if (!user) return null;
                    return { email: user.email, firstName: user.firstName, lastName: user.lastName, leadId: null };
                })
                .filter(Boolean);

            const participantEmails = new Set(eventParticipants.map(p => p.email.toLowerCase()));

            const eligibleLeads = leads
                .filter(l => l.eventId === event.id)
                .filter(l => new Date(l.createdAt) <= new Date(campaign.scheduledSendTime))
                .filter(l => !participantEmails.has(l.email.toLowerCase()))
                .map(l => ({ email: l.email, firstName: l.firstName, lastName: l.lastName, leadId: l.id }));

            const allEventRecipients = [...eventParticipants, ...eligibleLeads];

            const recipientsToSend = allEventRecipients.filter(recipient => {
                return !existingDeliveries.some(d =>
                    d.campaignId === campaign.id &&
                    d.email.toLowerCase() === recipient.email.toLowerCase() &&
                    d.status === 'sent'
                );
            });

            context.log(`[SCHEDULED] ${recipientsToSend.length} recipients need this email (${eventParticipants.length} participants + ${eligibleLeads.length} leads)`);

            for (const recipient of recipientsToSend) {
                const delivery = {
                    id: generateGuid(),
                    campaignId: campaign.id,
                    email: recipient.email,
                    leadId: recipient.leadId || null,
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                    scheduledSend: true
                };

                try {
                    await sendEmail({
                        to: recipient.email,
                        subject: campaign.subject,
                        htmlContent: campaign.content,
                        firstName: recipient.firstName || 'Friend',
                        ctaUrl: campaign.ctaUrl,
                        ctaText: campaign.ctaText
                    });

                    delivery.status = 'sent';
                    delivery.sentAt = new Date().toISOString();
                    emailsSent++;
                    context.log(`[SCHEDULED] Sent to ${recipient.email}`);
                } catch (err) {
                    await logError(context, err);
                    delivery.status = 'failed';
                    delivery.errorMessage = err.message;
                    emailsFailed++;
                    context.error(`[SCHEDULED] Failed to send to ${recipient.email}:`, err);
                }

                await deliveriesStorage.create(delivery);
                existingDeliveries.push(delivery);
            }

            processedCampaigns.push({
                id: campaign.id,
                subject: campaign.subject,
                recipients: recipientsToSend.length,
                sent: recipientsToSend.filter((_, i) => i < emailsSent).length,
                failed: recipientsToSend.filter((_, i) => i < emailsFailed).length,
                template: campaign.template || campaign.type
            });
        }

        if (processedCampaigns.length > 0) {
            for (const campaign of processedCampaigns) {
                const emailLog = {
                    id: generateGuid(),
                    templateId: campaign.template || 'sequence',
                    subject: campaign.subject,
                    recipientCount: campaign.recipients,
                    sentAt: new Date().toISOString(),
                    results: {
                        sent: campaign.sent || 0,
                        failed: campaign.failed || 0,
                        errors: []
                    },
                    status: (campaign.failed || 0) === 0 ? 'completed' : 'completed-with-errors',
                    source: 'scheduled',
                    campaignId: campaign.id
                };
                await emailLogStorage.create(emailLog);
            }
            context.log(`[SCHEDULED] Logged ${processedCampaigns.length} campaigns to email-log`);
        }

        const result = await recordRun(startTime, emailsSent, emailsFailed, processedCampaigns, context);

        const duration = (new Date() - startTime) / 1000;
        context.log(`[SCHEDULED] Complete: ${emailsSent} sent, ${emailsFailed} failed in ${duration}s`);

        return result;

    } catch (error) {
        await logError(context, error);
        context.error('[SCHEDULED] ERROR:', error);
        const result = await recordRun(startTime, 0, 0, [], context, error.message);
        return result;
    }
}

async function recordRun(startTime, sent, failed, campaigns, context, error = null) {
    try {
        const run = {
            id: generateGuid(),
            startTime: startTime.toISOString(),
            endTime: new Date().toISOString(),
            duration: (new Date() - startTime) / 1000,
            emailsSent: sent,
            emailsFailed: failed,
            campaignsProcessed: campaigns.length,
            campaigns: campaigns,
            error: error,
            status: error ? 'error' : 'success'
        };

        await runsStorage.create(run);

        const allRuns = await runsStorage.getAll();
        if (allRuns.length > 100) {
            const sorted = allRuns.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
            for (const old of sorted.slice(100)) {
                await runsStorage.delete(old.id);
            }
        }

        context.log(`[SCHEDULED] Run recorded: ${run.id}`);

        return run;
    } catch (err) {
        await logError(context, err);
        context.error('[SCHEDULED] Failed to record run:', err);
        return null;
    }
}

console.log('Scheduled emails timer loaded');
