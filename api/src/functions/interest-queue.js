const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const Storage = require('../shared/storage');
const { v4: uuidv4 } = require('uuid');

const InterestQueueStore = new Storage.Storage('interest-queue');

// Get all interest queue entries (admin)
app.http('interest-queue-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'interest-queue',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const entries = await InterestQueueStore.getAll();
            entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            return { status: 200, jsonBody: entries };
        } catch (error) {
            await logError(context, error);
            context.error('Error listing interest queue:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Add to interest queue (public)
app.http('interest-queue-add', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'interest-queue',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { email, firstName, lastName, phone, company, source } = body;

            if (!email) {
                return { status: 400, jsonBody: { error: 'Email is required' } };
            }

            const entries = await InterestQueueStore.getAll();
            const existing = entries.find(e =>
                e.email.toLowerCase() === email.toLowerCase() && !e.registeredEventId
            );

            if (existing) {
                return { status: 409, jsonBody: {
                    error: 'You are already on the interest list!',
                    entry: existing
                }};
            }

            const newEntry = {
                id: uuidv4(),
                email: email.toLowerCase().trim(),
                firstName: firstName?.trim() || '',
                lastName: lastName?.trim() || '',
                phone: phone?.trim() || '',
                company: company?.trim() || '',
                source: source || 'website',
                createdAt: new Date().toISOString(),
                notified: false,
                registeredEventId: null
            };

            await InterestQueueStore.create(newEntry);
            return { status: 201, jsonBody: newEntry };
        } catch (error) {
            await logError(context, error);
            context.error('Error adding to interest queue:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Check if email is in interest queue (public)
app.http('interest-queue-check', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'interest-queue/check/{email}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const email = decodeURIComponent(request.params.email);
            const entries = await InterestQueueStore.getAll();
            const entry = entries.find(e =>
                e.email.toLowerCase() === email.toLowerCase() && !e.registeredEventId
            );
            return {
                status: 200,
                jsonBody: { inQueue: !!entry, entry: entry || null }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error checking interest queue:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Remove from interest queue (by id or email)
app.http('interest-queue-remove', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'interest-queue/{identifier}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const identifier = decodeURIComponent(request.params.identifier);
            let entry = await InterestQueueStore.getById(identifier);
            if (!entry) {
                // Try by email
                const all = await InterestQueueStore.getAll();
                entry = all.find(e => e.email.toLowerCase() === identifier.toLowerCase());
            }
            if (!entry) {
                return { status: 404, jsonBody: { error: 'Entry not found' } };
            }
            await InterestQueueStore.delete(entry.id);
            return { status: 200, jsonBody: { removed: entry } };
        } catch (error) {
            await logError(context, error);
            context.error('Error removing from interest queue:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Mark as registered (called when someone registers for an event)
app.http('interest-queue-mark-registered', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'interest-queue/mark-registered',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { email, eventId } = body;

            if (!email || !eventId) {
                return { status: 400, jsonBody: { error: 'email and eventId are required' } };
            }

            const entries = await InterestQueueStore.getAll();
            const toUpdate = entries.filter(e =>
                e.email.toLowerCase() === email.toLowerCase() && !e.registeredEventId
            );

            if (toUpdate.length === 0) {
                return { status: 200, jsonBody: { message: 'No pending entries found', updated: 0 } };
            }

            for (const entry of toUpdate) {
                await InterestQueueStore.update(entry.id, {
                    registeredEventId: eventId,
                    registeredAt: new Date().toISOString()
                });
            }

            return { status: 200, jsonBody: { message: 'Entries marked as registered', updated: toUpdate.length } };
        } catch (error) {
            await logError(context, error);
            context.error('Error marking as registered:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Get stats for interest queue (admin)
app.http('interest-queue-stats', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'interest-queue/stats',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const entries = await InterestQueueStore.getAll();
            const stats = {
                total: entries.length,
                pending: entries.filter(e => !e.registeredEventId).length,
                registered: entries.filter(e => e.registeredEventId).length,
                notified: entries.filter(e => e.notified && !e.registeredEventId).length,
                notNotified: entries.filter(e => !e.notified && !e.registeredEventId).length
            };
            return { status: 200, jsonBody: stats };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting interest queue stats:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Mark entries as notified (admin - after sending registration open email)
app.http('interest-queue-mark-notified', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'interest-queue/mark-notified',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { entryIds } = body;

            const entries = await InterestQueueStore.getAll();
            let count = 0;

            for (const entry of entries) {
                if (!entry.registeredEventId && !entry.notified) {
                    if (!entryIds || entryIds.includes(entry.id)) {
                        await InterestQueueStore.update(entry.id, {
                            notified: true,
                            notifiedAt: new Date().toISOString()
                        });
                        count++;
                    }
                }
            }

            return { status: 200, jsonBody: { message: 'Entries marked as notified', updated: count } };
        } catch (error) {
            await logError(context, error);
            context.error('Error marking as notified:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});
