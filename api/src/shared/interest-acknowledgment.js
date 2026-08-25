const Storage = require('./storage');
const { logError } = require('./error-log');
const { buildEmailHtml } = require('./email-builder');

async function sendInterestAcknowledgmentEmail(memberEmail, eventId, context) {
    try {
        const event = await Storage.events.getById(eventId);
        if (!event) {
            context.warn(`Event ${eventId} not found for interest acknowledgment email`);
            return { success: false, reason: 'Event not found' };
        }

        if (!event.sendInterestAcknowledgment) {
            context.log(`Event ${eventId} does not have interest acknowledgment enabled`);
            return { success: false, reason: 'Interest acknowledgment not enabled for event' };
        }

        const interestLeads = await Storage.interestLeads.getAll();
        const wasInterestLead = interestLeads.some(lead =>
            lead.email.toLowerCase() === memberEmail.toLowerCase() &&
            lead.eventId === eventId &&
            lead.verified === true
        );

        if (!wasInterestLead) {
            context.log(`Member ${memberEmail} was not a verified interest lead for event ${eventId}, skipping acknowledgment`);
            return { success: false, reason: 'Not a verified interest lead' };
        }

        const users = await Storage.users.getAll();
        const memberUser = users.find(u => u.email?.toLowerCase() === memberEmail.toLowerCase());
        const fullName = memberUser ? `${memberUser.firstName} ${memberUser.lastName}` : memberEmail;

        const { processTemplate } = require('./mail');
        const config = await Storage.readData('system-email-config.json');
        const template = config.templates['interest-acknowledgment'];

        if (!template) {
            context.warn('Interest acknowledgment template not found in system-email-config.json');
            return { success: false, reason: 'Template not configured' };
        }

        const eventTheme = template.eventThemes[eventId] || {};
        const globalDefaults = template.editableSections || {};

        const rawBody = eventTheme.body || globalDefaults.body || '';
        const rawClosing = eventTheme.closing || globalDefaults.closing || '';
        const fieldData = { fullName, eventName: event.name };
        const bodyText = processTemplate(rawBody, fieldData);
        const closingText = processTemplate(rawClosing, fieldData);

        const baseUrl = process.env.PORTAL_URL || 'https://your-portal.com';
        const mergeData = {
            fullName: fullName,
            eventName: event.name,
            portalUrl: `${baseUrl}/event.html?id=${event.id}`,
            bodyText,
            closingText
        };

        const htmlContent = buildEmailHtml(template, mergeData, eventTheme);

        const subject = processTemplate(eventTheme.subject || template.subject, mergeData);

        const { sendEmail } = require('./mail');
        await sendEmail({
            to: memberEmail,
            subject: subject,
            htmlContent: htmlContent
        });

        context.log(`Interest acknowledgment email sent to ${memberEmail} for event ${event.name}`);

        return {
            success: true,
            emailsSent: 1
        };

    } catch (error) {
        await logError(context, error);
        context.error('Error in sendInterestAcknowledgmentEmail:', error);
        return {
            success: false,
            reason: 'Error sending interest acknowledgment email',
            error: error.message
        };
    }
}

module.exports = {
    sendInterestAcknowledgmentEmail
};
