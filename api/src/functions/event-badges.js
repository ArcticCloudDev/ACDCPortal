const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, hasEventRole } = require('../shared/auth');
const { Storage: GenericStorage } = require('../shared/storage');
const { generateId } = require('../shared/id');

const badgesStorage = new GenericStorage('badges');
const eventBadgesStorage = new GenericStorage('event-badges');
const badgeClaimsStorage = new GenericStorage('badge-claims');
const eventsStorage = new GenericStorage('events');
const participationsStorage = new GenericStorage('participations');

app.http('event-badges-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/{eventId}/badges',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const participations = await participationsStorage.getAll();
            const canManageAssignments = auth.user.isPortalAdmin
                || hasEventRole(auth.user, eventId, 'judge', participations)
                || hasEventRole(auth.user, eventId, 'committee', participations);
            const isEventParticipant = participations.some(p =>
                p.userId === auth.user.userId && p.eventId === eventId
            );

            if (!canManageAssignments && !isEventParticipant) {
                return { status: 403, jsonBody: { error: 'You do not have permission to view badges for this event' } };
            }

            const eventBadges = await eventBadgesStorage.getAll();
            const badges = await badgesStorage.getAll();

            const assignments = eventBadges.filter(eb => eb.eventId === eventId);

            const enriched = assignments.map(eb => {
                const badge = badges.find(b => b.id === eb.badgeId);
                return {
                    ...eb,
                    badge: badge || null
                };
            });

            const categoryOrder = { 'soft': 0, 'low-code': 1, 'pro-code': 2, 'sponsor': 3 };
            enriched.sort((a, b) => {
                if (!a.badge || !b.badge) return 0;
                const catDiff = (categoryOrder[a.badge.category] || 99) - (categoryOrder[b.badge.category] || 99);
                if (catDiff !== 0) return catDiff;
                return a.badge.name.localeCompare(b.badge.name);
            });

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
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const body = await request.json();

            const badgeIds = body.badgeIds || (body.badgeId ? [body.badgeId] : []);
            if (badgeIds.length === 0) {
                return { status: 400, jsonBody: { error: 'badgeId or badgeIds is required' } };
            }

            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === eventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            const badges = await badgesStorage.getAll();
            const eventBadges = await eventBadgesStorage.getAll();

            const added = [];
            const skipped = [];

            for (const badgeId of badgeIds) {
                const badge = badges.find(b => b.id === badgeId);
                if (!badge) {
                    skipped.push({ badgeId, reason: 'Badge not found' });
                    continue;
                }

                const existing = eventBadges.find(eb => eb.eventId === eventId && eb.badgeId === badgeId);
                if (existing) {
                    skipped.push({ badgeId, reason: 'Already assigned' });
                    continue;
                }

                const assignment = {
                    id: generateId(),
                    eventId: eventId,
                    badgeId: badgeId,
                    judgeUserId: body.judgeUserId || null,
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
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, id } = request.params;
            const body = await request.json();

            const eventBadge = await eventBadgesStorage.getById(id);

            if (!eventBadge || eventBadge.eventId !== eventId) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found' } };
            }

            const updated = await eventBadgesStorage.update(id, {
                judgeUserId: body.judgeUserId !== undefined ? body.judgeUserId : eventBadge.judgeUserId,
                isActive: body.isActive !== undefined ? body.isActive : eventBadge.isActive,
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
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, id } = request.params;

            const eventBadge = await eventBadgesStorage.getById(id);

            if (!eventBadge || eventBadge.eventId !== eventId) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found' } };
            }

            await eventBadgesStorage.delete(id);

            const claims = await badgeClaimsStorage.getAll();
            for (const c of claims) {
                if (c.eventBadgeId === id) {
                    await badgeClaimsStorage.delete(c.id);
                }
            }

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
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const body = await request.json();
            const { selectedBadgeIds } = body;

            if (!Array.isArray(selectedBadgeIds)) {
                return { status: 400, jsonBody: { error: 'selectedBadgeIds array is required' } };
            }

            const eventBadges = await eventBadgesStorage.getAll();

            const currentAssignments = eventBadges.filter(eb => eb.eventId === eventId);
            const currentBadgeIds = currentAssignments.map(eb => eb.badgeId);

            const toAdd = selectedBadgeIds.filter(id => !currentBadgeIds.includes(id));
            const toRemove = currentAssignments.filter(eb => !selectedBadgeIds.includes(eb.badgeId));

            for (const eb of toRemove) {
                await eventBadgesStorage.delete(eb.id);
            }

            const added = [];
            for (const badgeId of toAdd) {
                const newEb = await eventBadgesStorage.create({
                    id: generateId(),
                    eventId: eventId,
                    badgeId: badgeId,
                    judgeUserId: null,
                    isActive: true,
                    createdAt: new Date().toISOString()
                });
                added.push(newEb);
            }

            if (toRemove.length > 0) {
                const removeIds = new Set(toRemove.map(eb => eb.id));
                const claims = await badgeClaimsStorage.getAll();
                for (const c of claims) {
                    if (removeIds.has(c.eventBadgeId)) {
                        await badgeClaimsStorage.delete(c.id);
                    }
                }
            }

            const totalForEvent = currentAssignments.length - toRemove.length + toAdd.length;

            context.log(`Bulk update for event ${eventId}: added ${toAdd.length}, removed ${toRemove.length}`);
            return {
                status: 200,
                jsonBody: {
                    added: toAdd.length,
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
