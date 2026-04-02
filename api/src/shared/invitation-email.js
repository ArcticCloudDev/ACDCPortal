// Invitation Email Builder - Unified builder for judge & committee invitation emails
// Uses the invitation's role to select the correct template and config.
const { readData } = require('./storage');
const { logError } = require('./error-log');

/**
 * Build an invitation email for any role (judge, committee, etc.)
 * The role on the invitation object determines which HTML template and
 * system-email-config section to use:
 *   role 'judge'     → template key 'invitation-judge',     file 'invitation-judge.html'
 *   role 'committee' → template key 'invitation-committee', file 'invitation-committee.html'
 *
 * @param {object} invitation - The invitation object from invitations.json
 * @param {object} context    - Azure Function context for logging
 * @returns {object} { success, htmlContent, subject } or { success: false, reason }
 */
async function buildInvitationEmail(invitation, context) {
    const role = invitation.role; // e.g. 'judge' or 'committee'
    const templateKey = `invitation-${role}`;
    const templateFile = `invitation-${role}.html`;
    const eventFlag = `send${role.charAt(0).toUpperCase() + role.slice(1)}InvitationEmail`;

    try {
        // Get event
        const events = await readData('events.json');
        const event = events.find(e => e.id === invitation.eventId);
        if (!event) {
            context.warn(`Event ${invitation.eventId} not found for ${role} invitation email`);
            return { success: false, reason: 'Event not found' };
        }

        // Check if event has this role's invitation email enabled
        if (!event[eventFlag]) {
            context.log(`Event ${invitation.eventId} does not have ${role} invitation email enabled, using basic send`);
            // Fall through — we still send the email, just without managed template customizations
        }

        // Get invitee's name if they exist in users
        const users = await readData('users.json');
        const inviteeUser = users.find(u => u.email?.toLowerCase() === invitation.email.toLowerCase());
        const firstName = inviteeUser ? inviteeUser.firstName : invitation.email.split('@')[0];
        const fullName = inviteeUser ? `${inviteeUser.firstName} ${inviteeUser.lastName}` : firstName;

        // Load system email config
        const fs = require('fs').promises;
        const path = require('path');
        const { processTemplate } = require('./mail');

        const configPath = path.join(__dirname, '../../data/system-email-config.json');
        const configData = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configData);
        const template = config.templates[templateKey];

        if (!template) {
            context.warn(`${role} invitation template '${templateKey}' not found in system-email-config.json`);
            return { success: false, reason: 'Template not configured' };
        }

        // Get event-specific theme or use global defaults
        const eventTheme = template.eventThemes[invitation.eventId] || {};
        const globalDefaults = template.editableSections;

        // Extract image src from HTML
        const extractImageSrc = (html) => {
            if (!html) return '';
            const match = html.match(/src="([^"]+)"/);
            return match ? match[1] : '';
        };

        const themeImageSrc = extractImageSrc(eventTheme.themeImage || '');

        // Build accept URL from environment
        const portalUrl = process.env.PORTAL_URL || 'https://mango-ocean-075da8303.2.azurestaticapps.net';
        const acceptUrl = `${portalUrl}?invite=${invitation.id}`;
        context.log(`[DEBUG ${role}-invite] acceptUrl: '${acceptUrl}', invitation.id: '${invitation.id}'`);

        // Resolve merge fields in body/closing text (they may contain {{firstName}} etc)
        const rawBody = eventTheme.body || globalDefaults.body || '';
        const rawClosing = eventTheme.closing || globalDefaults.closing || '';
        const fieldData = { firstName, fullName, eventName: event.name, inviterName: invitation.inviterName || 'Event Organizer' };
        const bodyText = processTemplate(rawBody, fieldData);
        const closingText = processTemplate(rawClosing, fieldData);

        // Build merge data
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

        // Load HTML template file
        const templatePath = path.join(__dirname, `../../data/email-templates/${templateFile}`);
        const templateHtml = await fs.readFile(templatePath, 'utf-8');

        // Process template with merge data
        const htmlContent = processTemplate(templateHtml, mergeData);

        // Process subject with merge fields
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
