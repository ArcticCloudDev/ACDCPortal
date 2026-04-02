const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { v4: uuidv4 } = require('uuid');
const { Storage: GenericStorage } = require('../shared/storage');

const soloQueueStorage = new GenericStorage('solo-queue.json');
const usersStorage = new GenericStorage('users');
const interestQueueStorage = new GenericStorage('interest-queue');

// Helper to remove user from interest queue when they join solo queue
async function markRegisteredInInterestQueue(userId, eventId, context) {
    try {
        // Get user email
        const users = await usersStorage.getAll();
        const user = users.find(u => u.id === userId);
        if (!user || !user.email) return;

        // Check interest queue
        const data = await interestQueueStorage.getRaw();
        if (!data || !data.entries) return;

        const entryIndex = data.entries.findIndex(e => 
            e.email.toLowerCase() === user.email.toLowerCase() && !e.registeredEventId
        );

        if (entryIndex >= 0) {
            data.entries[entryIndex].registeredEventId = eventId;
            data.entries[entryIndex].registeredAt = new Date().toISOString();
            await interestQueueStorage.saveRaw(data);
            context.log(`Marked interest queue entry for ${user.email} as registered (solo queue)`);
        }
    } catch (error) {
        await logError(context, error);
        context.log(`Warning: Failed to update interest queue: ${error.message}`);
    }
}

// GET /api/solo-queue - Get solo queue entries (optionally by eventId or userId)
app.http('solo-queue-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'solo-queue',
    handler: async (request, context) => {
        try {
            const eventId = request.query.get('eventId');
            const userId = request.query.get('userId');
            
            let queue = await soloQueueStorage.getAll();
            
            if (eventId) {
                queue = queue.filter(q => q.eventId === eventId);
            }
            if (userId) {
                queue = queue.filter(q => q.userId === userId);
            }
            
            // Sort by joinedAt for position
            queue.sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));
            
            return {
                status: 200,
                jsonBody: queue
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting solo queue:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get solo queue' }
            };
        }
    }
});

// POST /api/solo-queue - Join solo queue
app.http('solo-queue-join', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'solo-queue',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { userId, eventId, note } = body;
            
            if (!userId || !eventId) {
                return {
                    status: 400,
                    jsonBody: { error: 'userId and eventId are required' }
                };
            }
            
            const queue = await soloQueueStorage.getAll();
            
            // Check if already in queue
            const existing = queue.find(q => q.userId === userId && q.eventId === eventId);
            if (existing) {
                return {
                    status: 400,
                    jsonBody: { error: 'Already in solo queue for this event' }
                };
            }
            
            const entry = {
                id: uuidv4(),
                userId,
                eventId,
                note: note || '',
                status: 'waiting', // waiting, matched, cancelled
                joinedAt: new Date().toISOString()
            };
            
            queue.push(entry);
            await soloQueueStorage.saveAll(queue);
            
            // Mark user as registered in interest queue if they were in it
            await markRegisteredInInterestQueue(userId, eventId, context);
            
            // Calculate position
            const eventQueue = queue.filter(q => q.eventId === eventId && q.status === 'waiting');
            eventQueue.sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));
            const position = eventQueue.findIndex(q => q.id === entry.id) + 1;
            
            context.log(`User ${userId} joined solo queue for event ${eventId}, position ${position}`);
            return {
                status: 201,
                jsonBody: { ...entry, position }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error joining solo queue:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to join solo queue' }
            };
        }
    }
});

// DELETE /api/solo-queue/:id - Leave solo queue
app.http('solo-queue-leave', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'solo-queue/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            
            const queue = await soloQueueStorage.getAll();
            const index = queue.findIndex(q => q.id === id);
            
            if (index < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Queue entry not found' }
                };
            }
            
            queue.splice(index, 1);
            await soloQueueStorage.saveAll(queue);
            
            context.log(`Solo queue entry ${id} removed`);
            return {
                status: 200,
                jsonBody: { success: true }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error leaving solo queue:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to leave solo queue' }
            };
        }
    }
});

// GET /api/solo-queue/position/:eventId/:userId - Get user's position in queue
app.http('solo-queue-position', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'solo-queue/position/{eventId}/{userId}',
    handler: async (request, context) => {
        try {
            const { eventId, userId } = request.params;
            
            const queue = await soloQueueStorage.getAll();
            const eventQueue = queue.filter(q => q.eventId === eventId && q.status === 'waiting');
            eventQueue.sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));
            
            const userEntry = eventQueue.find(q => q.userId === userId);
            
            if (!userEntry) {
                return {
                    status: 200,
                    jsonBody: { inQueue: false }
                };
            }
            
            const position = eventQueue.findIndex(q => q.id === userEntry.id) + 1;
            
            return {
                status: 200,
                jsonBody: {
                    inQueue: true,
                    position,
                    totalInQueue: eventQueue.length,
                    entry: userEntry
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting queue position:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get queue position' }
            };
        }
    }
});
