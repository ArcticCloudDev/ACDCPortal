const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { readData, writeData } = require('../shared/storage');
const { sendEmail, processTemplate } = require('../shared/mail');
const { uploadFile } = require('../shared/storage');
const { buildInvitationEmail } = require('../shared/invitation-email');
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

// PUT /api/system-emails/config - Save template configuration
app.http('system-emails-config-put', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'system-emails/config',
    handler: async (request, context) => {
        try {
            const config = await request.json();
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
                const themeImageSrc = extractImageSrc(eventTheme.themeImage || '');
                
                const portalUrl = process.env.PORTAL_URL || 'https://mango-ocean-075da8303.2.azurestaticapps.net';
                const fakeInviteId = uuidv4();

                const mergeData = {
                    firstName: data?.fullName?.split(' ')[0] || 'Test',
                    fullName: data?.fullName || 'Test User',
                    ...data,
                    eventName: event.name,
                    themeImage: themeImageSrc,
                    noThemeImage: !themeImageSrc,
                    bodyText: eventTheme.body || globalDefaults.body || '',
                    closingText: eventTheme.closing || globalDefaults.closing || '',
                    portalUrl: portalUrl,
                    acceptUrl: `${portalUrl}?invite=${fakeInviteId}`,
                    inviteId: fakeInviteId,
                    inviterName: data?.teamAdminName || 'Event Organizer'
                };

                // Load HTML template file
                const templatePath = path.join(__dirname, '../../data/email-templates', `${templateType}.html`);
                const templateHtml = await fs.readFile(templatePath, 'utf-8');
                
                // Process template with merge data
                htmlContent = processTemplate(templateHtml, mergeData);
                
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
            
            // Extract image src from HTML (themeImage is stored as HTML with <img> tag)
            const themeImageSrc = extractImageSrc(eventTheme.themeImage || '');
            
            const mergeData = {
                ...data,
                eventName: event.name,
                themeImage: themeImageSrc,
                bodyText: eventTheme.body || globalDefaults.body || '',
                closingText: eventTheme.closing || globalDefaults.closing || '',
                portalUrl: process.env.PORTAL_URL || 'https://your-portal.com'
            };

            // Load HTML template file
            const templatePath = path.join(__dirname, '../../data/email-templates', `${templateType}.html`);
            const templateHtml = await fs.readFile(templatePath, 'utf-8');
            
            // Process template with merge data
            const htmlContent = processTemplate(templateHtml, mergeData);
            
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
