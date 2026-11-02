const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { readData, writeData } = require('../shared/storage');
const Storage = require('../shared/storage');
const { sendEmail, processTemplate } = require('../shared/mail');
const { buildInvitationEmail } = require('../shared/invitation-email');
const { buildEmailHtml } = require('../shared/email-builder');
const { generateId, isGuid } = require('../shared/id');
const { isEmail } = require('../shared/validate');

const KNOWN_TEMPLATE_KEYS = ['invitation-judge', 'invitation-committee', 'interest-acknowledgment', 'welcome'];
const MAX_THEME_IMAGE_BYTES = 512 * 1024;

// Image type from the file's leading bytes; the client-supplied type/extension is not trusted.
function sniffImageType(buffer) {
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
        && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
    if (buffer.length >= 6 && buffer.toString('latin1', 0, 6).match(/^GIF8[79]a$/)) return 'gif';
    if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    return null;
}

function extractImageSrc(html) {
    if (!html) return '';

    if (html.startsWith('data:') || html.startsWith('http')) {
        return html;
    }

    const srcMatch = html.match(/src="([^"]+)"/);
    if (srcMatch) {
        return srcMatch[1];
    }

    return '';
}

app.http('system-emails-upload-theme', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'system-emails/upload-theme',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            let formData;
            try {
                formData = await request.formData();
            } catch (e) {
                return { status: 400, jsonBody: { error: 'Expected multipart/form-data with an image' } };
            }
            const imageFile = formData.get('image');
            const eventId = formData.get('eventId');
            const templateType = formData.get('templateType');

            if (!imageFile || typeof imageFile === 'string' || !eventId || !templateType) {
                return { status: 400, jsonBody: { error: 'Missing required fields' } };
            }
            if (!KNOWN_TEMPLATE_KEYS.includes(templateType)) {
                return { status: 400, jsonBody: { error: `templateType must be one of: ${KNOWN_TEMPLATE_KEYS.join(', ')}` } };
            }
            if (!isGuid(eventId)) {
                return { status: 400, jsonBody: { error: 'eventId must be a GUID' } };
            }
            if (typeof imageFile.size === 'number' && imageFile.size > MAX_THEME_IMAGE_BYTES) {
                return { status: 400, jsonBody: { error: 'Image too large. Maximum size is 512 KB.' } };
            }

            const event = await Storage.events.getById(eventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            const buffer = Buffer.from(await imageFile.arrayBuffer());
            if (buffer.length === 0 || buffer.length > MAX_THEME_IMAGE_BYTES) {
                return { status: 400, jsonBody: { error: 'Image too large. Maximum size is 512 KB.' } };
            }
            const imageType = sniffImageType(buffer);
            if (!imageType) {
                return { status: 400, jsonBody: { error: 'Image must be a PNG, JPEG, GIF or WebP file' } };
            }

            // Inline data URI: mail.js converts base64 images into CID attachments when sending,
            // and nothing is written to the (non-durable, unserved) Functions filesystem.
            const contentType = `image/${imageType}`;
            const filename = `${templateType}_${eventId.toLowerCase()}_${Date.now()}.${imageType === 'jpeg' ? 'jpg' : imageType}`;

            return {
                status: 200,
                jsonBody: {
                    url: `data:${contentType};base64,${buffer.toString('base64')}`,
                    filename,
                    contentType,
                    size: buffer.length
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error uploading theme:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

app.http('system-emails-config-get', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'system-emails/config',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const config = await readData('system-email-config.json');
            return { status: 200, jsonBody: config };
        } catch (error) {
            await logError(context, error);
            context.error('Error loading config:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

function validateEmailConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return 'Config must be a plain object';
    if (!config.templates || typeof config.templates !== 'object' || Array.isArray(config.templates)) return 'Config must have a templates object';
    for (const [key, t] of Object.entries(config.templates)) {
        if (!KNOWN_TEMPLATE_KEYS.includes(key)) return `Unknown template key: "${key}"`;
        if (!t || typeof t !== 'object') return `Template "${key}" must be an object`;
        if (!t.name || typeof t.name !== 'string') return `Template "${key}" is missing required field: name`;
        if (!t.subject || typeof t.subject !== 'string') return `Template "${key}" is missing required field: subject`;
        if (!Array.isArray(t.mergeFields)) return `Template "${key}" mergeFields must be an array`;
        if (!t.editableSections || typeof t.editableSections !== 'object') return `Template "${key}" editableSections must be an object`;
        if (!t.eventThemes || typeof t.eventThemes !== 'object') return `Template "${key}" eventThemes must be an object`;
        if (t.features !== undefined && !Array.isArray(t.features)) return `Template "${key}" features must be an array`;
    }
    return null;
}

app.http('system-emails-config-put', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'system-emails/config',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const config = await request.json();
            const validationError = validateEmailConfig(config);
            if (validationError) {
                return { status: 400, jsonBody: { error: validationError } };
            }
            await writeData('system-email-config.json', config);
            return { status: 200, jsonBody: { message: 'Config saved' } };
        } catch (error) {
            await logError(context, error);
            context.error('Error saving config:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

// Resolves the template + event pair shared by test/preview/send; returns { error } or { template, event }.
async function resolveTemplateAndEvent(templateType, eventId) {
    if (typeof templateType !== 'string' || !KNOWN_TEMPLATE_KEYS.includes(templateType)) {
        return { error: { status: 404, body: { error: 'Template not found' } } };
    }
    const config = await readData('system-email-config.json');
    const template = config.templates[templateType];
    if (!template) {
        return { error: { status: 404, body: { error: 'Template not found' } } };
    }
    const event = isGuid(eventId) ? await Storage.events.getById(eventId) : null;
    if (!event) {
        return { error: { status: 404, body: { error: 'Event not found' } } };
    }
    return { template, event };
}

app.http('system-emails-test', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'system-emails/test',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { templateType, eventId, testEmail, data } = await request.json();

            if (!isEmail(testEmail)) {
                return { status: 400, jsonBody: { error: 'testEmail must be a valid email address' } };
            }

            const resolved = await resolveTemplateAndEvent(templateType, eventId);
            if (resolved.error) {
                return { status: resolved.error.status, jsonBody: resolved.error.body };
            }
            const { template, event } = resolved;

            let htmlContent, subject;

            if (templateType === 'invitation-judge' || templateType === 'invitation-committee') {
                const fakeInvitation = {
                    id: generateId(),
                    email: testEmail,
                    eventId: eventId,
                    role: templateType === 'invitation-judge' ? 'judge' : 'committee',
                    inviterName: data?.teamAdminName || 'Event Organizer',
                    inviterEmail: testEmail,
                    status: 'pending',
                    createdAt: new Date().toISOString()
                };

                const result = await buildInvitationEmail(fakeInvitation, context);

                if (!result.success) {
                    return { status: 500, jsonBody: { error: `Template build failed: ${result.reason}` } };
                }
                htmlContent = result.htmlContent;
                subject = result.subject;
            } else {
                const eventTheme = template.eventThemes[eventId] || {};
                const globalDefaults = template.editableSections;

                const portalUrl = process.env.PORTAL_URL || 'https://mango-ocean-075da8303.2.azurestaticapps.net';
                const fakeInviteId = generateId();

                const baseData = {
                    firstName: data?.fullName?.split(' ')[0] || 'Test',
                    fullName: data?.fullName || 'Test User',
                    ...data,
                    eventName: event.name,
                    portalUrl: portalUrl,
                    acceptUrl: `${portalUrl}/accept-invitation.html?invite=${fakeInviteId}`,
                    inviteId: fakeInviteId,
                    inviterName: data?.teamAdminName || 'Event Organizer'
                };
                // bodyText/closingText are admin-authored HTML and travel through RAW_HTML_KEYS.
                const mergeData = {
                    ...baseData,
                    bodyText: processTemplate(eventTheme.body || globalDefaults.body || '', baseData),
                    closingText: processTemplate(eventTheme.closing || globalDefaults.closing || '', baseData)
                };

                htmlContent = buildEmailHtml(template, mergeData, eventTheme);

                subject = processTemplate(eventTheme.subject || template.subject, mergeData, { html: false });
            }

            await sendEmail({
                to: testEmail,
                subject: subject,
                htmlContent: htmlContent
            });

            return { status: 200, jsonBody: { message: 'Test email sent' } };
        } catch (error) {
            await logError(context, error);
            context.error('Error sending test email:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

app.http('system-emails-preview', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'system-emails/preview',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { templateType, eventId, bodyText, closingText } = await request.json();

            const resolved = await resolveTemplateAndEvent(templateType, eventId);
            if (resolved.error) {
                return { status: resolved.error.status, jsonBody: resolved.error.body };
            }
            const { template, event } = resolved;
            if ((bodyText !== undefined && typeof bodyText !== 'string') || (closingText !== undefined && typeof closingText !== 'string')) {
                return { status: 400, jsonBody: { error: 'bodyText and closingText must be strings' } };
            }

            const eventTheme = template.eventThemes?.[eventId] || {};
            const globalDefaults = template.editableSections;
            const portalUrl = process.env.PORTAL_URL || 'https://mango-ocean-075da8303.2.azurestaticapps.net';
            const fakeInviteId = 'preview-invite-id';

            const sampleData = {
                firstName: 'Jane',
                fullName: 'Jane Smith',
                teamName: 'Sample Team Alpha',
                teamAdminName: 'John Admin',
                committedParticipants: '4',
                eventName: event.name,
                inviterName: 'Event Organizer',
                portalUrl: portalUrl,
                acceptUrl: `${portalUrl}/accept-invitation.html?invite=${fakeInviteId}`,
                inviteId: fakeInviteId,
                interestLink: `${portalUrl}/event.html`
            };

            const rawBody = bodyText !== undefined ? bodyText : (eventTheme.body || globalDefaults.body || '');
            const rawClosing = closingText !== undefined ? closingText : (eventTheme.closing || globalDefaults.closing || '');

            const mergeData = {
                ...sampleData,
                bodyText: processTemplate(rawBody, sampleData),
                closingText: processTemplate(rawClosing, sampleData)
            };

            const htmlContent = buildEmailHtml(template, mergeData, eventTheme);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                jsonBody: { html: htmlContent }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error rendering preview:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

app.http('system-emails-send', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'system-emails/send',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { templateType, eventId, to, data } = await request.json();

            const recipients = Array.isArray(to) ? to : [to];
            if (recipients.length === 0 || recipients.length > 100 || !recipients.every(isEmail)) {
                return { status: 400, jsonBody: { error: 'to must be a valid email address or a list of at most 100 addresses' } };
            }

            const resolved = await resolveTemplateAndEvent(templateType, eventId);
            if (resolved.error) {
                return { status: resolved.error.status, jsonBody: resolved.error.body };
            }
            const { template, event } = resolved;

            const eventTheme = template.eventThemes[eventId] || {};
            const globalDefaults = template.editableSections;

            const baseData = {
                ...(data && typeof data === 'object' ? data : {}),
                eventName: event.name,
                portalUrl: process.env.PORTAL_URL || 'https://your-portal.com'
            };
            const mergeData = {
                ...baseData,
                bodyText: processTemplate(eventTheme.body || globalDefaults.body || '', baseData),
                closingText: processTemplate(eventTheme.closing || globalDefaults.closing || '', baseData)
            };

            const htmlContent = buildEmailHtml(template, mergeData, eventTheme);

            const subject = processTemplate(eventTheme.subject || template.subject, mergeData, { html: false });

            await sendEmail({
                to: to,
                subject: subject,
                htmlContent: htmlContent
            });

            return { status: 200, jsonBody: { message: 'Email sent' } };
        } catch (error) {
            await logError(context, error);
            context.error('Error sending email:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

module.exports = { sniffImageType, extractImageSrc };
