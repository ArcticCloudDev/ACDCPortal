// Scheduled Emails
// HTTP endpoint for manual/automated triggering
// When deployed to Azure, can be called by Azure Logic Apps, Power Automate, or an external timer
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { sendEmail } = require('../shared/mail');

const campaignsStorage = new Storage('email-campaigns');
const leadsStorage = new Storage('interest-leads');
const deliveriesStorage = new Storage('email-deliveries');
const eventsStorage = new Storage('events');
const runsStorage = new Storage('scheduled-runs');
const emailLogStorage = new Storage('email-log');

function generateGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// HTTP endpoint - call manually or via an external scheduler (e.g. Azure Logic App)
// Requires X-Scheduler-Secret header matching SCHEDULER_SECRET app setting
app.http('scheduled-emails-run', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'scheduled-emails/run',
    handler: async (request, context) => {
        const expectedSecret = process.env.SCHEDULER_SECRET;
        if (expectedSecret) {
            const provided = request.headers.get('x-scheduler-secret');
            if (!provided || provided !== expectedSecret) {
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

        // Get all campaigns
        const campaignData = await campaignsStorage.getRaw();
        const campaigns = campaignData?.campaigns || [];

        // Filter for live campaigns with scheduledSendTime that has passed
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

        // Get all verified leads
        const leadsData = await leadsStorage.getRaw();
        const leads = (leadsData?.leads || []).filter(l => l.verified);
        context.log(`[SCHEDULED] Found ${leads.length} verified leads`);

        // Get existing deliveries
        const deliveryData = await deliveriesStorage.getRaw() || { deliveries: [] };

        // Get events for context
        const events = await eventsStorage.getAll();

        // Process each due campaign
        for (const campaign of dueCampaigns) {
            context.log(`[SCHEDULED] Processing campaign: ${campaign.subject}`);

            // Find event that uses this campaign's sequence
            const event = events.find(e => e.sequenceId === campaign.sequenceId);
            if (!event) {
                context.log(`[SCHEDULED] No event found for sequence ${campaign.sequenceId}`);
                continue;
            }

            // Get leads for this event who haven't received this campaign
            const eventLeads = leads.filter(l => l.eventId === event.id);
            const recipientsToSend = eventLeads.filter(lead => {
                const alreadySent = deliveryData.deliveries.some(d =>
                    d.campaignId === campaign.id &&
                    d.email.toLowerCase() === lead.email.toLowerCase() &&
                    d.status === 'sent'
                );
                return !alreadySent;
            });

            context.log(`[SCHEDULED] ${recipientsToSend.length} recipients need this email`);

            // Send to each recipient
            for (const lead of recipientsToSend) {
                const delivery = {
                    id: generateGuid(),
                    campaignId: campaign.id,
                    email: lead.email,
                    leadId: lead.id,
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                    scheduledSend: true
                };

                try {
                    await sendEmail({
                        to: lead.email,
                        subject: campaign.subject,
                        htmlContent: campaign.content,
                        firstName: lead.firstName || 'Friend',
                        ctaUrl: campaign.ctaUrl,
                        ctaText: campaign.ctaText
                    });

                    delivery.status = 'sent';
                    delivery.sentAt = new Date().toISOString();
                    emailsSent++;
                    context.log(`[SCHEDULED] Sent to ${lead.email}`);
                } catch (err) {
                    await logError(context, err);
                    delivery.status = 'failed';
                    delivery.error = err.message;
                    emailsFailed++;
                    context.error(`[SCHEDULED] Failed to send to ${lead.email}:`, err);
                }

                deliveryData.deliveries.push(delivery);
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

        // Save all deliveries
        if (deliveryData.deliveries.length > 0) {
            await deliveriesStorage.saveRaw(deliveryData);
        }

        // Log to email-log.json for unified history
        if (processedCampaigns.length > 0) {
            const emailLogData = await emailLogStorage.getRaw() || { emails: [] };
            
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
                emailLogData.emails.push(emailLog);
            }
            
            await emailLogStorage.saveRaw(emailLogData);
            context.log(`[SCHEDULED] Logged ${processedCampaigns.length} campaigns to email-log`);
        }

        // Record this run
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
        const data = await runsStorage.getRaw() || { runs: [] };

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

        // Keep only last 100 runs
        data.runs.unshift(run);
        if (data.runs.length > 100) {
            data.runs = data.runs.slice(0, 100);
        }

        await runsStorage.saveRaw(data);
        context.log(`[SCHEDULED] Run recorded: ${run.id}`);

        return run;
    } catch (err) {
        await logError(context, err);
        context.error('[SCHEDULED] Failed to record run:', err);
        return null;
    }
}

console.log('Scheduled emails timer loaded');
