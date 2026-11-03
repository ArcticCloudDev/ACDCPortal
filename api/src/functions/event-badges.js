const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, hasEventRole } = require('../shared/auth');
const { Storage: GenericStorage } = require('../shared/storage');
const { generateId, isGuid, sameId } = require('../shared/id');
const { upperId } = require('../shared/validate');
const q = require('../shared/admin-queries');

const eventBadgesStorage = new GenericStorage('event-badges');

const CATEGORY_ORDER = { 'soft': 0, 'low-code': 1, 'pro-code': 2, 'sponsor': 3 };

function sortByBadge(enriched) {
    enriched.sort((a, b) => {
        if (!a.badge || !b.badge) return 0;
        const catDiff = (CATEGORY_ORDER[a.badge.category] ?? 99) - (CATEGORY_ORDER[b.badge.category] ?? 99);
        if (catDiff !== 0) return catDiff;
        return (a.badge.name || '').localeCompare(b.badge.name || '');
    });
    return enriched;
}

// Badge library IDs are free-form NVARCHAR(100), not GUIDs.
function isValidBadgeId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 100;
}

function optionalGuid(value) {
    if (value === undefined || value === null || value === '') return { value: null };
    return isGuid(value) ? { value } : { error: 'judgeUserId must be a GUID' };
}

app.http('event-badges-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/{eventId}/badges',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            if (!isGuid(eventId)) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }
            const actor = q.asActor(auth.user);
            const eventKey = upperId(eventId);
            const participations = await q.participationsForUser(actor.userId);
            const canManageAssignments = actor.isAdmin
                || hasEventRole(actor, eventKey, 'judge', participations)
                || hasEventRole(actor, eventKey, 'committee', participations);
            const isEventParticipant = participations.some(p => sameId(p.eventId, eventId));

            if (!canManageAssignments && !isEventParticipant) {
                return { status: 403, jsonBody: { error: 'You do not have permission to view badges for this event' } };
            }

            const assignments = await q.eventBadgesForEvent(eventId);
            const badges = await q.badgesByIds(assignments.map(eb => eb.badgeId));

            const enriched = sortByBadge(assignments.map(eb => ({
                ...eb,
                badge: badges.find(b => b.id === eb.badgeId) || null
            })));

            if (canManageAssignments) {
                return { status: 200, jsonBody: enriched };
            }

            return {
                status: 200,
                jsonBody: enriched
                    .filter(assignment => assignment.isActive)
                    .map(({ id, eventId: assignedEventId, badgeId, isActive, badge }) => ({
                        id,
                        eventId: assignedEventId,
                        badgeId,
                        isActive,
                        badge
                    }))
            };
        } catch (error) {
            await logError(context, error);
            context.error('Event badges LIST error:', error);
            return { status: 500, jsonBody: { error: 'Failed to list event badges' } };
        }
    }
});

app.http('event-badges-add', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events/{eventId}/badges',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const body = await request.json();

            const rawIds = Array.isArray(body?.badgeIds) ? body.badgeIds : (body?.badgeId ? [body.badgeId] : []);
            const badgeIds = q.unique(rawIds);
            if (badgeIds.length === 0) {
                return { status: 400, jsonBody: { error: 'badgeId or badgeIds is required' } };
            }
            if (!badgeIds.every(isValidBadgeId)) {
                return { status: 400, jsonBody: { error: 'badgeIds must be non-empty strings' } };
            }
            const judge = optionalGuid(body.judgeUserId);
            if (judge.error) {
                return { status: 400, jsonBody: { error: judge.error } };
            }

            if (!isGuid(eventId) || !(await q.eventExists(eventId))) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            const badges = await q.badgesByIds(badgeIds);
            const eventBadges = await q.eventBadgesForEvent(eventId);

            const added = [];
            const skipped = [];

            for (const badgeId of badgeIds) {
                const badge = badges.find(b => b.id === badgeId);
                if (!badge) {
                    skipped.push({ badgeId, reason: 'Badge not found' });
                    continue;
                }

                const existing = eventBadges.find(eb => eb.badgeId === badgeId);
                if (existing) {
                    skipped.push({ badgeId, reason: 'Already assigned' });
                    continue;
                }

                const assignment = {
                    id: generateId(),
                    eventId: eventId,
                    badgeId: badgeId,
                    judgeUserId: judge.value,
                    isActive: true,
                    createdAt: new Date().toISOString()
                };

                const created = await eventBadgesStorage.create(assignment);
                added.push(created);
            }

            context.log(`Added ${added.length} badges to event ${eventId}, skipped ${skipped.length}`);
            return {
                status: 201,
                jsonBody: { added, skipped }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Event badges ADD error:', error);
            return { status: 500, jsonBody: { error: 'Failed to add badges to event' } };
        }
    }
});

app.http('event-badges-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'events/{eventId}/badges/{id}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, id } = request.params;
            const body = await request.json();

            const eventBadge = isGuid(id) && isGuid(eventId) ? await eventBadgesStorage.getById(id) : null;

            if (!eventBadge || !sameId(eventBadge.eventId, eventId)) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found' } };
            }

            const judge = body.judgeUserId !== undefined ? optionalGuid(body.judgeUserId) : { value: eventBadge.judgeUserId };
            if (judge.error) {
                return { status: 400, jsonBody: { error: judge.error } };
            }

            const updated = await eventBadgesStorage.update(id, {
                judgeUserId: judge.value,
                isActive: body.isActive !== undefined ? !!body.isActive : eventBadge.isActive,
                updatedAt: new Date().toISOString()
            });

            context.log(`Event-badge ${id} updated for event ${eventId}`);
            return { status: 200, jsonBody: updated };
        } catch (error) {
            await logError(context, error);
            context.error('Event badges UPDATE error:', error);
            return { status: 500, jsonBody: { error: 'Failed to update event badge' } };
        }
    }
});

app.http('event-badges-remove', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'events/{eventId}/badges/{id}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, id } = request.params;

            const eventBadge = isGuid(id) && isGuid(eventId) ? await eventBadgesStorage.getById(id) : null;

            if (!eventBadge || !sameId(eventBadge.eventId, eventId)) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found' } };
            }

            // Claims first, then the assignment (FK_BadgeClaims_EventBadges), in one transaction.
            await q.deleteEventBadgesCascade([id]);

            context.log(`Badge removed from event ${eventId}`);
            return { status: 200, jsonBody: { message: 'Badge removed from event' } };
        } catch (error) {
            await logError(context, error);
            context.error('Event badges REMOVE error:', error);
            return { status: 500, jsonBody: { error: 'Failed to remove badge from event' } };
        }
    }
});

app.http('event-badges-bulk', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events/{eventId}/badges/bulk',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const body = await request.json();
            const { selectedBadgeIds } = body || {};

            if (!Array.isArray(selectedBadgeIds)) {
                return { status: 400, jsonBody: { error: 'selectedBadgeIds array is required' } };
            }
            const wanted = q.unique(selectedBadgeIds);
            if (!wanted.every(isValidBadgeId)) {
                return { status: 400, jsonBody: { error: 'selectedBadgeIds must be non-empty strings' } };
            }

            if (!isGuid(eventId) || !(await q.eventExists(eventId))) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            const knownBadges = await q.badgesByIds(wanted);
            const unknown = wanted.filter(id => !knownBadges.some(b => b.id === id));
            if (unknown.length > 0) {
                return { status: 400, jsonBody: { error: 'Unknown badge ids', badgeIds: unknown } };
            }

            const currentAssignments = await q.eventBadgesForEvent(eventId);
            const currentBadgeIds = currentAssignments.map(eb => eb.badgeId);

            const toAdd = wanted.filter(id => !currentBadgeIds.includes(id));
            const toRemove = currentAssignments.filter(eb => !wanted.includes(eb.badgeId));

            const added = await q.withTransaction(async makeRequest => {
                await q.deleteEventBadgesCascade(toRemove.map(eb => eb.id), makeRequest);
                const created = [];
                for (const badgeId of toAdd) {
                    const newEb = {
                        id: generateId(),
                        eventId: eventId,
                        badgeId: badgeId,
                        judgeUserId: null,
                        isActive: true,
                        createdAt: new Date().toISOString()
                    };
                    await makeRequest()
                        .input('id', newEb.id)
                        .input('eventId', newEb.eventId)
                        .input('badgeId', newEb.badgeId)
                        .input('isActive', newEb.isActive)
                        .input('createdAt', newEb.createdAt)
                        .query(`INSERT INTO [EventBadges] (Id, EventId, BadgeId, JudgeUserId, IsActive, CreatedAt)
                                VALUES (@id, @eventId, @badgeId, NULL, @isActive, @createdAt)`);
                    created.push(newEb);
                }
                return created;
            });

            const totalForEvent = currentAssignments.length - toRemove.length + added.length;

            context.log(`Bulk update for event ${eventId}: added ${added.length}, removed ${toRemove.length}`);
            return {
                status: 200,
                jsonBody: {
                    added: added.length,
                    removed: toRemove.length,
                    total: totalForEvent
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Event badges BULK error:', error);
            return { status: 500, jsonBody: { error: 'Failed to bulk update event badges' } };
        }
    }
});
