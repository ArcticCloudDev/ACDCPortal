const Storage = require('./storage');
const { logError } = require('./error-log');
const { buildEmailHtml } = require('./email-builder');
const { processTemplate, sendEmail } = require('./mail');

async function sendWelcomeEmail(recipientEmail, eventId, context, opts = {}) {
    try {
        const event = await Storage.events.getById(eventId);
        if (!event) {
            context.log(`[WELCOME] Event ${eventId} not found`);
            return { success: false, reason: 'Event not found' };
        }

        if (!event.sendWelcomeEmail) {
            context.log(`[WELCOME] Welcome email not enabled for event ${eventId}`);
            return { success: false, reason: 'Welcome email not enabled for event' };
        }

        const config = await Storage.readData('system-email-config.json');
        const template = config.templates['welcome'];

        if (!template) {
            context.log('[WELCOME] welcome template not found in system-email-config');
            return { success: false, reason: 'Template not configured' };
        }

        const users = await Storage.users.getAll();
        const user = users.find(u => u.email?.toLowerCase() === recipientEmail.toLowerCase());
        const fullName = user
            ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
            : recipientEmail.split('@')[0];
        const firstName = user?.firstName || fullName.split(' ')[0] || 'there';

        const eventTheme = template.eventThemes?.[eventId] || {};
        const globalDefaults = template.editableSections;

        const baseData = {
            fullName,
            firstName,
            eventName: event.name,
            teamName: opts.teamName || '',
            teamAdminName: opts.teamAdminName || '',
            portalUrl: process.env.PORTAL_URL || 'https://your-portal.com'
        };

        const mergeData = {
            ...baseData,
            bodyText: processTemplate(eventTheme.body || globalDefaults.body || '', baseData),
            closingText: processTemplate(eventTheme.closing || globalDefaults.closing || '', baseData)
        };

        const htmlContent = buildEmailHtml(template, mergeData, eventTheme);
        const subject = processTemplate(eventTheme.subject || template.subject, mergeData);

        await sendEmail({ to: recipientEmail, subject, htmlContent });

        context.log(`[WELCOME] Sent to ${recipientEmail} (team: ${opts.teamName || 'none'})`);
        return { success: true };

    } catch (error) {
        await logError(context, error);
        context.error('[WELCOME] Error sending welcome email:', error);
        return { success: false, reason: error.message };
    }
}

module.exports = { sendWelcomeEmail };
