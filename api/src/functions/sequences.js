// Sequences API - Manage email sequences (one per event)
const { app } = require('@azure/functions');
const { Storage } = require('../shared/storage');

const sequencesStorage = new Storage('sequences');
const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');

function generateGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function generateId(prefix = 'seq') {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// GET /api/sequences - List all sequences
app.http('sequences-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'sequences',
    handler: async (request, context) => {
        try {
            const data = await sequencesStorage.getRaw();
            let sequences = data?.sequences || [];
            
            // Add email counts and stats to each sequence
            const campaignData = await campaignsStorage.getRaw();
            const campaigns = campaignData?.campaigns || [];
            
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
            context.error('Sequences list error:', error);
            return { status: 500, jsonBody: { error: 'Failed to list sequences' } };
        }
    }
});

// GET /api/sequences/:id - Get sequence with emails
app.http('sequences-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'sequences/{id}',
    handler: async (request, context) => {
        try {
            const sequenceId = request.params.id;
            
            const data = await sequencesStorage.getRaw();
            const sequence = (data?.sequences || []).find(s => s.id === sequenceId);
            
            if (!sequence) {
                return { status: 404, jsonBody: { error: 'Sequence not found' } };
            }
            
            // Get emails for this sequence
            const campaignData = await campaignsStorage.getRaw();
            const emails = (campaignData?.campaigns || [])
                .filter(c => c.sequenceId === sequenceId)
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
            
            // Add stats to each email
            const deliveryData = await deliveriesStorage.getRaw();
            const deliveries = deliveryData?.deliveries || [];
            
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
            context.error('Sequence get error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get sequence' } };
        }
    }
});

// POST /api/sequences - Create sequence
app.http('sequences-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'sequences',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { name, description } = body;
            
            if (!name) {
                return { status: 400, jsonBody: { error: 'Name is required' } };
            }
            
            const data = await sequencesStorage.getRaw() || { sequences: [] };
            
            const sequence = {
                id: generateGuid(),
                name,
                description: description || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            
            data.sequences.push(sequence);
            await sequencesStorage.saveRaw(data);
            
            return { status: 201, jsonBody: { sequence } };
        } catch (error) {
            context.error('Sequence create error:', error);
            return { status: 500, jsonBody: { error: 'Failed to create sequence' } };
        }
    }
});

// PUT /api/sequences/:id - Update sequence
app.http('sequences-update', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'sequences/{id}',
    handler: async (request, context) => {
        try {
            const sequenceId = request.params.id;
            const body = await request.json();
            const { name, description } = body;
            
            const data = await sequencesStorage.getRaw();
            const index = (data?.sequences || []).findIndex(s => s.id === sequenceId);
            
            if (index === -1) {
                return { status: 404, jsonBody: { error: 'Sequence not found' } };
            }
            
            data.sequences[index] = {
                ...data.sequences[index],
                name: name || data.sequences[index].name,
                description: description !== undefined ? description : data.sequences[index].description,
                updatedAt: new Date().toISOString()
            };
            
            await sequencesStorage.saveRaw(data);
            
            return { status: 200, jsonBody: { sequence: data.sequences[index] } };
        } catch (error) {
            context.error('Sequence update error:', error);
            return { status: 500, jsonBody: { error: 'Failed to update sequence' } };
        }
    }
});

// DELETE /api/sequences/:id - Delete sequence and all its emails
app.http('sequences-delete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'sequences/{id}',
    handler: async (request, context) => {
        try {
            const sequenceId = request.params.id;
            
            // Delete sequence
            const data = await sequencesStorage.getRaw();
            const sequences = (data?.sequences || []).filter(s => s.id !== sequenceId);
            await sequencesStorage.saveRaw({ sequences });
            
            // Delete all emails in this sequence
            const campaignData = await campaignsStorage.getRaw();
            const campaigns = (campaignData?.campaigns || []).filter(c => c.sequenceId !== sequenceId);
            await campaignsStorage.saveRaw({ campaigns });
            
            // Note: We keep delivery records for analytics
            
            return { status: 200, jsonBody: { message: 'Sequence deleted' } };
        } catch (error) {
            context.error('Sequence delete error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete sequence' } };
        }
    }
});

// POST /api/sequences/:id/copy - Duplicate sequence (creates a copy)
app.http('sequences-copy', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'sequences/{id}/copy',
    handler: async (request, context) => {
        try {
            const sourceId = request.params.id;
            
            // Get source sequence
            const data = await sequencesStorage.getRaw();
            const sourceSequence = (data?.sequences || []).find(s => s.id === sourceId);
            
            if (!sourceSequence) {
                return { status: 404, jsonBody: { error: 'Source sequence not found' } };
            }
            
            // Create new sequence (duplicate)
            const newSequence = {
                id: generateGuid(),
                name: sourceSequence.name + ' (Copy)',
                description: sourceSequence.description,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            
            data.sequences.push(newSequence);
            await sequencesStorage.saveRaw(data);
            
            // Copy all emails
            const campaignData = await campaignsStorage.getRaw();
            const sourceEmails = (campaignData?.campaigns || [])
                .filter(c => c.sequenceId === sourceId)
                .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
            
            const newEmails = sourceEmails.map(email => ({
                ...email,
                id: generateId('camp'),
                sequenceId: newSequence.id,
                createdAt: new Date().toISOString(),
                status: 'draft',  // Always set copied emails to draft
                scheduledSendTime: null,  // Clear any scheduled time
                stats: { sent: 0, failed: 0 }
            }));
            
            campaignData.campaigns.push(...newEmails);
            await campaignsStorage.saveRaw(campaignData);
            
            return { 
                status: 201, 
                jsonBody: { 
                    sequence: newSequence,
                    emailCount: newEmails.length
                } 
            };
        } catch (error) {
            context.error('Sequence copy error:', error);
            return { status: 500, jsonBody: { error: 'Failed to copy sequence' } };
        }
    }
});
