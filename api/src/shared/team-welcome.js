// Team Welcome Email - Send welcome email when team member joins
const Storage = require('./storage');
const Email = require('./email');

/**
 * Send welcome email to new team member and optionally digest of sequence emails
 * @param {string} memberEmail - Email of the member who joined
 * @param {string} eventId - Event the team is registered for
 * @param {object} context - Azure Function context for logging
 */
async function sendTeamWelcomeEmail(memberEmail, eventId, context) {
    try {
        // Get event
        const event = Storage.events.getById(eventId);
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
        const teams = Storage.teams.getAll();
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
        const users = Storage.users.getAll();
        const adminUser = users.find(u => u.email?.toLowerCase() === memberTeam.adminEmail?.toLowerCase());
        const teamAdminName = adminUser ? `${adminUser.firstName} ${adminUser.lastName}` : memberTeam.adminEmail;

        // Get member's full name
        const memberUser = users.find(u => u.email?.toLowerCase() === memberEmail.toLowerCase());
        const fullName = memberUser ? `${memberUser.firstName} ${memberUser.lastName}` : memberEmail;

        // Send the welcome email using system email template
        const fs = require('fs').promises;
        const path = require('path');
        const { processTemplate } = require('./mail');

        // Load system email config
        const configPath = path.join(__dirname, '../../../data/system-email-config.json');
        const configData = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configData);
        const template = config.templates['team-welcome'];

        if (!template) {
            context.warn('Team welcome template not found in system-email-config.json');
            return { success: false, reason: 'Template not configured' };
        }

        // Get event-specific theme or use global defaults
        const eventTheme = template.eventThemes[eventId] || {};
        const globalDefaults = template.editableSections;

        // Extract image src from HTML
        const extractImageSrc = (html) => {
            if (!html) return '';
            const match = html.match(/src="([^"]+)"/);
            return match ? match[1] : html;
        };

        const themeImageSrc = extractImageSrc(eventTheme.themeImage || '');

        // Build merge data
        const mergeData = {
            teamName: memberTeam.teamName,
            fullName: fullName,
            eventName: event.name,
            teamAdminName: teamAdminName,
            themeImage: themeImageSrc,
            bodyText: eventTheme.body || globalDefaults.body || '',
            closingText: eventTheme.closing || globalDefaults.closing || '',
            portalUrl: process.env.PORTAL_URL || 'https://your-portal.com'
        };

        // Load HTML template file
        const templatePath = path.join(__dirname, '../../../data/email-templates/team-welcome.html');
        const templateHtml = await fs.readFile(templatePath, 'utf-8');

        // Process template with merge data
        const htmlContent = processTemplate(templateHtml, mergeData);

        // Process subject with merge fields
        const subject = processTemplate(template.subject, mergeData);

        // Send email
        const { sendEmail } = require('./mail');
        await sendEmail({
            to: memberEmail,
            subject: subject,
            htmlContent: htmlContent
        });

        context.log(`Team welcome email sent to ${memberEmail}`);

        // Check if member was an interest lead (verified)
        const interestLeads = Storage.interestLeads.getAll();
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
                const campaigns = Storage.emailCampaigns.getAll();
                const sequenceCampaigns = campaigns
                    .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence' && c.status === 'live')
                    .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

                if (sequenceCampaigns.length > 0) {
                    // Create digest email
                    let digestBody = `<h2>Important Information You Should Know</h2>`;
                    digestBody += `<p>Since you joined the team, we've sent some important updates about ${event.name}. Here's what you need to know:</p>`;
                    digestBody += `<hr style="margin: 20px 0; border: none; border-top: 2px solid #ddd;">`;
                    
                    sequenceCampaigns.forEach((campaign, index) => {
                        digestBody += `<div style="margin: 30px 0;">`;
                        digestBody += `<h3>${campaign.subject}</h3>`;
                        digestBody += campaign.content;
                        if (index < sequenceCampaigns.length - 1) {
                            digestBody += `<hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">`;
                        }
                        digestBody += `</div>`;
                    });

                    // Send digest email
                    await sendEmail({
                        to: memberEmail,
                        subject: `${event.name} - Important Updates`,
                        htmlContent: digestBody
                    });

                    emailsSent++;
                    context.log(`Sent digest of ${sequenceCampaigns.length} sequence emails to ${memberEmail}`);
                }
            } catch (error) {
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
