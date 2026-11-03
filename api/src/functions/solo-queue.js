const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { generateId, isGuid, sameId } = require('../shared/id');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const { Validator, readJson, INVALID_JSON } = require('../shared/validate');

const soloQueueStorage = new GenericStorage('solo-queue.json');
const participationsStorage = new GenericStorage('participations');

function byJoinedAt(a, b) {
    const diff = new Date(a.joinedAt) - new Date(b.joinedAt);
    return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id));
}

// Waiting entries for an event, oldest first - the queue order everyone sees.
async function waitingQueue(eventId) {
    const entries = await soloQueueStorage.findBy({ eventId, status: 'waiting' });
    return entries.sort(byJoinedAt);
}

function publicEntry(entry) {
    return {
        id: entry.id,
        eventId: entry.eventId,
        userId: entry.userId,
        note: entry.note ?? null,
        status: entry.status,
        joinedAt: entry.joinedAt
    };
}

function isOpenForRegistration(event) {
    return event.status === 'registration' || event.registrationOpen === true;
}

app.http('solo-queue-get', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'solo-queue',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.query.get('eventId');
            const userId = request.query.get('userId');
            if ((eventId && !isGuid(eventId)) || (userId && !isGuid(userId))) {
                return { status: 400, jsonBody: { error: 'Invalid id' } };
            }

            const where = {};
            if (eventId) where.eventId = eventId;
            if (userId) where.userId = userId;
            const queue = (await soloQueueStorage.findBy(where)).sort(byJoinedAt);

            if (!auth.user.isAdmin) {
                const own = queue.filter(e => sameId(e.userId, auth.user.userId));
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

app.http('solo-queue-join', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'solo-queue',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await readJson(request);
            if (!body) return INVALID_JSON;

            if (!body.userId || !body.eventId) {
                return {
                    status: 400,
                    jsonBody: { error: 'userId and eventId are required' }
                };
            }

            if (!sameId(body.userId, auth.user.userId) && !auth.user.isAdmin) {
                return { status: 403, jsonBody: { error: 'You can only join the solo queue for yourself' } };
            }

            const v = new Validator();
            const userId = v.guid(body.userId, 'userId', { required: true });
            const eventId = v.guid(body.eventId, 'eventId', { required: true });
            const note = v.string(body.note, 'note', { max: 500 });
            if (v.failed) return v.failure();

            const event = await Storage.events.getById(eventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }
            if (!isOpenForRegistration(event)) {
                return { status: 400, jsonBody: { error: 'This event is not open for registration' } };
            }

            const user = await Storage.users.getById(userId);
            if (!user) {
                return { status: 404, jsonBody: { error: 'User not found' } };
            }

            const participation = await participationsStorage.findOneBy({ userId, eventId });
            if (participation && (participation.teamId || (participation.teamMemberships || []).length > 0)) {
                return { status: 400, jsonBody: { error: 'You are already on a team for this event' } };
            }

            const existing = await soloQueueStorage.findOneBy({ userId, eventId });
            if (existing) {
                return {
                    status: 400,
                    jsonBody: { error: 'Already in solo queue for this event' }
                };
            }

            const entry = {
                id: generateId(),
                userId,
                eventId,
                note: note || '',
                status: 'waiting',
                joinedAt: new Date().toISOString()
            };

            await soloQueueStorage.create(entry);

            // Position is read back after the insert, so it is the real 1-based position.
            const queue = await waitingQueue(eventId);
            const position = queue.findIndex(q => sameId(q.id, entry.id)) + 1;

            context.log(`User ${userId} joined solo queue for event ${eventId}, position ${position}`);
            return {
                status: 201,
                jsonBody: { ...entry, position, totalCount: queue.length }
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

app.http('solo-queue-leave', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'solo-queue/{id}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const entryToRemove = await soloQueueStorage.getById(id);

            if (!entryToRemove) {
                return {
                    status: 404,
                    jsonBody: { error: 'Queue entry not found' }
                };
            }

            if (!sameId(entryToRemove.userId, auth.user.userId) && !auth.user.isAdmin) {
                return { status: 403, jsonBody: { error: 'You can only remove your own solo queue entry' } };
            }

            await soloQueueStorage.delete(entryToRemove.id);

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

app.http('solo-queue-position', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'solo-queue/position/{eventId}/{userId}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, userId } = request.params;

            if (!sameId(userId, auth.user.userId) && !auth.user.isAdmin) {
                return { status: 403, jsonBody: { error: 'You can only check your own queue position' } };
            }

            const eventQueue = await waitingQueue(eventId);
            const index = eventQueue.findIndex(q => sameId(q.userId, userId));

            if (index < 0) {
                return {
                    status: 200,
                    jsonBody: { inQueue: false }
                };
            }

            const totalCount = eventQueue.length;
            return {
                status: 200,
                jsonBody: {
                    inQueue: true,
                    position: index + 1,
                    totalCount,
                    totalInQueue: totalCount,
                    entry: publicEntry(eventQueue[index])
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
