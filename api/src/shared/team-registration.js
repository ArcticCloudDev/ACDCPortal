// Team Registration Email - Send confirmation when a team is registered
const Storage = require('./storage');
const { logError } = require('./error-log');
const { buildEmailHtml } = require('./email-builder');

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

        if (event.sendTeamRegistrationEmail === false) {
            context.log(`Team registration email disabled for event ${eventId}`);
            return { success: false, reason: 'Team registration email disabled for this event' };
        }

        // Get admin's full name
        const users = await Storage.users.getAll();
        const adminUser = users.find(u => u.email?.toLowerCase() === adminEmail.toLowerCase());
        const fullName = adminUser ? `${adminUser.firstName} ${adminUser.lastName}` : adminEmail;

        // Send the registration email using system email template
        const fs = require('fs').promises;
        const path = require('path');
        const { processTemplate, sendEmail } = require('./mail');

        // Load system email config from SQL
        const config = await Storage.readData('system-email-config.json');
        const template = config.templates['team-registration'];

        if (!template) {
            context.warn('Team registration template not found in system-email-config.json');
            return { success: false, reason: 'Template not configured' };
        }

        // Get event-specific theme or use global defaults
        const eventTheme = template.eventThemes[eventId] || {};
        const globalDefaults = template.editableSections;

        // Use eventImage from event if useEventImage is enabled on the template (default true)

        // Build merge data
        const mergeData = {
            teamName: teamName,
            fullName: fullName,
            eventName: event.name,
            committedParticipants: committedParticipants || '?',
            bodyText: eventTheme.body || globalDefaults.body || '',
            closingText: eventTheme.closing || globalDefaults.closing || '',
            portalUrl: process.env.PORTAL_URL || 'https://your-portal.com'
        };

        // Build HTML using the JSON-driven builder — pass per-event structural overrides
        const htmlContent = buildEmailHtml(template, mergeData, eventTheme);

        // Process subject — per-event override first, then global template subject
        const subject = processTemplate(eventTheme.subject || template.subject, mergeData);

        // Send email
        await sendEmail({
            to: adminEmail,
            subject: subject,
            htmlContent: htmlContent
        });

        context.log(`Team registration email sent to ${adminEmail} for team "${teamName}"`);
        return { success: true };

    } catch (error) {
        await logError(context, error);
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
