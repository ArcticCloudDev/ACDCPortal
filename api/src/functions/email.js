const { app } = require('@azure/functions');
const { readData, writeData } = require('../shared/storage');
const { sendEmail, sendBulkEmail, processTemplate, SENDER_EMAIL } = require('../shared/mail');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

// Helper to get template
async function getTemplate(templateName) {
    const templatePath = path.join(__dirname, `../../../data/email-templates/${templateName}.html`);
    try {
        return await fs.readFile(templatePath, 'utf8');
    } catch (error) {
        throw new Error(`Template '${templateName}' not found`);
    }
}

// List available templates
app.http('email-templates', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'email/templates',
    handler: async (request, context) => {
        try {
            const templatesDir = path.join(__dirname, '../../../data/email-templates');
            const files = await fs.readdir(templatesDir);
            const templates = files
                .filter(f => f.endsWith('.html'))
                .map(f => ({
                    id: f.replace('.html', ''),
                    name: f.replace('.html', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                }));
            
            return { status: 200, jsonBody: templates };
        } catch (error) {
            context.error('Error listing templates:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Get template content
app.http('email-template-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'email/templates/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const template = await getTemplate(id);
            return { status: 200, jsonBody: { id, content: template } };
        } catch (error) {
            context.error('Error getting template:', error);
            return { status: 404, jsonBody: { error: error.message } };
        }
    }
});

// Preview email (apply template with data)
app.http('email-preview', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'email/preview',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { templateId, data } = body;
            
            if (!templateId) {
                return { status: 400, jsonBody: { error: 'templateId is required' } };
            }
            
            // Ensure data has defaults for required fields
            const templateData = {
                subject: data?.subject || 'Preview Subject',
                firstName: data?.firstName || 'User',
                content: data?.content || '<p>Your content will appear here...</p>',
                ctaUrl: data?.ctaUrl || null,
                ctaText: data?.ctaText || 'Learn More',
                ...data // Override with any provided data
            };
            
            const template = await getTemplate(templateId);
            const preview = processTemplate(template, templateData);
            
            return { status: 200, jsonBody: { html: preview } };
        } catch (error) {
            context.error('Error previewing email:', error);
            return { status: 500, jsonBody: { error: error.message, stack: error.stack } };
        }
    }
});

// Get recipients by filter (event-based)
app.http('email-recipients', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'email/recipients',
    handler: async (request, context) => {
        try {
            const eventId = request.query.get('eventId');
            const filter = request.query.get('filter') || 'all-participants';
            
            if (!eventId) {
                return { status: 400, jsonBody: { error: 'eventId is required' } };
            }

            // Load all data
            const usersData = await readData('users.json');
            const users = Array.isArray(usersData) ? usersData : (usersData.users || []);
            
            const teamsData = await readData('teams.json');
            const teams = Array.isArray(teamsData) ? teamsData : (teamsData.teams || []);
            
            const participationsData = await readData('participations.json');
            const participations = Array.isArray(participationsData) ? participationsData : (participationsData.participations || []);
            
            const invitationsData = await readData('invitations.json');
            const invitations = Array.isArray(invitationsData) ? invitationsData : (invitationsData.invitations || []);
            
            const soloQueueData = await readData('solo-queue.json');
            const soloQueue = Array.isArray(soloQueueData) ? soloQueueData : (soloQueueData.entries || []);

            // Get teams for this event
            const eventTeams = teams.filter(t => t.eventId === eventId);
            const eventTeamIds = eventTeams.map(t => t.id);

            // Get participations for event teams
            const eventParticipations = participations.filter(p => eventTeamIds.includes(p.teamId));
            const participantUserIds = eventParticipations.map(p => p.userId);

            let recipients = [];

            switch (filter) {
                case 'all-participants':
                    // All users who are participating in teams for this event
                    recipients = users.filter(u => participantUserIds.includes(u.id));
                    break;

                case 'team-admins':
                    // Team admins for this event
                    const adminEmails = eventTeams.map(t => t.adminEmail);
                    recipients = users.filter(u => adminEmails.includes(u.email));
                    break;

                case 'team-members':
                    // Team members who are NOT admins
                    const nonAdminParticipations = eventParticipations.filter(p => !p.isAdmin);
                    const memberUserIds = nonAdminParticipations.map(p => p.userId);
                    recipients = users.filter(u => memberUserIds.includes(u.id));
                    break;

                case 'solo-queue':
                    // Solo queue participants for this event
                    const soloForEvent = soloQueue.filter(s => s.eventId === eventId);
                    const soloUserIds = soloForEvent.map(s => s.userId);
                    recipients = users.filter(u => soloUserIds.includes(u.id));
                    break;

                case 'pending-invites':
                    // Pending invitations for teams in this event
                    const pendingInvites = invitations.filter(i => 
                        eventTeamIds.includes(i.teamId) && i.status === 'pending'
                    );
                    // Return invitation emails (may not be registered users)
                    recipients = pendingInvites.map(i => ({
                        id: i.id,
                        email: i.email,
                        firstName: i.email.split('@')[0],
                        lastName: '',
                        isPendingInvite: true
                    }));
                    return { status: 200, jsonBody: recipients };

                default:
                    recipients = users.filter(u => participantUserIds.includes(u.id));
            }
            
            const formattedRecipients = recipients.map(u => ({
                id: u.id,
                email: u.email,
                firstName: u.firstName || u.email.split('@')[0],
                lastName: u.lastName || '',
                displayName: u.firstName ? `${u.firstName} ${u.lastName || ''}`.trim() : u.email.split('@')[0]
            }));
            
            return { status: 200, jsonBody: formattedRecipients };
        } catch (error) {
            context.error('Error getting recipients:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Send email
app.http('email-send', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'email/send',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { 
                templateId, 
                subject, 
                recipients, 
                data,
                senderId,
                senderName 
            } = body;
            
            if (!templateId || !subject || !recipients || recipients.length === 0) {
                return { status: 400, jsonBody: { error: 'templateId, subject, and recipients are required' } };
            }
            
            const template = await getTemplate(templateId);
            
            // For personalized emails, we need to send individually
            // For bulk (same content), we can batch
            const emailLog = {
                id: uuidv4(),
                templateId,
                subject,
                recipientCount: recipients.length,
                senderId,
                senderName,
                sentAt: new Date().toISOString(),
                status: 'sending',
                results: { sent: 0, failed: 0, errors: [] }
            };
            
            // Send emails
            for (const recipient of recipients) {
                const personalizedData = {
                    ...data,
                    firstName: recipient.firstName || recipient.email.split('@')[0],
                    lastName: recipient.lastName || '',
                    email: recipient.email,
                    year: new Date().getFullYear().toString()
                };
                
                const htmlContent = processTemplate(template, personalizedData);
                
                try {
                    await sendEmail({
                        to: recipient.email,
                        subject: subject,
                        htmlContent
                    });
                    emailLog.results.sent++;
                } catch (error) {
                    emailLog.results.failed++;
                    emailLog.results.errors.push({
                        email: recipient.email,
                        error: error.message
                    });
                }
            }
            
            emailLog.status = emailLog.results.failed === 0 ? 'completed' : 'completed-with-errors';
            
            // Save to log
            const logData = await readData('email-log.json');
            logData.emails.push(emailLog);
            await writeData('email-log.json', logData);
            
            return { status: 200, jsonBody: emailLog };
        } catch (error) {
            context.error('Error sending email:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Get email history
app.http('email-history', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'email/history',
    handler: async (request, context) => {
        try {
            const logData = await readData('email-log.json');
            // Return most recent first
            const emails = logData.emails.sort((a, b) => 
                new Date(b.sentAt) - new Date(a.sentAt)
            );
            return { status: 200, jsonBody: emails };
        } catch (error) {
            context.error('Error getting email history:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});
