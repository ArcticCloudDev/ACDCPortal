const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { listByEvent, createManual, updateManual, updatePaidBy, deleteManual, getSummary, syncParticipationToFinancials } = require('../shared/event-financials');

const eventsStorage = new Storage('events');
const participationsStorage = new Storage('participations');

app.http('event-financials-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'events/{eventId}/financials',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const rows = await listByEvent(eventId);
            return { status: 200, jsonBody: rows };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: 'Failed to list financials' } };
        }
    }
});

app.http('event-financials-summary', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/summary',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const summary = await getSummary(eventId);
            return { status: 200, jsonBody: summary };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: 'Failed to get financial summary' } };
        }
    }
});

app.http('event-financials-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events/{eventId}/financials',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const body = await request.json();
            const row = await createManual(eventId, body);
            return { status: 201, jsonBody: row };
        } catch (error) {
            const status = /Invalid type|Invalid category|Invalid paidBy|amount must/i.test(error.message) ? 400 : 500;
            if (status === 500) await logError(context, error);
            return { status, jsonBody: { error: status === 400 ? error.message : 'Failed to create financial row' } };
        }
    }
});

app.http('event-financials-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/{rowId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, rowId } = request.params;
            const body = await request.json();
            const row = await updateManual(rowId, eventId, body);
            return { status: 200, jsonBody: row };
        } catch (error) {
            const status = /not found|Invalid type|Invalid category|Invalid paidBy|amount must/i.test(error.message) ? 400 : 500;
            if (status === 500) await logError(context, error);
            return { status, jsonBody: { error: status === 400 ? error.message : 'Failed to update financial row' } };
        }
    }
});

app.http('event-financials-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/{rowId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, rowId } = request.params;
            const deleted = await deleteManual(rowId, eventId);
            if (!deleted) return { status: 404, jsonBody: { error: 'Row not found or not deletable' } };
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: 'Failed to delete financial row' } };
        }
    }
});

app.http('event-financials-patch', {
    methods: ['PATCH'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/{rowId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, rowId } = request.params;
            const { paidBy } = await request.json();
            if (!paidBy) return { status: 400, jsonBody: { error: 'paidBy is required' } };
            await updatePaidBy(rowId, eventId, paidBy);
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            const status = /Invalid paidBy|not found/i.test(error.message) ? 400 : 500;
            if (status === 500) await logError(context, error);
            return { status, jsonBody: { error: status === 400 ? error.message : 'Failed to update row' } };
        }
    }
});

app.http('event-financials-recalculate', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/recalculate',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId } = request.params;

            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === eventId);
            if (!event) return { status: 404, jsonBody: { error: 'Event not found' } };

            const allParticipations = await participationsStorage.getAll();
            const eventParticipations = allParticipations.filter(p => p.eventId === eventId);

            let updated = 0;
            const errors = [];
            for (const participation of eventParticipations) {
                try {
                    await syncParticipationToFinancials(event, participation);
                    updated++;
                } catch (err) {
                    errors.push({ participationId: participation.id, error: err.message });
                    context.warn(`Recalculate: failed for participation ${participation.id}: ${err.message}`);
                }
            }

            return {
                status: 200,
                jsonBody: { updated, total: eventParticipations.length, errors }
            };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: 'Failed to recalculate financials' } };
        }
    }
});
