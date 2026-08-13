const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
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
        const entries = await interestQueueStorage.getAll();

        const entry = entries.find(e => 
            e.email.toLowerCase() === user.email.toLowerCase() && !e.registeredEventId
        );

        if (entry) {
            await interestQueueStorage.update(entry.id, {
                registeredEventId: eventId,
                registeredAt: new Date().toISOString()
            });
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
    authLevel: 'function',
    route: 'solo-queue',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

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

            // Non-admins may only see their own entry, plus an aggregate count.
            if (!auth.user.isPortalAdmin) {
                const own = queue.filter(e => e.userId === auth.user.userId);
                return {
                    status: 200,
                    jsonBody: { entries: own, totalCount: queue.length }
                };
            }
            
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
    authLevel: 'function',
    route: 'solo-queue',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { userId, eventId, note } = body;
            
            if (!userId || !eventId) {
                return {
                    status: 400,
                    jsonBody: { error: 'userId and eventId are required' }
                };
            }
            
            if (userId !== auth.user.userId && !auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'You can only join the solo queue for yourself' } };
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
            
            await soloQueueStorage.create(entry);
            
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
    authLevel: 'function',
    route: 'solo-queue/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            
            const queue = await soloQueueStorage.getAll();
            const index = queue.findIndex(q => q.id === id);
            
            if (index < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Queue entry not found' }
                };
            }
            
            const entryToRemove = queue[index];
            if (entryToRemove.userId !== auth.user.userId && !auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'You can only remove your own solo queue entry' } };
            }
            
            await soloQueueStorage.delete(id);
            
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
    authLevel: 'function',
    route: 'solo-queue/position/{eventId}/{userId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

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

            if (!auth.user.isPortalAdmin && userId !== auth.user.userId) {
                return {
                    status: 403,
                    jsonBody: { error: 'You do not have permission to view this queue position' }
                };
            }
            
            const position = eventQueue.findIndex(q => q.id === userEntry.id) + 1;
            
            if (!auth.user.isPortalAdmin) {
                return {
                    status: 200,
                    jsonBody: { position, totalCount: eventQueue.length }
                };
            }
            
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
