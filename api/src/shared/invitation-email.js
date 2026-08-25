const Storage = require('./storage');
const { logError } = require('./error-log');
const { buildEmailHtml } = require('./email-builder');

async function buildInvitationEmail(invitation, context) {
    const role = invitation.role;
    const templateKey = `invitation-${role}`;
    const eventFlag = `send${role.charAt(0).toUpperCase() + role.slice(1)}InvitationEmail`;

    try {
        const event = await Storage.events.getById(invitation.eventId);
        if (!event) {
            context.warn(`Event ${invitation.eventId} not found for ${role} invitation email`);
            return { success: false, reason: 'Event not found' };
        }

        if (!event[eventFlag]) {
            context.log(`Event ${invitation.eventId} does not have ${role} invitation email enabled, using basic send`);
        }

        const inviteeUser = await Storage.users.getByEmail(invitation.email);
        const firstName = inviteeUser ? inviteeUser.firstName : invitation.email.split('@')[0];
        const fullName = inviteeUser ? `${inviteeUser.firstName} ${inviteeUser.lastName}` : firstName;

        const { processTemplate } = require('./mail');
        const config = await Storage.readData('system-email-config.json');
        const template = config.templates[templateKey];

        if (!template) {
            context.warn(`${role} invitation template '${templateKey}' not found in system-email-config.json`);
            return { success: false, reason: 'Template not configured' };
        }

        const eventTheme = template.eventThemes[invitation.eventId] || {};
        const globalDefaults = template.editableSections;

        const extractImageSrc = (html) => {
            if (!html) return '';
            const match = html.match(/src="([^"]+)"/);
            return match ? match[1] : '';
        };

        const themeImageSrc = extractImageSrc(eventTheme.themeImage || '');

        const portalUrl = process.env.PORTAL_URL || 'https://mango-ocean-075da8303.2.azurestaticapps.net';
        const acceptUrl = `${portalUrl}?invite=${invitation.id}`;
        context.log(`[DEBUG ${role}-invite] acceptUrl: '${acceptUrl}', invitation.id: '${invitation.id}'`);

        const rawBody = eventTheme.body || globalDefaults.body || '';
        const rawClosing = eventTheme.closing || globalDefaults.closing || '';
        const fieldData = { firstName, fullName, eventName: event.name, inviterName: invitation.inviterName || 'Event Organizer' };
        const bodyText = processTemplate(rawBody, fieldData);
        const closingText = processTemplate(rawClosing, fieldData);

        const mergeData = {
            firstName,
            fullName,
            eventName: event.name,
            inviterName: invitation.inviterName || 'Event Organizer',
            inviteId: invitation.id,
            acceptUrl,
            themeImage: themeImageSrc,
            noThemeImage: !themeImageSrc,
            bodyText,
            closingText
        };

        const htmlContent = buildEmailHtml(template, mergeData);

        const subject = processTemplate(template.subject, mergeData);

        return {
            success: true,
            htmlContent,
            subject
        };

    } catch (error) {
        await logError(context, error);
        context.error(`Error in buildInvitationEmail (${role}):`, error);
        return {
            success: false,
            reason: `Error building ${role} invitation email`,
            error: error.message
        };
    }
}

module.exports = {
    buildInvitationEmail
};
