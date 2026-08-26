const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { generateId } = require('../shared/id');

const sequencesStorage = new Storage('sequences');
const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');

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

            const campaigns = await campaignsStorage.getAll();

            sequences = sequences.map(seq => {
                const seqEmails = campaigns.filter(c => c.sequenceId === seq.id);
                const totalSent = seqEmails.reduce((sum, e) => sum + (e.stats?.sent || 0), 0);
                const totalFailed = seqEmails.reduce((sum, e) => sum + (e.stats?.failed || 0), 0);

                return {
                    ...seq,
                    emailCount: seqEmails.length,
                    stats: {
                        sent: totalSent,
                        failed: totalFailed
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

            const sequence = await sequencesStorage.getById(sequenceId);

            if (!sequence) {
                return { status: 404, jsonBody: { error: 'Sequence not found' } };
            }

            const allCampaigns = await campaignsStorage.getAll();
            const emails = allCampaigns
                .filter(c => c.sequenceId === sequenceId)
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

            const deliveries = await deliveriesStorage.getAll();

            const emailsWithStats = emails.map(email => {
                const emailDeliveries = deliveries.filter(d => d.campaignId === email.id);
                return {
                    ...email,
                    stats: {
                        sent: emailDeliveries.filter(d => d.status === 'sent').length,
                        failed: emailDeliveries.filter(d => d.status === 'failed').length,
                        pending: emailDeliveries.filter(d => d.status === 'pending').length
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
            const { name, description } = body;

            if (!name) {
                return { status: 400, jsonBody: { error: 'Name is required' } };
            }

            const sequence = {
                id: generateId(),
                name,
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
            const { name, description } = body;

            const existing = await sequencesStorage.getById(sequenceId);

            if (!existing) {
                return { status: 404, jsonBody: { error: 'Sequence not found' } };
            }

            const updates = {
                name: name || existing.name,
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

            await sequencesStorage.delete(sequenceId);

            const allCampaignsToDelete = await campaignsStorage.getAll();
            for (const campaign of allCampaignsToDelete.filter(c => c.sequenceId === sequenceId)) {
                await campaignsStorage.delete(campaign.id);
            }

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

            const sourceSequence = await sequencesStorage.getById(sourceId);

            if (!sourceSequence) {
                return { status: 404, jsonBody: { error: 'Source sequence not found' } };
            }

            const newSequence = {
                id: generateId(),
                name: sourceSequence.name + ' (Copy)',
                description: sourceSequence.description,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            await sequencesStorage.create(newSequence);

            const allSourceCampaigns = await campaignsStorage.getAll();
            const sourceEmails = allSourceCampaigns
                .filter(c => c.sequenceId === sourceId)
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

            const newEmails = sourceEmails.map(email => ({
                ...email,
                id: generateId(),
                sequenceId: newSequence.id,
                createdAt: new Date().toISOString(),
                status: 'draft',
                scheduledSendTime: null,
                stats: { sent: 0, failed: 0 }
            }));

            for (const email of newEmails) {
                await campaignsStorage.create(email);
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
