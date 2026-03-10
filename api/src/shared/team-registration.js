// Team Registration Email - Send confirmation when a team is registered
const Storage = require('./storage');

/**
 * Send registration confirmation email to the team admin
 * This fires for ALL team registrations, regardless of whether the admin participates.
 * @param {string} adminEmail - Email of the person who registered the team
 * @param {string} eventId - Event the team is registered for
 * @param {string} teamName - Name of the team
 * @param {number} committedParticipants - Number of committed participants
 * @param {object} context - Azure Function context for logging
 */
async function sendTeamRegistrationEmail(adminEmail, eventId, teamName, committedParticipants, context) {
    try {
        // Get event
        const event = await Storage.events.getById(eventId);
        if (!event) {
            context.warn(`Event ${eventId} not found for team registration email`);
            return { success: false, reason: 'Event not found' };
        }

        // Get admin's full name
        const users = await Storage.users.getAll();
        const adminUser = users.find(u => u.email?.toLowerCase() === adminEmail.toLowerCase());
        const fullName = adminUser ? `${adminUser.firstName} ${adminUser.lastName}` : adminEmail;

        // Send the registration email using system email template
        const fs = require('fs').promises;
        const path = require('path');
        const { processTemplate, sendEmail } = require('./mail');

        // Load system email config
        const configPath = path.join(__dirname, '../../../data/system-email-config.json');
        const configData = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configData);
        const template = config.templates['team-registration'];

        if (!template) {
            context.warn('Team registration template not found in system-email-config.json');
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
            teamName: teamName,
            fullName: fullName,
            eventName: event.name,
            committedParticipants: committedParticipants || '?',
            themeImage: themeImageSrc,
            bodyText: eventTheme.body || globalDefaults.body || '',
            closingText: eventTheme.closing || globalDefaults.closing || '',
            portalUrl: process.env.PORTAL_URL || 'https://your-portal.com'
        };

        // Load HTML template file
        const templatePath = path.join(__dirname, '../../../data/email-templates/team-registration.html');
        const templateHtml = await fs.readFile(templatePath, 'utf-8');

        // Process template with merge data
        const htmlContent = processTemplate(templateHtml, mergeData);

        // Process subject with merge fields
        const subject = processTemplate(template.subject, mergeData);

        // Send email
        await sendEmail({
            to: adminEmail,
            subject: subject,
            htmlContent: htmlContent
        });

        context.log(`Team registration email sent to ${adminEmail} for team "${teamName}"`);
        return { success: true };

    } catch (error) {
        context.error('Error in sendTeamRegistrationEmail:', error);
        return {
            success: false,
            reason: 'Error sending team registration email',
            error: error.message
        };
    }
}

module.exports = {
    sendTeamRegistrationEmail
};
