const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { readData, writeData } = require('../shared/storage');
const { sendEmail, processTemplate } = require('../shared/mail');
const { uploadFile } = require('../shared/storage');
const { buildInvitationEmail } = require('../shared/invitation-email');
const { buildEmailHtml } = require('../shared/email-builder');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;

/**
 * Extract image src from HTML (handles both <img> tags and plain base64 strings)
 * @param {string} html - HTML content or base64 string
 * @returns {string} - Image src attribute value or original string
 */
function extractImageSrc(html) {
    if (!html) return '';
    
    // If it's already a data URL or regular URL, return as-is
    if (html.startsWith('data:') || html.startsWith('http')) {
        return html;
    }
    
    // Try to extract src from <img> tag
    const srcMatch = html.match(/src="([^"]+)"/);
    if (srcMatch) {
        return srcMatch[1];
    }
    
    // Return empty if no match
    return '';
}

// POST /api/system-emails/upload-theme - Upload theme image
app.http('system-emails-upload-theme', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'system-emails/upload-theme',
    handler: async (request, context) => {
        try {
            const formData = await request.formData();
            const imageFile = formData.get('image');
            const eventId = formData.get('eventId');
            const templateType = formData.get('templateType');

            if (!imageFile || !eventId || !templateType) {
                return { status: 400, jsonBody: { error: 'Missing required fields' } };
            }

            // Generate filename: template-type_event-id_timestamp.ext
            const ext = path.extname(imageFile.name);
            const filename = `${templateType}_${eventId}_${Date.now()}${ext}`;
            const filepath = `email-themes/${filename}`;

            // Read file buffer
            const buffer = Buffer.from(await imageFile.arrayBuffer());

            // Save file to data/email-themes/
            const fs = require('fs').promises;
            const themesDir = path.join(__dirname, '../../data/email-themes');
            
            // Create directory if it doesn't exist
            await fs.mkdir(themesDir, { recursive: true });
            
            const fullPath = path.join(themesDir, filename);
            await fs.writeFile(fullPath, buffer);

            // Return public URL (relative to web root)
            const publicUrl = `/data/email-themes/${filename}`;

            return { 
                status: 200, 
                jsonBody: { 
                    url: publicUrl,
                    filename: filename
                } 
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error uploading theme:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// GET /api/system-emails/config - Get template configuration
app.http('system-emails-config-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'system-emails/config',
    handler: async (request, context) => {
        try {
            const config = await readData('system-email-config.json');
            return { status: 200, jsonBody: config };
        } catch (error) {
            await logError(context, error);
            context.error('Error loading config:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

const KNOWN_TEMPLATE_KEYS = ['invitation-judge', 'invitation-committee', 'interest-acknowledgment', 'team-welcome', 'team-registration'];

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

// PUT /api/system-emails/config - Save template configuration
app.http('system-emails-config-put', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'system-emails/config',
    handler: async (request, context) => {
        try {
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
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// POST /api/system-emails/test - Send test email
app.http('system-emails-test', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'system-emails/test',
    handler: async (request, context) => {
        try {
            const { templateType, eventId, testEmail, data } = await request.json();
            
            // Load config
            const config = await readData('system-email-config.json');
            const template = config.templates[templateType];
            
            if (!template) {
                return { status: 404, jsonBody: { error: 'Template not found' } };
            }

            // Load events
            const eventsData = await readData('events.json');
            const event = eventsData.find(e => e.id === eventId);
            
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            let htmlContent, subject;

            // For invitation templates, route through the proper build functions
            // so the test email matches what a real invitation would produce
            if (templateType === 'invitation-judge' || templateType === 'invitation-committee') {
                // Create a synthetic invitation object for the test
                const fakeInvitation = {
                    id: uuidv4(),
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
                // Non-invitation templates — use generic path
                const eventTheme = template.eventThemes[eventId] || {};
                const globalDefaults = template.editableSections;
                
                // Extract image src from HTML (themeImage is stored as HTML with <img> tag)
                
                const portalUrl = process.env.PORTAL_URL || 'https://mango-ocean-075da8303.2.azurestaticapps.net';
                const fakeInviteId = uuidv4();

                const baseData = {
                    firstName: data?.fullName?.split(' ')[0] || 'Test',
                    fullName: data?.fullName || 'Test User',
                    ...data,
                    eventName: event.name,
                    portalUrl: portalUrl,
                    acceptUrl: `${portalUrl}?invite=${fakeInviteId}`,
                    inviteId: fakeInviteId,
                    inviterName: data?.teamAdminName || 'Event Organizer'
                };
                // Pre-resolve merge fields inside body/closing before injecting into the template
                const mergeData = {
                    ...baseData,
                    bodyText: processTemplate(eventTheme.body || globalDefaults.body || '', baseData),
                    closingText: processTemplate(eventTheme.closing || globalDefaults.closing || '', baseData)
                };

                // Build HTML using the JSON-driven builder
                htmlContent = buildEmailHtml(template, mergeData);

                // Process subject with merge fields
                subject = processTemplate(template.subject, mergeData);
            }

            // Send test email
            await sendEmail({
                to: testEmail,
                subject: subject,
                htmlContent: htmlContent
            });

            return { status: 200, jsonBody: { message: 'Test email sent' } };
        } catch (error) {
            await logError(context, error);
            context.error('Error sending test email:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// POST /api/system-emails/preview - Render a template with sample data and return HTML
app.http('system-emails-preview', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'system-emails/preview',
    handler: async (request, context) => {
        try {
            const { templateType, eventId, bodyText, closingText } = await request.json();

            const config = await readData('system-email-config.json');
            const template = config.templates[templateType];
            if (!template) {
                return { status: 404, jsonBody: { error: 'Template not found' } };
            }

            const eventsData = await readData('events.json');
            const event = eventsData.find(e => e.id === eventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            const eventTheme = template.eventThemes?.[eventId] || {};
            const globalDefaults = template.editableSections;
            const portalUrl = process.env.PORTAL_URL || 'https://mango-ocean-075da8303.2.azurestaticapps.net';
            const fakeInviteId = 'preview-invite-id';

            // Sample values used to substitute merge fields inside body/closing text
            const sampleData = {
                firstName: 'Jane',
                fullName: 'Jane Smith',
                teamName: 'Sample Team Alpha',
                teamAdminName: 'John Admin',
                committedParticipants: '4',
                eventName: event.name,
                inviterName: 'Event Organizer',
                portalUrl: portalUrl,
                acceptUrl: `${portalUrl}?invite=${fakeInviteId}`,
                inviteId: fakeInviteId,
                interestLink: `${portalUrl}/event.html`
            };

            // Pre-process body/closing so {{mergeFields}} inside them are resolved
            // before they get injected into the template (processTemplate is single-pass)
            const rawBody = bodyText !== undefined ? bodyText : (eventTheme.body || globalDefaults.body || '');
            const rawClosing = closingText !== undefined ? closingText : (eventTheme.closing || globalDefaults.closing || '');

            const mergeData = {
                ...sampleData,
                bodyText: processTemplate(rawBody, sampleData),
                closingText: processTemplate(rawClosing, sampleData)
            };

            // Build HTML using the JSON-driven builder
            const htmlContent = buildEmailHtml(template, mergeData);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                jsonBody: { html: htmlContent }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error rendering preview:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// POST /api/system-emails/send - Send system email (called by team creation, etc.)
app.http('system-emails-send', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'system-emails/send',
    handler: async (request, context) => {
        try {
            const { templateType, eventId, to, data } = await request.json();
            
            // Load config
            const config = await readData('system-email-config.json');
            const template = config.templates[templateType];
            
            if (!template) {
                return { status: 404, jsonBody: { error: 'Template not found' } };
            }

            // Load events
            const eventsData = await readData('events.json');
            const event = eventsData.find(e => e.id === eventId);
            
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            // Build merge data
            const eventTheme = template.eventThemes[eventId] || {};
            const globalDefaults = template.editableSections;

            const baseData = {
                ...data,
                eventName: event.name,
                portalUrl: process.env.PORTAL_URL || 'https://your-portal.com'
            };
            // Pre-resolve merge fields inside body/closing before injecting into the template
            const mergeData = {
                ...baseData,
                bodyText: processTemplate(eventTheme.body || globalDefaults.body || '', baseData),
                closingText: processTemplate(eventTheme.closing || globalDefaults.closing || '', baseData)
            };

            // Build HTML using the JSON-driven builder
            const htmlContent = buildEmailHtml(template, mergeData);

            // Process subject with merge fields
            const subject = processTemplate(template.subject, mergeData);

            // Send email
            await sendEmail({
                to: to,
                subject: subject,
                htmlContent: htmlContent
            });

            return { status: 200, jsonBody: { message: 'Email sent' } };
        } catch (error) {
            await logError(context, error);
            context.error('Error sending email:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});
