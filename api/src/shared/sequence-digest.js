const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { sendEmail, processTemplate } = require('./mail');
const { logError } = require('./error-log');
const { Storage } = require('./storage');

const eventsStore = new Storage('events');
const campaignsStore = new Storage('email-campaigns');
const deliveriesStore = new Storage('email-deliveries');

function renderMessageBlocks(campaigns) {
    return campaigns.map((campaign, index) => `
        <tr><td style="padding:0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr><td style="background-color:#1e293b;padding:14px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr><td><span style="color:#94a3b8;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">UPDATE ${index + 1} OF ${campaigns.length}</span></td></tr>
                <tr><td style="padding-top:4px;"><span style="color:#ffffff;font-size:18px;font-weight:700;">${campaign.subject}</span></td></tr>
              </table>
            </td></tr>
            <tr><td style="padding:28px 40px 8px 40px;color:#334155;font-size:15px;line-height:1.75;">${campaign.content}</td></tr>
            ${campaign.ctaUrl ? `
            <tr><td style="padding:0 40px 32px 40px;text-align:center;">
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 auto;">
                <tr><td align="center" bgcolor="#1d4ed8" style="background-color:#1d4ed8;border-radius:8px;padding:14px 36px;">
                  <a href="${campaign.ctaUrl}" style="display:block;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;line-height:1.2;">${campaign.ctaText || 'Learn More'}</a>
                </td></tr>
              </table>
            </td></tr>` : `<tr><td style="padding-bottom:32px;"></td></tr>`}
          </table>
        </td></tr>
    `).join('');
}

// Sends all not-yet-delivered live sequence campaigns for an event as one digest email.
async function sendSequenceDigest({ event = null, eventId = null, email, firstName = 'Participant', userId = null }, context) {
    try {
        if (!email) {
            context.log('[SEQUENCE] No email provided, skipping digest');
            return { sent: 0 };
        }

        const resolvedEvent = event || await eventsStore.getById(eventId);
        if (!resolvedEvent || !resolvedEvent.sequenceEnabled || !resolvedEvent.sequenceId) {
            context.log(`[SEQUENCE] Event ${eventId || event?.id} not found or sequence not enabled`);
            return { sent: 0 };
        }

        const allCampaigns = await campaignsStore.getAll();
        const sequenceCampaigns = allCampaigns
            .filter(c => c.sequenceId === resolvedEvent.sequenceId && c.type === 'sequence' && c.status === 'live')
            .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

        if (sequenceCampaigns.length === 0) {
            context.log(`[SEQUENCE] No live sequence campaigns for event ${resolvedEvent.id}`);
            return { sent: 0 };
        }

        const existingDeliveries = await deliveriesStore.getAll();
        const alreadySent = new Set(
            existingDeliveries
                .filter(d => d.email.toLowerCase() === email.toLowerCase() && d.status === 'sent')
                .map(d => d.campaignId)
        );

        const campaignsToSend = sequenceCampaigns.filter(c => !alreadySent.has(c.id));
        if (campaignsToSend.length === 0) {
            context.log(`[SEQUENCE] All sequence emails already sent to ${email}`);
            return { sent: 0 };
        }

        const templatePath = path.join(__dirname, '../../data/email-templates/sequence-digest.html');
        const digestTemplate = await fs.readFile(templatePath, 'utf-8');
        const digestHtml = processTemplate(digestTemplate, {
            eventName: resolvedEvent.name,
            firstName,
            digestCount: campaignsToSend.length.toString(),
            digestContent: renderMessageBlocks(campaignsToSend),
            year: new Date().getFullYear().toString()
        });

        const now = new Date().toISOString();
        try {
            await sendEmail({
                to: email,
                subject: `${resolvedEvent.name} - Important Updates`,
                htmlContent: digestHtml
            });
            for (const campaign of campaignsToSend) {
                await deliveriesStore.create({
                    id: crypto.randomUUID(),
                    campaignId: campaign.id,
                    email,
                    userId,
                    status: 'sent',
                    sentAt: now,
                    sentVia: 'digest',
                    createdAt: now
                });
            }
            context.log(`[SEQUENCE] Sent digest of ${campaignsToSend.length} email(s) to ${email}`);
            return { sent: campaignsToSend.length };
        } catch (err) {
            await logError(context, err);
            for (const campaign of campaignsToSend) {
                await deliveriesStore.create({
                    id: crypto.randomUUID(),
                    campaignId: campaign.id,
                    email,
                    userId,
                    status: 'failed',
                    errorMessage: err.message,
                    createdAt: now
                });
            }
            context.error(`[SEQUENCE] Failed to send digest to ${email}: ${err.message}`);
            return { sent: 0, error: err.message };
        }
    } catch (error) {
        await logError(context, error);
        context.error('[SEQUENCE] Failed to trigger sequence emails:', error);
        return { sent: 0, error: error.message };
    }
}

module.exports = { sendSequenceDigest };
