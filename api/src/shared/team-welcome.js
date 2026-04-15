// Team Welcome Email - Send welcome email when team member joins
const Storage = require('./storage');
const EmailDeliveriesStore = new Storage.Storage('email-deliveries');
const { v4: uuidv4 } = require('uuid');
const { logError } = require('./error-log');
const Email = require('./email');
const { buildEmailHtml } = require('./email-builder');

/**
 * Send welcome email to new team member and optionally digest of sequence emails
 * @param {string} memberEmail - Email of the member who joined
 * @param {string} eventId - Event the team is registered for
 * @param {object} context - Azure Function context for logging
 */
async function sendTeamWelcomeEmail(memberEmail, eventId, context) {
    try {
        // Get event
        const event = await Storage.events.getById(eventId);
        if (!event) {
            context.warn(`Event ${eventId} not found for team welcome email`);
            return { success: false, reason: 'Event not found' };
        }

        // Check if event has welcome email enabled
        if (!event.sendWelcomeEmail) {
            context.log(`Event ${eventId} does not have welcome email enabled`);
            return { success: false, reason: 'Welcome email not enabled for event' };
        }

        // Get member's team to get team name and admin info
        const teams = await Storage.teams.getAll();
        const memberTeam = teams.find(t => 
            t.eventId === eventId && 
            (t.adminEmail?.toLowerCase() === memberEmail.toLowerCase() || 
             t.members?.some(m => m.email?.toLowerCase() === memberEmail.toLowerCase()))
        );

        if (!memberTeam) {
            context.warn(`Team not found for member ${memberEmail} in event ${eventId}`);
            return { success: false, reason: 'Team not found' };
        }

        // Get team admin name
        const users = await Storage.users.getAll();
        const adminUser = users.find(u => u.email?.toLowerCase() === memberTeam.adminEmail?.toLowerCase());
        const teamAdminName = adminUser ? `${adminUser.firstName} ${adminUser.lastName}` : memberTeam.adminEmail;

        // Get member's full name
        const memberUser = users.find(u => u.email?.toLowerCase() === memberEmail.toLowerCase());
        const fullName = memberUser ? `${memberUser.firstName} ${memberUser.lastName}` : memberEmail;

        // Send the welcome email using system email template
        const fs = require('fs').promises;
        const path = require('path');
        const { processTemplate } = require('./mail');

        // Load system email config from SQL
        const config = await Storage.readData('system-email-config.json');
        const template = config.templates['team-welcome'];

        if (!template) {
            context.warn('Team welcome template not found in system-email-config.json');
            return { success: false, reason: 'Template not configured' };
        }

        // Get event-specific theme or use global defaults
        const eventTheme = template.eventThemes[eventId] || {};
        const globalDefaults = template.editableSections;

        // Use eventImage from event if useEventImage is enabled on the template (default true)

        // Build merge data
        const baseData = {
            teamName: memberTeam.teamName,
            fullName: fullName,
            eventName: event.name,
            teamAdminName: teamAdminName,
            portalUrl: process.env.PORTAL_URL || 'https://your-portal.com'
        };
        // Pre-resolve merge fields inside body/closing before injecting into the template
        const mergeData = {
            ...baseData,
            bodyText: processTemplate(eventTheme.body || globalDefaults.body || '', baseData),
            closingText: processTemplate(eventTheme.closing || globalDefaults.closing || '', baseData)
        };

        // Build HTML using the JSON-driven builder — pass per-event structural overrides
        const htmlContent = buildEmailHtml(template, mergeData, eventTheme);

        // Process subject — per-event override first, then global template subject
        const subject = processTemplate(eventTheme.subject || template.subject, mergeData);

        // Send email
        const { sendEmail } = require('./mail');
        await sendEmail({
            to: memberEmail,
            subject: subject,
            htmlContent: htmlContent
        });

        context.log(`Team welcome email sent to ${memberEmail}`);

        // Check if member was an interest lead (verified)
        const interestLeads = await Storage.interestLeads.getAll();
        const wasInterestLead = interestLeads.some(lead => 
            lead.email.toLowerCase() === memberEmail.toLowerCase() && 
            lead.eventId === eventId &&
            lead.isVerified === true
        );

        context.log(`Member ${memberEmail} ${wasInterestLead ? 'was' : 'was not'} an interest lead for event ${eventId}`);

        let emailsSent = 1; // Welcome email was sent
        let emailsFailed = 0;

        // 2. If member was NOT an interest lead and sequence is enabled, send digest of sequence emails they missed
        if (!wasInterestLead && event.sequenceEnabled && event.sequenceId) {
            try {
                const campaigns = await Storage.emailCampaigns.getAll();
                const sequenceCampaigns = campaigns
                    .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence' && c.status === 'live')
                    .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

                if (sequenceCampaigns.length > 0) {
                    // Build message blocks as HTML table rows (same format as interest.js)
                    const messageBlocks = sequenceCampaigns.map((campaign, index) => `
                        <tr>
                            <td style="padding: 0;">
                                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                                    <tr>
                                        <td style="background-color: #1e293b; padding: 14px 40px;">
                                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                                                <tr>
                                                    <td>
                                                        <span style="color: #94a3b8; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase;">UPDATE ${index + 1} OF ${sequenceCampaigns.length}</span>
                                                    </td>
                                                </tr>
                                                <tr>
                                                    <td style="padding-top: 4px;">
                                                        <span style="color: #ffffff; font-size: 18px; font-weight: 700;">${campaign.subject}</span>
                                                    </td>
                                                </tr>
                                            </table>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td style="padding: 28px 40px 8px 40px; color: #334155; font-size: 15px; line-height: 1.75;">
                                            ${campaign.content}
                                        </td>
                                    </tr>
                                    ${campaign.ctaUrl ? `
                                    <tr>
                                        <td style="padding: 0 40px 32px 40px; text-align: center;">
                                            <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                                                <tr>
                                                    <td align="center" bgcolor="#1d4ed8" style="background-color: #1d4ed8; border-radius: 8px; padding: 14px 36px;">
                                                        <a href="${campaign.ctaUrl}" style="display: block; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; line-height: 1.2;">
                                                            ${campaign.ctaText || 'Learn More'}
                                                        </a>
                                                    </td>
                                                </tr>
                                            </table>
                                        </td>
                                    </tr>
                                    ` : `<tr><td style="padding-bottom: 32px;"></td></tr>`}
                                </table>
                            </td>
                        </tr>
                    `).join('');

                    // Load digest template
                    const digestTemplatePath = path.join(__dirname, '../../data/email-templates/sequence-digest.html');
                    const digestTemplate = await fs.readFile(digestTemplatePath, 'utf-8');
                    const digestHtml = processTemplate(digestTemplate, {
                        eventName: event.name,
                        firstName: fullName.split(' ')[0] || 'there',
                        digestCount: sequenceCampaigns.length.toString(),
                        digestContent: messageBlocks,
                        year: new Date().getFullYear().toString()
                    });

                    // Send digest email
                    await sendEmail({
                        to: memberEmail,
                        subject: `${event.name} - Important Updates`,
                        htmlContent: digestHtml
                    });

                    // Record delivery entries for each campaign in the digest
                    for (const campaign of sequenceCampaigns) {
                        await EmailDeliveriesStore.create({
                            id: uuidv4(),
                            campaignId: campaign.id,
                            email: memberEmail,
                            userId: memberUser?.id || null,
                            status: 'sent',
                            sentAt: new Date().toISOString(),
                            sentVia: 'digest',
                            createdAt: new Date().toISOString()
                        });
                    }

                    emailsSent++;
                    context.log(`Sent digest of ${sequenceCampaigns.length} sequence emails to ${memberEmail}`);
                }
            } catch (error) {
                await logError(context, error);
                context.error(`Failed to send sequence digest to ${memberEmail}:`, error);
                emailsFailed++;
            }
        }

        return {
            success: true,
            wasInterestLead,
            emailsSent,
            emailsFailed
        };

    } catch (error) {
        await logError(context, error);
        context.error('Error in sendTeamWelcomeEmail:', error);
        return {
            success: false,
            reason: 'Error sending team welcome email',
            error: error.message
        };
    }
}

module.exports = {
    sendTeamWelcomeEmail
};
