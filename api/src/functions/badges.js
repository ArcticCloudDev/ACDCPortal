const { app } = require('@azure/functions');
const crypto = require('crypto');
const { logError } = require('../shared/error-log');
const { requireAuth, isTeamMember, hasEventRole } = require('../shared/auth');
const { Storage: GenericStorage } = require('../shared/storage');

const badgesStorage = new GenericStorage('badges');
const eventBadgesStorage = new GenericStorage('event-badges');
const badgeClaimsStorage = new GenericStorage('badge-claims');
const eventsStorage = new GenericStorage('events');
const participationsStorage = new GenericStorage('participations');
const teamsStorage = new GenericStorage('teams');

function generateGuid() {
    return crypto.randomUUID();
}

app.http('badges-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'badges',
    handler: async (request, context) => {
        try {
            const category = request.query.get('category');
            let badges = await badgesStorage.getAll();

            if (category) {
                badges = badges.filter(b => b.category === category);
            }

            const categoryOrder = { 'soft': 0, 'low-code': 1, 'pro-code': 2, 'sponsor': 3 };
            badges.sort((a, b) => {
                const catDiff = (categoryOrder[a.category] || 99) - (categoryOrder[b.category] || 99);
                if (catDiff !== 0) return catDiff;
                return a.name.localeCompare(b.name);
            });

            return {
                status: 200,
                jsonBody: badges
            };
        } catch (error) {
            await logError(context, error);
            context.error('Badges LIST error:', error);
            return { status: 500, jsonBody: { error: 'Failed to list badges' } };
        }
    }
});

app.http('badges-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'badges/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const badges = await badgesStorage.getAll();
            const badge = badges.find(b => b.id === id);

            if (!badge) {
                return { status: 404, jsonBody: { error: 'Badge not found' } };
            }

            return { status: 200, jsonBody: badge };
        } catch (error) {
            await logError(context, error);
            context.error('Badges GET error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get badge' } };
        }
    }
});

app.http('badges-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'badges',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();

            if (!body.name) {
                return { status: 400, jsonBody: { error: 'Badge name is required' } };
            }
            if (!body.category) {
                return { status: 400, jsonBody: { error: 'Badge category is required' } };
            }

            const validCategories = ['soft', 'low-code', 'pro-code', 'sponsor'];
            if (!validCategories.includes(body.category)) {
                return { status: 400, jsonBody: { error: `Category must be one of: ${validCategories.join(', ')}` } };
            }

            const validClaimTypes = ['common', 'exclusive'];
            const claimType = body.claimType || 'common';
            if (!validClaimTypes.includes(claimType)) {
                return { status: 400, jsonBody: { error: `claimType must be one of: ${validClaimTypes.join(', ')}` } };
            }

            const newBadge = {
                id: generateGuid(),
                name: body.name,
                description: body.description || '',
                category: body.category,
                claimType: claimType,
                imageUrl: body.imageUrl || '',
                points: parseInt(body.points) || 0,
                createdAt: new Date().toISOString()
            };

            await badgesStorage.create(newBadge);

            context.log(`Badge created: ${newBadge.name}`);
            return { status: 201, jsonBody: newBadge };
        } catch (error) {
            await logError(context, error);
            context.error('Badges CREATE error:', error);
            return { status: 500, jsonBody: { error: 'Failed to create badge' } };
        }
    }
});

app.http('badges-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'badges/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await request.json();

            const badge = await badgesStorage.getById(id);

            if (!badge) {
                return { status: 404, jsonBody: { error: 'Badge not found' } };
            }

            if (body.category) {
                const validCategories = ['soft', 'low-code', 'pro-code', 'sponsor'];
                if (!validCategories.includes(body.category)) {
                    return { status: 400, jsonBody: { error: `Category must be one of: ${validCategories.join(', ')}` } };
                }
            }

            if (body.claimType) {
                const validClaimTypes = ['common', 'exclusive'];
                if (!validClaimTypes.includes(body.claimType)) {
                    return { status: 400, jsonBody: { error: `claimType must be one of: ${validClaimTypes.join(', ')}` } };
                }
            }

            const updates = {
                name: body.name !== undefined ? body.name : badge.name,
                description: body.description !== undefined ? body.description : badge.description,
                category: body.category !== undefined ? body.category : badge.category,
                claimType: body.claimType !== undefined ? body.claimType : (badge.claimType || 'common'),
                imageUrl: body.imageUrl !== undefined ? body.imageUrl : badge.imageUrl,
                points: body.points !== undefined ? parseInt(body.points) : badge.points,
                updatedAt: new Date().toISOString()
            };

            const updated = await badgesStorage.update(id, updates);

            context.log(`Badge updated: ${updates.name}`);
            return { status: 200, jsonBody: updated };
        } catch (error) {
            await logError(context, error);
            context.error('Badges UPDATE error:', error);
            return { status: 500, jsonBody: { error: 'Failed to update badge' } };
        }
    }
});

app.http('badges-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'badges/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;

            const badge = await badgesStorage.getById(id);

            if (!badge) {
                return { status: 404, jsonBody: { error: 'Badge not found' } };
            }

            const badgeName = badge.name;
            await badgesStorage.delete(id);

            const eventBadges = await eventBadgesStorage.getAll();
            for (const eb of eventBadges) {
                if (eb.badgeId === id) {
                    await eventBadgesStorage.delete(eb.id);
                }
            }

            context.log(`Badge deleted: ${badgeName}`);
            return { status: 200, jsonBody: { message: 'Badge deleted' } };
        } catch (error) {
            await logError(context, error);
            context.error('Badges DELETE error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete badge' } };
        }
    }
});

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
                    id: generateGuid(),
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
                    id: generateGuid(),
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

app.http('badge-claims-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'badge-claims',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.query.get('eventId');
            const teamId = request.query.get('teamId');
            const status = request.query.get('status');
            const badgeId = request.query.get('badgeId');

            let claims = await badgeClaimsStorage.getAll();

            if (eventId) claims = claims.filter(c => c.eventId === eventId);
            if (teamId) claims = claims.filter(c => c.teamId === teamId);
            if (status) claims = claims.filter(c => c.status === status);
            if (badgeId) claims = claims.filter(c => c.badgeId === badgeId);

            if (!auth.user.isPortalAdmin) {
                const participations = await participationsStorage.getAll();
                claims = claims.filter(c => {
                    if (c.eventId && (hasEventRole(auth.user, c.eventId, 'judge', participations)
                        || hasEventRole(auth.user, c.eventId, 'committee', participations))) {
                        return true;
                    }
                    return c.teamId && isTeamMember(auth.user, c.teamId, participations);
                });
            }

            const badges = await badgesStorage.getAll();
            const teams = await teamsStorage.getAll();

            const enriched = claims.map(c => ({
                ...c,
                badge: badges.find(b => b.id === c.badgeId) || null,
                team: teams.find(t => t.id === c.teamId) ? { id: c.teamId, teamName: teams.find(t => t.id === c.teamId).teamName } : null
            }));

            enriched.sort((a, b) => new Date(b.claimedAt) - new Date(a.claimedAt));

            return { status: 200, jsonBody: enriched };
        } catch (error) {
            await logError(context, error);
            context.error('Badge claims LIST error:', error);
            return { status: 500, jsonBody: { error: 'Failed to list badge claims' } };
        }
    }
});

app.http('badge-claims-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'badge-claims',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();

            if (!body.eventBadgeId || !body.teamId) {
                return { status: 400, jsonBody: { error: 'eventBadgeId and teamId are required' } };
            }

            const claimParticipations = await participationsStorage.getAll();
            if (!isTeamMember(auth.user, body.teamId, claimParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to claim badges for this team' } };
            }

            const eventBadges = await eventBadgesStorage.getAll();
            const eventBadge = eventBadges.find(eb => eb.id === body.eventBadgeId && eb.isActive);
            if (!eventBadge) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found or inactive' } };
            }

            const claims = await badgeClaimsStorage.getAll();
            const existingClaim = claims.find(c =>
                c.eventBadgeId === body.eventBadgeId &&
                c.teamId === body.teamId &&
                c.status !== 'declined' &&
                c.status !== 'draft'
            );
            if (existingClaim) {
                return { status: 409, jsonBody: { error: 'Team has already claimed this badge', existingClaim } };
            }

            const declinedClaim = claims.find(c =>
                c.eventBadgeId === body.eventBadgeId &&
                c.teamId === body.teamId &&
                c.status === 'declined'
            );

            if (declinedClaim) {
                const upgraded = await badgeClaimsStorage.update(declinedClaim.id, {
                    status: 'pending',
                    blogUrl: body.blogUrl || body.evidence || '',
                    evidence: body.evidence || body.blogUrl || '',
                    claimedBy: body.claimedBy || null,
                    claimedAt: new Date().toISOString(),
                    reviewedBy: null,
                    reviewedAt: null
                });
                context.log(`Badge re-claimed: team ${body.teamId} re-claims badge ${eventBadge.badgeId}`);
                return { status: 201, jsonBody: upgraded };
            }

            const draftClaim = claims.find(c =>
                c.eventBadgeId === body.eventBadgeId &&
                c.teamId === body.teamId &&
                c.status === 'draft'
            );

            if (draftClaim) {
                const upgraded = await badgeClaimsStorage.update(draftClaim.id, {
                    status: 'pending',
                    blogUrl: body.blogUrl || body.evidence || '',
                    evidence: body.evidence || body.blogUrl || '',
                    claimedBy: body.claimedBy || null,
                    claimedAt: new Date().toISOString()
                });
                context.log(`Badge draft upgraded to claim: team ${body.teamId} claims badge ${eventBadge.badgeId}`);
                return { status: 201, jsonBody: upgraded };
            }

            const newClaim = {
                id: generateGuid(),
                eventBadgeId: body.eventBadgeId,
                eventId: eventBadge.eventId,
                badgeId: eventBadge.badgeId,
                teamId: body.teamId,
                status: 'pending',
                blogUrl: body.blogUrl || body.evidence || '',
                evidence: body.evidence || body.blogUrl || '',
                assignedToUserId: body.assignedToUserId || null,
                claimedBy: body.claimedBy || null,
                claimedAt: new Date().toISOString()
            };

            await badgeClaimsStorage.create(newClaim);

            context.log(`Badge claim created: team ${body.teamId} claims badge ${eventBadge.badgeId}`);
            return { status: 201, jsonBody: newClaim };
        } catch (error) {
            await logError(context, error);
            context.error('Badge claims CREATE error:', error);
            return { status: 500, jsonBody: { error: 'Failed to create badge claim' } };
        }
    }
});

app.http('badge-claims-review', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'badge-claims/{id}/review',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await request.json();

            if (!body.status || !['approved', 'declined'].includes(body.status)) {
                return { status: 400, jsonBody: { error: 'status must be "approved" or "declined"' } };
            }

            if (body.status === 'declined' && !body.declineReason) {
                return { status: 400, jsonBody: { error: 'declineReason is required when declining' } };
            }

            const claim = await badgeClaimsStorage.getById(id);

            if (!claim) {
                return { status: 404, jsonBody: { error: 'Badge claim not found' } };
            }

            const reviewParticipations = await participationsStorage.getAll();
            if (!hasEventRole(auth.user, claim.eventId, 'judge', reviewParticipations) && !auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'Only judges or admins can review badge claims' } };
            }

            const updated = await badgeClaimsStorage.update(id, {
                status: body.status,
                declineReason: body.status === 'declined' ? body.declineReason : null,
                reviewedBy: body.reviewedBy || null,
                reviewedAt: new Date().toISOString()
            });

            context.log(`Badge claim ${id} ${body.status} by ${body.reviewedBy || 'unknown'}`);
            return { status: 200, jsonBody: updated };
        } catch (error) {
            await logError(context, error);
            context.error('Badge claims REVIEW error:', error);
            return { status: 500, jsonBody: { error: 'Failed to review badge claim' } };
        }
    }
});

app.http('badge-claims-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'badge-claims/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await request.json();

            const claim = await badgeClaimsStorage.getById(id);

            if (!claim) {
                return { status: 404, jsonBody: { error: 'Badge claim not found' } };
            }

            if (claim.status === 'approved') {
                return { status: 400, jsonBody: { error: 'Cannot modify an approved claim' } };
            }

            const updateParticipations = await participationsStorage.getAll();
            if (!isTeamMember(auth.user, claim.teamId, updateParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this claim' } };
            }

            const updated = await badgeClaimsStorage.update(id, {
                evidence: body.evidence !== undefined ? body.evidence : claim.evidence,
                blogUrl: body.blogUrl !== undefined ? body.blogUrl : (claim.blogUrl || ''),
                assignedToUserId: body.assignedToUserId !== undefined ? body.assignedToUserId : claim.assignedToUserId,
                status: claim.status === 'declined' && body.reclaim ? 'pending' : claim.status
            });

            context.log(`Badge claim ${id} updated`);
            return { status: 200, jsonBody: updated };
        } catch (error) {
            await logError(context, error);
            context.error('Badge claims UPDATE error:', error);
            return { status: 500, jsonBody: { error: 'Failed to update badge claim' } };
        }
    }
});

app.http('badge-claims-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'badge-claims/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;

            const claim = await badgeClaimsStorage.getById(id);

            if (!claim) {
                return { status: 404, jsonBody: { error: 'Badge claim not found' } };
            }

            const deleteParticipations = await participationsStorage.getAll();
            if (!hasEventRole(auth.user, claim.eventId, 'judge', deleteParticipations) && !auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'Only judges or admins can delete badge claims' } };
            }

            await badgeClaimsStorage.delete(id);

            context.log(`Badge claim ${id} deleted`);
            return { status: 200, jsonBody: { message: 'Badge claim deleted' } };
        } catch (error) {
            await logError(context, error);
            context.error('Badge claims DELETE error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete badge claim' } };
        }
    }
});

app.http('badge-claims-award', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'badge-claims/award',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();

            if (!body.eventBadgeId || !body.teamId) {
                return { status: 400, jsonBody: { error: 'eventBadgeId and teamId are required' } };
            }

            const eventBadges = await eventBadgesStorage.getAll();
            const eventBadge = eventBadges.find(eb => eb.id === body.eventBadgeId && eb.isActive);
            if (!eventBadge) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found or inactive' } };
            }

            const awardParticipations = await participationsStorage.getAll();
            if (!hasEventRole(auth.user, eventBadge.eventId, 'judge', awardParticipations) && !auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'Only judges or admins can award badges' } };
            }

            const badges = await badgesStorage.getAll();
            const badge = badges.find(b => b.id === eventBadge.badgeId);
            if (!badge || (badge.claimType || 'common') !== 'exclusive') {
                return { status: 400, jsonBody: { error: 'Only exclusive badges can be awarded by judges' } };
            }

            const claims = await badgeClaimsStorage.getAll();
            const existingClaim = claims.find(c =>
                c.eventBadgeId === body.eventBadgeId &&
                c.teamId === body.teamId &&
                c.status !== 'declined'
            );
            if (existingClaim) {
                return { status: 409, jsonBody: { error: 'This badge has already been awarded to this team', existingClaim } };
            }

            const newClaim = {
                id: generateGuid(),
                eventBadgeId: body.eventBadgeId,
                eventId: eventBadge.eventId,
                badgeId: eventBadge.badgeId,
                teamId: body.teamId,
                status: 'approved',
                blogUrl: body.blogUrl || '',
                evidence: '',
                assignedToUserId: null,
                claimedBy: body.awardedBy || null,
                claimedAt: new Date().toISOString(),
                reviewedBy: body.awardedBy || null,
                reviewedAt: new Date().toISOString()
            };

            await badgeClaimsStorage.create(newClaim);

            context.log(`Exclusive badge awarded: ${badge.name} to team ${body.teamId} by ${body.awardedBy || 'unknown'}`);
            return { status: 201, jsonBody: newClaim };
        } catch (error) {
            await logError(context, error);
            context.error('Badge claims AWARD error:', error);
            return { status: 500, jsonBody: { error: 'Failed to award badge' } };
        }
    }
});

app.http('badge-claims-assign', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'badge-claims/assign',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();

            if (!body.eventBadgeId || !body.teamId) {
                return { status: 400, jsonBody: { error: 'eventBadgeId and teamId are required' } };
            }

            const assignParticipations = await participationsStorage.getAll();
            if (!isTeamMember(auth.user, body.teamId, assignParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to assign badges for this team' } };
            }

            const eventBadges = await eventBadgesStorage.getAll();
            const eventBadge = eventBadges.find(eb => eb.id === body.eventBadgeId);
            if (!eventBadge) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found' } };
            }

            const allClaims = await badgeClaimsStorage.getAll();
            const existing = allClaims.find(c =>
                c.eventBadgeId === body.eventBadgeId &&
                c.teamId === body.teamId
            );

            if (existing) {
                const updated = await badgeClaimsStorage.update(existing.id, {
                    assignedToUserId: body.assignedToUserId || null
                });
                return { status: 200, jsonBody: updated };
            } else {
                const draft = {
                    id: generateGuid(),
                    eventBadgeId: body.eventBadgeId,
                    eventId: eventBadge.eventId,
                    badgeId: eventBadge.badgeId,
                    teamId: body.teamId,
                    status: 'draft',
                    blogUrl: '',
                    evidence: '',
                    assignedToUserId: body.assignedToUserId || null,
                    claimedBy: null,
                    claimedAt: new Date().toISOString()
                };
                await badgeClaimsStorage.create(draft);
                return { status: 201, jsonBody: draft };
            }
        } catch (error) {
            await logError(context, error);
            context.error('Badge claims ASSIGN error:', error);
            return { status: 500, jsonBody: { error: 'Failed to assign badge' } };
        }
    }
});

app.http('event-badge-summary', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/{eventId}/badge-summary',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const participations = await participationsStorage.getAll();
            if (!auth.user.isPortalAdmin
                && !hasEventRole(auth.user, eventId, 'judge', participations)
                && !hasEventRole(auth.user, eventId, 'committee', participations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to view this badge summary' } };
            }

            const claims = await badgeClaimsStorage.getAll();
            const badges = await badgesStorage.getAll();
            const teams = await teamsStorage.getAll();

            const eventClaims = claims.filter(c => c.eventId === eventId && c.status === 'approved');

            const teamPoints = {};
            for (const claim of eventClaims) {
                const badge = badges.find(b => b.id === claim.badgeId);
                const points = badge ? badge.points : 0;

                if (!teamPoints[claim.teamId]) {
                    const team = teams.find(t => t.id === claim.teamId);
                    teamPoints[claim.teamId] = {
                        teamId: claim.teamId,
                        teamName: team ? team.teamName : 'Unknown Team',
                        totalPoints: 0,
                        approvedBadges: 0,
                        badges: []
                    };
                }

                teamPoints[claim.teamId].totalPoints += points;
                teamPoints[claim.teamId].approvedBadges++;
                teamPoints[claim.teamId].badges.push({
                    badgeId: claim.badgeId,
                    badgeName: badge ? badge.name : 'Unknown',
                    category: badge ? badge.category : '',
                    points: points
                });
            }

            const leaderboard = Object.values(teamPoints).sort((a, b) => b.totalPoints - a.totalPoints);

            return {
                status: 200,
                jsonBody: {
                    eventId,
                    totalClaims: eventClaims.length,
                    leaderboard
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Badge summary error:', error);
            return { status: 500, jsonBody: { error: 'Failed to get badge summary' } };
        }
    }
});
