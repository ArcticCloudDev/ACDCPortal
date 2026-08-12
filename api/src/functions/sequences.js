// Sequences API - Manage email sequences (one per event)
const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { v4: uuidv4 } = require('uuid');

const sequencesStorage = new Storage('sequences');
const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');

// GET /api/sequences - List all sequences
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
            
            // Add email counts and stats to each sequence
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

// GET /api/sequences/:id - Get sequence with emails
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
            
            // Get emails for this sequence
            const allCampaigns = await campaignsStorage.getAll();
            const emails = allCampaigns
                .filter(c => c.sequenceId === sequenceId)
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
            
            // Add stats to each email
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

// POST /api/sequences - Create sequence
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
                id: uuidv4(),
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

// PUT /api/sequences/:id - Update sequence
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

// DELETE /api/sequences/:id - Delete sequence and all its emails
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
            
            // Delete sequence
            await sequencesStorage.delete(sequenceId);
            
            // Delete all emails in this sequence
            const allCampaignsToDelete = await campaignsStorage.getAll();
            for (const campaign of allCampaignsToDelete.filter(c => c.sequenceId === sequenceId)) {
                await campaignsStorage.delete(campaign.id);
            }
            
            // Note: We keep delivery records for analytics
            
            return { status: 200, jsonBody: { message: 'Sequence deleted' } };
        } catch (error) {
            await logError(context, error);
            context.error('Sequence delete error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete sequence' } };
        }
    }
});

// POST /api/sequences/:id/copy - Duplicate sequence (creates a copy)
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
            
            // Get source sequence
            const sourceSequence = await sequencesStorage.getById(sourceId);
            
            if (!sourceSequence) {
                return { status: 404, jsonBody: { error: 'Source sequence not found' } };
            }
            
            // Create new sequence (duplicate)
            const newSequence = {
                id: uuidv4(),
                name: sourceSequence.name + ' (Copy)',
                description: sourceSequence.description,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            
            await sequencesStorage.create(newSequence);
            
            // Copy all emails
            const allSourceCampaigns = await campaignsStorage.getAll();
            const sourceEmails = allSourceCampaigns
                .filter(c => c.sequenceId === sourceId)
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
            
            const newEmails = sourceEmails.map(email => ({
                ...email,
                id: uuidv4(),
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
