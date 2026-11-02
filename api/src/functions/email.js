const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const Storage = require('../shared/storage');
const EmailLogStore = new Storage.Storage('email-log');
const { sendEmail, processTemplate } = require('../shared/mail');
const { generateId, isGuid, sameId } = require('../shared/id');
const { isHttpUrl, isEmail } = require('../shared/validate');
const q = require('../shared/admin-queries');
const fs = require('fs').promises;
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '../../data/email-templates');
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_RECIPIENTS = 2000;

// Template ids that exist on disk. Only these may be read, so a templateId can never
// reach the filesystem as a path.
async function listTemplateIds() {
    const files = await fs.readdir(TEMPLATES_DIR);
    return files
        .filter(f => f.endsWith('.html') && TEMPLATE_ID.test(f.slice(0, -5)))
        .map(f => f.slice(0, -5));
}

// Returns the template HTML, or null when the id is not an allow-listed template.
async function getTemplate(templateId) {
    if (typeof templateId !== 'string' || !TEMPLATE_ID.test(templateId)) return null;
    const ids = await listTemplateIds();
    if (!ids.includes(templateId)) return null;
    return fs.readFile(path.join(TEMPLATES_DIR, `${templateId}.html`), 'utf8');
}

function formatRecipient(u) {
    return {
        id: u.id,
        email: u.email,
        firstName: u.firstName || u.email.split('@')[0],
        lastName: u.lastName || '',
        displayName: u.firstName ? `${u.firstName} ${u.lastName || ''}`.trim() : u.email.split('@')[0]
    };
}

// First occurrence per e-mail address wins.
function dedupeByEmail(list) {
    const seen = new Set();
    return list.filter(r => {
        const key = (r.email || '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

app.http('email-templates', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/templates',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const templates = (await listTemplateIds()).map(id => ({
                id,
                name: id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            }));

            return { status: 200, jsonBody: templates };
        } catch (error) {
            await logError(context, error);
            context.error('Error listing templates:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

app.http('email-template-get', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/templates/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const template = await getTemplate(id);
            if (template === null) {
                return { status: 404, jsonBody: { error: 'Template not found' } };
            }
            return { status: 200, jsonBody: { id, content: template } };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting template:', error);
            return { status: 500, jsonBody: { error: 'Failed to get template' } };
        }
    }
});

app.http('email-preview', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'email/preview',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { templateId, data } = body || {};

            if (!templateId) {
                return { status: 400, jsonBody: { error: 'templateId is required' } };
            }

            const template = await getTemplate(templateId);
            if (template === null) {
                return { status: 404, jsonBody: { error: 'Template not found' } };
            }

            const templateData = {
                subject: data?.subject || 'Preview Subject',
                firstName: data?.firstName || 'User',
                content: data?.content || '<p>Your content will appear here...</p>',
                ctaUrl: data?.ctaUrl || null,
                ctaText: data?.ctaText || 'Learn More',
                ...(data && typeof data === 'object' ? data : {})
            };
            if (templateData.ctaUrl && !isHttpUrl(templateData.ctaUrl)) {
                return { status: 400, jsonBody: { error: 'ctaUrl must be an http(s) URL' } };
            }

            const preview = processTemplate(template, templateData);

            return { status: 200, jsonBody: { html: preview } };
        } catch (error) {
            await logError(context, error);
            context.error('Error previewing email:', error);
            return { status: 500, jsonBody: { error: 'Failed to generate preview' } };
        }
    }
});

app.http('email-recipients', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/recipients',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.query.get('eventId');
            const filter = request.query.get('filter') || 'all-participants';

            if (!eventId) {
                return { status: 400, jsonBody: { error: 'eventId is required' } };
            }
            if (!isGuid(eventId)) {
                return { status: 400, jsonBody: { error: 'eventId must be a GUID' } };
            }

            const teams = await q.teamsForEvent(eventId);
            const participations = await q.participationsForEvent(eventId);
            const teamParticipations = participations.filter(p => p.teamId && teams.some(t => sameId(t.id, p.teamId)));
            const users = await q.usersByIds([...participations.map(p => p.userId), ...teams.map(t => t.adminUserId)]);
            const usersFor = ids => users.filter(u => ids.some(id => sameId(id, u.id)));

            let recipients = [];

            switch (filter) {
                case 'all-participants':
                    recipients = usersFor(teamParticipations.map(p => p.userId));
                    break;

                case 'team-admins': {
                    // A team's admin is Teams.AdminUserId or any participation flagged isTeamAdmin.
                    const adminIds = [
                        ...teams.map(t => t.adminUserId),
                        ...teamParticipations.filter(p => p.isTeamAdmin).map(p => p.userId)
                    ];
                    recipients = usersFor(adminIds);
                    break;
                }

                case 'team-members': {
                    const isAdmin = p => p.isTeamAdmin || teams.some(t => sameId(t.id, p.teamId) && sameId(t.adminUserId, p.userId));
                    recipients = usersFor(teamParticipations.filter(p => !isAdmin(p)).map(p => p.userId));
                    break;
                }

                case 'solo-queue': {
                    const soloForEvent = await q.soloQueueForEvent(eventId);
                    recipients = await q.usersByIds(soloForEvent.map(s => s.userId));
                    break;
                }

                case 'pending-invites': {
                    const pendingInvites = await q.pendingInvitationsForEvent(eventId, teams.map(t => t.id));
                    return {
                        status: 200,
                        jsonBody: dedupeByEmail(pendingInvites.map(i => ({
                            id: i.id,
                            email: i.email,
                            firstName: i.inviteeFirstName || i.email.split('@')[0],
                            lastName: i.inviteeLastName || '',
                            isPendingInvite: true
                        })))
                    };
                }

                case 'all-event-contacts': {
                    // Everyone attached to the event (participants, judges, committee) plus verified interest leads.
                    const leads = await q.verifiedLeadsForEvent(eventId);
                    const contacts = [
                        ...usersFor(participations.map(p => p.userId)).map(formatRecipient),
                        ...leads.map(l => formatRecipient({ id: l.id, email: l.email, firstName: l.firstName, lastName: l.lastName }))
                    ];
                    return { status: 200, jsonBody: dedupeByEmail(contacts) };
                }

                default:
                    recipients = usersFor(teamParticipations.map(p => p.userId));
            }

            return { status: 200, jsonBody: dedupeByEmail(recipients.map(formatRecipient)) };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting recipients:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

app.http('email-send', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'email/send',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { templateId, recipients, senderId, senderName } = body || {};
            // Contract: merge fields live in body.data; the admin page also sends them at the
            // top level (subject/content/ctaUrl/ctaText), which used to be silently ignored.
            const data = body?.data && typeof body.data === 'object' ? body.data : {};
            const subject = typeof data.subject === 'string' && data.subject.trim() ? data.subject : body?.subject;
            const content = data.content !== undefined ? data.content : body?.content;
            const ctaUrl = data.ctaUrl !== undefined ? data.ctaUrl : body?.ctaUrl;
            const ctaText = data.ctaText !== undefined ? data.ctaText : body?.ctaText;

            if (!templateId || !subject || !Array.isArray(recipients) || recipients.length === 0) {
                return { status: 400, jsonBody: { error: 'templateId, subject, and recipients are required' } };
            }
            if (typeof subject !== 'string' || subject.length > 500) {
                return { status: 400, jsonBody: { error: 'subject must be a string of at most 500 characters' } };
            }
            if (content !== undefined && content !== null && typeof content !== 'string') {
                return { status: 400, jsonBody: { error: 'content must be a string' } };
            }
            if (ctaUrl && !isHttpUrl(ctaUrl)) {
                return { status: 400, jsonBody: { error: 'ctaUrl must be an http(s) URL' } };
            }
            if (recipients.length > MAX_RECIPIENTS) {
                return { status: 400, jsonBody: { error: `At most ${MAX_RECIPIENTS} recipients per send` } };
            }
            if (!recipients.every(r => r && isEmail(r.email))) {
                return { status: 400, jsonBody: { error: 'Every recipient needs a valid email' } };
            }

            const template = await getTemplate(templateId);
            if (template === null) {
                return { status: 404, jsonBody: { error: 'Template not found' } };
            }

            const mergeData = {
                ...data,
                subject,
                content: content || '',
                ctaUrl: ctaUrl || null,
                ctaText: ctaText || 'Learn More'
            };

            const emailLog = {
                id: generateId(),
                templateId,
                subject,
                recipientCount: recipients.length,
                senderId,
                senderName,
                sentAt: new Date().toISOString(),
                status: 'sending',
                results: { sent: 0, failed: 0, errors: [] }
            };

            for (const recipient of dedupeByEmail(recipients)) {
                const email = recipient.email.trim();
                const personalizedData = {
                    ...mergeData,
                    firstName: recipient.firstName || (typeof recipient.name === 'string' && recipient.name.split(' ')[0]) || email.split('@')[0],
                    lastName: recipient.lastName || '',
                    email,
                    year: new Date().getFullYear().toString()
                };

                // `content` is trusted HTML from the editor (a RAW_HTML_KEYS key); the subject is plain text.
                const htmlContent = processTemplate(template, personalizedData);
                const personalSubject = processTemplate(subject, personalizedData, { html: false });

                try {
                    await sendEmail({
                        to: email,
                        subject: personalSubject,
                        htmlContent
                    });
                    emailLog.results.sent++;
                } catch (error) {
                    await logError(context, error);
                    emailLog.results.failed++;
                    emailLog.results.errors.push({
                        email,
                        error: 'Delivery failed'
                    });
                }
            }

            emailLog.status = emailLog.results.failed === 0 ? 'completed' : 'completed-with-errors';

            await EmailLogStore.create(emailLog);

            return { status: 200, jsonBody: emailLog };
        } catch (error) {
            await logError(context, error);
            context.error('Error sending email:', error);
            return { status: 500, jsonBody: { error: 'Internal server error' } };
        }
    }
});

app.http('email-history', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'email/history',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const allEmails = await EmailLogStore.getAll();
            const emails = allEmails.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
            return { status: 200, jsonBody: emails };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting email history:', error);
            return { status: 500, jsonBody: { error: 'Internal server error' } };
        }
    }
});
