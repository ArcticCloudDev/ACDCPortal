const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const StorageModule = require('../shared/storage');
const { isGuid } = require('../shared/id');
const { participationsForEvent, eventExists } = require('../shared/admin-queries');
const { listByEvent, createManual, updateManual, updatePaidBy, deleteManual, getSummary, syncParticipationToFinancials } = require('../shared/event-financials');

// Validation errors from shared/event-financials carry .status (400/404); anything else is a 500.
async function failureResponse(context, error, fallback) {
    if (error && (error.status === 400 || error.status === 404)) {
        return { status: error.status, jsonBody: { error: error.message } };
    }
    await logError(context, error);
    return { status: 500, jsonBody: { error: fallback } };
}

const notFound = { status: 404, jsonBody: { error: 'Event not found' } };
const rowNotFound = { status: 404, jsonBody: { error: 'Financial row not found' } };

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
            if (!isGuid(eventId)) return notFound;
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
            if (!isGuid(eventId)) return notFound;
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
            if (!isGuid(eventId) || !(await eventExists(eventId))) return notFound;
            const body = await request.json();
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return { status: 400, jsonBody: { error: 'Request body must be a JSON object' } };
            }
            const row = await createManual(eventId, body);
            return { status: 201, jsonBody: row };
        } catch (error) {
            return failureResponse(context, error, 'Failed to create financial row');
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
            if (!isGuid(eventId) || !isGuid(rowId)) return rowNotFound;
            const body = await request.json();
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return { status: 400, jsonBody: { error: 'Request body must be a JSON object' } };
            }
            const row = await updateManual(rowId, eventId, body);
            return { status: 200, jsonBody: row };
        } catch (error) {
            return failureResponse(context, error, 'Failed to update financial row');
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
            if (!isGuid(eventId) || !isGuid(rowId)) return { status: 404, jsonBody: { error: 'Row not found or not deletable' } };
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
            if (!isGuid(eventId) || !isGuid(rowId)) return rowNotFound;
            const { paidBy } = (await request.json()) || {};
            if (!paidBy) return { status: 400, jsonBody: { error: 'paidBy is required' } };
            await updatePaidBy(rowId, eventId, paidBy);
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            return failureResponse(context, error, 'Failed to update row');
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

            const event = isGuid(eventId) ? await StorageModule.events.getById(eventId) : null;
            if (!event) return notFound;

            const eventParticipations = await participationsForEvent(eventId);

            let updated = 0;
            const errors = [];
            for (const participation of eventParticipations) {
                try {
                    await syncParticipationToFinancials(event, participation);
                    updated++;
                } catch (err) {
                    errors.push({ participationId: participation.id, error: 'Sync failed' });
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
