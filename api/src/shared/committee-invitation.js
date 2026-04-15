// Committee Invitation Email - Send invitation email when someone is invited to the committee
const { buildEmailHtml } = require('./email-builder');
const Storage = require('./storage');
const { logError } = require('./error-log');

/**
 * Send committee invitation email
 * @param {object} invitation - The invitation object from invitations.json
 * @param {object} context - Azure Function context for logging
 * @returns {object} Result with htmlContent and subject (for use by invitations.js)
 */
async function buildCommitteeInvitationEmail(invitation, context) {
    try {
        // Get event
        const event = await Storage.events.getById(invitation.eventId);
        if (!event) {
            context.warn(`Event ${invitation.eventId} not found for committee invitation email`);
            return { success: false, reason: 'Event not found' };
        }

        // Check if event has committee invitation email enabled
        if (!event.sendCommitteeInvitationEmail) {
            context.log(`Event ${invitation.eventId} does not have committee invitation email enabled, using basic send`);
            // Fall through — we still send the email, just without managed template customizations
        }

        // Get invitee's name if they exist in users
        const inviteeUser = await Storage.users.getByEmail(invitation.email);
        const firstName = inviteeUser ? inviteeUser.firstName : invitation.email.split('@')[0];
        const fullName = inviteeUser ? `${inviteeUser.firstName} ${inviteeUser.lastName}` : firstName;

        // Load system email config from SQL
        const { processTemplate } = require('./mail');
        const config = await Storage.readData('system-email-config.json');
        const template = config.templates['invitation-committee'];

        if (!template) {
            context.warn('Committee invitation template not found in system-email-config.json');
            return { success: false, reason: 'Template not configured' };
        }

        // Get event-specific theme or use global defaults
        const eventTheme = template.eventThemes[invitation.eventId] || {};
        const globalDefaults = template.editableSections;

        // Use eventImage from event if useEventImage is enabled on the template (default true)

        // Build accept URL from environment
        const portalUrl = process.env.PORTAL_URL || 'https://mango-ocean-075da8303.2.azurestaticapps.net';
        const acceptUrl = `${portalUrl}?invite=${invitation.id}`;
        context.log(`[DEBUG committee-invite] acceptUrl: '${acceptUrl}', invitation.id: '${invitation.id}'`);

        // Resolve merge fields in body/closing text (they may contain {{firstName}} etc)
        const rawBody = eventTheme.body || globalDefaults.body || '';
        const rawClosing = eventTheme.closing || globalDefaults.closing || '';
        const fieldData = { firstName, fullName, eventName: event.name, inviterName: invitation.inviterName || 'Event Organizer' };
        const bodyText = processTemplate(rawBody, fieldData);
        const closingText = processTemplate(rawClosing, fieldData);

        // Build merge data
        const mergeData = {
            firstName: firstName,
            fullName: fullName,
            eventName: event.name,
            inviterName: invitation.inviterName || 'Event Organizer',
            inviteId: invitation.id,
            acceptUrl: acceptUrl,
            bodyText: bodyText,
            closingText: closingText
        };

        // Build HTML using the JSON-driven builder — pass per-event structural overrides
        const htmlContent = buildEmailHtml(template, mergeData, eventTheme);

        // Process subject — per-event override first, then global template subject
        const subject = processTemplate(eventTheme.subject || template.subject, mergeData);

        return {
            success: true,
            htmlContent,
            subject
        };

    } catch (error) {
        await logError(context, error);
        context.error('Error in buildCommitteeInvitationEmail:', error);
        return {
            success: false,
            reason: 'Error building committee invitation email',
            error: error.message
        };
    }
}

module.exports = {
    buildCommitteeInvitationEmail
};
