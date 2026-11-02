const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { generateId, isGuid } = require('../shared/id');
const q = require('../shared/admin-queries');

const sequencesStorage = new Storage('sequences');
const campaignsStorage = new Storage('email-campaigns');

function validateSequenceBody(body, { requireName }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object';
    if (requireName || body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) return 'Name is required';
        if (body.name.length > 200) return 'Name must be at most 200 characters';
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') return 'description must be a string';
    return null;
}

app.http('sequences-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'sequences',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            let sequences = await sequencesStorage.getAll();
            const stats = await q.sequenceStats();

            sequences = sequences.map(seq => {
                const s = stats[String(seq.id).toLowerCase()] || { emailCount: 0, sent: 0, failed: 0 };
                return {
                    ...seq,
                    emailCount: s.emailCount,
                    stats: {
                        sent: s.sent,
                        failed: s.failed
                    }
                };
            });

            sequences.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            return { status: 200, jsonBody: { sequences } };
        } catch (error) {
            await logError(context, error);
            context.error('Sequences list error:', error);
            return { status: 500, jsonBody: { error: 'Failed to list sequences' } };
        }
    }
});

app.http('sequences-get', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'sequences/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const sequenceId = request.params.id;

            const sequence = isGuid(sequenceId) ? await sequencesStorage.getById(sequenceId) : null;

            if (!sequence) {
                return { status: 404, jsonBody: { error: 'Sequence not found' } };
            }

            const emails = await q.campaignsForSequence(sequenceId);
            const stats = await q.deliveryStatsForCampaigns(emails.map(e => e.id));

            const emailsWithStats = emails.map(email => {
                const s = stats[String(email.id).toLowerCase()] || { sent: 0, failed: 0, pending: 0 };
                return {
                    ...email,
                    stats: {
                        sent: s.sent,
                        failed: s.failed,
                        pending: s.pending
                    }
                };
            });

            return {
                status: 200,
                jsonBody: {
                    sequence,
                    emails: emailsWithStats
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Sequence get error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get sequence' } };
        }
    }
});

app.http('sequences-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'sequences',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const validationError = validateSequenceBody(body, { requireName: true });
            if (validationError) {
                return { status: 400, jsonBody: { error: validationError } };
            }
            const { name, description } = body;

            const sequence = {
                id: generateId(),
                name: name.trim(),
                description: description || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            await sequencesStorage.create(sequence);

            return { status: 201, jsonBody: { sequence } };
        } catch (error) {
            await logError(context, error);
            context.error('Sequence create error:', error);
            return { status: 500, jsonBody: { error: 'Failed to create sequence' } };
        }
    }
});

app.http('sequences-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'sequences/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const sequenceId = request.params.id;
            const body = await request.json();
            const validationError = validateSequenceBody(body, { requireName: false });
            if (validationError) {
                return { status: 400, jsonBody: { error: validationError } };
            }
            const { name, description } = body;

            const existing = isGuid(sequenceId) ? await sequencesStorage.getById(sequenceId) : null;

            if (!existing) {
                return { status: 404, jsonBody: { error: 'Sequence not found' } };
            }

            const updates = {
                name: name ? name.trim() : existing.name,
                description: description !== undefined ? description : existing.description,
                updatedAt: new Date().toISOString()
            };

            const updated = await sequencesStorage.update(sequenceId, updates);

            return { status: 200, jsonBody: { sequence: updated } };
        } catch (error) {
            await logError(context, error);
            context.error('Sequence update error:', error);
            return { status: 500, jsonBody: { error: 'Failed to update sequence' } };
        }
    }
});

app.http('sequences-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'sequences/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const sequenceId = request.params.id;

            const existing = isGuid(sequenceId) ? await sequencesStorage.getById(sequenceId) : null;
            if (!existing) {
                return { status: 404, jsonBody: { error: 'Sequence not found' } };
            }

            // Deliveries -> campaigns -> sequence (FK order), and detach any event using it.
            await q.deleteSequenceCascade(sequenceId);

            return { status: 200, jsonBody: { message: 'Sequence deleted' } };
        } catch (error) {
            await logError(context, error);
            context.error('Sequence delete error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete sequence' } };
        }
    }
});

app.http('sequences-copy', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'sequences/{id}/copy',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const sourceId = request.params.id;

            const sourceSequence = isGuid(sourceId) ? await sequencesStorage.getById(sourceId) : null;

            if (!sourceSequence) {
                return { status: 404, jsonBody: { error: 'Source sequence not found' } };
            }

            const sourceEmails = await q.campaignsForSequence(sourceId);

            const newSequence = {
                id: generateId(),
                name: `${sourceSequence.name} (Copy)`.slice(0, 200),
                description: sourceSequence.description,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            // Only real EmailCampaigns columns are copied; derived fields (stats) stay out.
            const newEmails = sourceEmails.map((email, index) => ({
                id: generateId(),
                sequenceId: newSequence.id,
                subject: email.subject,
                content: email.content,
                ctaUrl: email.ctaUrl || null,
                ctaText: email.ctaText || null,
                type: email.type || 'sequence',
                sequenceOrder: email.sequenceOrder || index + 1,
                status: 'draft',
                scheduledSendTime: null,
                createdAt: new Date().toISOString(),
                createdBy: auth.user.userId || null
            }));

            await sequencesStorage.create(newSequence);
            try {
                for (const email of newEmails) {
                    await campaignsStorage.create(email);
                }
            } catch (error) {
                // Do not leave an orphan "(Copy)" behind.
                await q.deleteSequenceCascade(newSequence.id).catch(() => {});
                throw error;
            }

            return {
                status: 201,
                jsonBody: {
                    sequence: newSequence,
                    emailCount: newEmails.length
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Sequence copy error:', error);
            return { status: 500, jsonBody: { error: 'Failed to copy sequence' } };
        }
    }
});
