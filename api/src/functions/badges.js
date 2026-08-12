// Badges API - Master badges, event-badge assignments, and badge claims
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth } = require('../shared/auth');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');

const badgesStorage = new GenericStorage('badges');
const eventBadgesStorage = new GenericStorage('event-badges');
const badgeClaimsStorage = new GenericStorage('badge-claims');
const eventsStorage = new GenericStorage('events');

// Helper to generate GUID
function generateGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// ============================================================
// MASTER BADGES - CRUD
// ============================================================

// GET /api/badges - List all master badges
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

            // Sort by category then name
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

// GET /api/badges/:id - Get single badge
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

// POST /api/badges - Create a new master badge
app.http('badges-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'badges',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
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

// PUT /api/badges/:id - Update a master badge
app.http('badges-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'badges/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
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

// DELETE /api/badges/:id - Delete a master badge
app.http('badges-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'badges/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
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

            // Also clean up event-badge assignments
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


// ============================================================
// EVENT-BADGES - Many-to-many with judge assignment
// ============================================================

// GET /api/events/:eventId/badges - List badges assigned to an event
app.http('event-badges-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/{eventId}/badges',
    handler: async (request, context) => {
        try {
            const eventId = request.params.eventId;
            const eventBadges = await eventBadgesStorage.getAll();
            const badges = await badgesStorage.getAll();

            // Get event-badge assignments for this event
            const assignments = eventBadges.filter(eb => eb.eventId === eventId);

            // Enrich with badge details
            const enriched = assignments.map(eb => {
                const badge = badges.find(b => b.id === eb.badgeId);
                return {
                    ...eb,
                    badge: badge || null
                };
            });

            // Sort by category then name
            const categoryOrder = { 'soft': 0, 'low-code': 1, 'pro-code': 2, 'sponsor': 3 };
            enriched.sort((a, b) => {
                if (!a.badge || !b.badge) return 0;
                const catDiff = (categoryOrder[a.badge.category] || 99) - (categoryOrder[b.badge.category] || 99);
                if (catDiff !== 0) return catDiff;
                return a.badge.name.localeCompare(b.badge.name);
            });

            return { status: 200, jsonBody: enriched };
        } catch (error) {
            await logError(context, error);
            context.error('Event badges LIST error:', error);
            return { status: 500, jsonBody: { error: 'Failed to list event badges' } };
        }
    }
});

// POST /api/events/:eventId/badges - Add badge(s) to event
app.http('event-badges-add', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events/{eventId}/badges',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const body = await request.json();

            // Support single badgeId or array of badgeIds
            const badgeIds = body.badgeIds || (body.badgeId ? [body.badgeId] : []);
            if (badgeIds.length === 0) {
                return { status: 400, jsonBody: { error: 'badgeId or badgeIds is required' } };
            }

            // Validate event exists
            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === eventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            // Validate badges exist
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

                // Check if already assigned
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

// PUT /api/events/:eventId/badges/:id - Update event-badge (assign judge, toggle active)
app.http('event-badges-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'events/{eventId}/badges/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
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

// DELETE /api/events/:eventId/badges/:id - Remove badge from event
app.http('event-badges-remove', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'events/{eventId}/badges/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, id } = request.params;

            const eventBadge = await eventBadgesStorage.getById(id);

            if (!eventBadge || eventBadge.eventId !== eventId) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found' } };
            }

            await eventBadgesStorage.delete(id);

            // Also clean up claims for this event-badge
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

// POST /api/events/:eventId/badges/bulk - Bulk add/remove badges for an event
app.http('event-badges-bulk', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events/{eventId}/badges/bulk',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const body = await request.json();
            const { selectedBadgeIds } = body; // Array of badge IDs that should be assigned

            if (!Array.isArray(selectedBadgeIds)) {
                return { status: 400, jsonBody: { error: 'selectedBadgeIds array is required' } };
            }

            const eventBadges = await eventBadgesStorage.getAll();

            // Get current assignments for this event
            const currentAssignments = eventBadges.filter(eb => eb.eventId === eventId);
            const currentBadgeIds = currentAssignments.map(eb => eb.badgeId);

            // Determine adds and removes
            const toAdd = selectedBadgeIds.filter(id => !currentBadgeIds.includes(id));
            const toRemove = currentAssignments.filter(eb => !selectedBadgeIds.includes(eb.badgeId));

            // Remove
            for (const eb of toRemove) {
                await eventBadgesStorage.delete(eb.id);
            }

            // Add
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

            // Clean up claims for removed badges
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


// ============================================================
// BADGE CLAIMS - Teams claim badges, judges review
// ============================================================

// GET /api/badge-claims - List claims (filterable by eventId, teamId, status)
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

            // Enrich with badge details
            const badges = await badgesStorage.getAll();
            const teams = await Storage.teams.getAll();

            const enriched = claims.map(c => ({
                ...c,
                badge: badges.find(b => b.id === c.badgeId) || null,
                team: teams.find(t => t.id === c.teamId) ? { id: c.teamId, teamName: teams.find(t => t.id === c.teamId).teamName } : null
            }));

            // Sort by claimed date (newest first)
            enriched.sort((a, b) => new Date(b.claimedAt) - new Date(a.claimedAt));

            return { status: 200, jsonBody: enriched };
        } catch (error) {
            await logError(context, error);
            context.error('Badge claims LIST error:', error);
            return { status: 500, jsonBody: { error: 'Failed to list badge claims' } };
        }
    }
});

// POST /api/badge-claims - Team claims a badge
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

            // Validate event-badge assignment exists and is active
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

            // Check if there's a declined claim — re-claim by upgrading it back to pending
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

            // Check if there's a draft claim (from assigning) - upgrade it
            const draftClaim = claims.find(c =>
                c.eventBadgeId === body.eventBadgeId &&
                c.teamId === body.teamId &&
                c.status === 'draft'
            );

            if (draftClaim) {
                // Upgrade draft to pending claim
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

// PUT /api/badge-claims/:id/review - Judge reviews a claim (approve/decline)
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

// PUT /api/badge-claims/:id - Update a claim (e.g. update evidence)
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

            // Only allow updating evidence/blogUrl and re-claiming if declined
            if (claim.status === 'approved') {
                return { status: 400, jsonBody: { error: 'Cannot modify an approved claim' } };
            }

            const updated = await badgeClaimsStorage.update(id, {
                evidence: body.evidence !== undefined ? body.evidence : claim.evidence,
                blogUrl: body.blogUrl !== undefined ? body.blogUrl : (claim.blogUrl || ''),
                assignedToUserId: body.assignedToUserId !== undefined ? body.assignedToUserId : claim.assignedToUserId,
                // If re-claiming after decline, reset to pending
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

// DELETE /api/badge-claims/:id - Delete a claim
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

// POST /api/badge-claims/award - Judge awards an exclusive badge to a team (no blog URL required)
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

            // Validate event-badge assignment exists and is active
            const eventBadges = await eventBadgesStorage.getAll();
            const eventBadge = eventBadges.find(eb => eb.id === body.eventBadgeId && eb.isActive);
            if (!eventBadge) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found or inactive' } };
            }

            // Validate badge is exclusive type
            const badges = await badgesStorage.getAll();
            const badge = badges.find(b => b.id === eventBadge.badgeId);
            if (!badge || (badge.claimType || 'common') !== 'exclusive') {
                return { status: 400, jsonBody: { error: 'Only exclusive badges can be awarded by judges' } };
            }

            // Check if this team already has this badge awarded
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
                status: 'approved',  // Exclusive badges are instantly approved when awarded by judge
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

// PUT /api/badge-claims/assign - Assign a team member to a badge (creates draft claim if none exists)
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

            // Validate event-badge exists
            const eventBadges = await eventBadgesStorage.getAll();
            const eventBadge = eventBadges.find(eb => eb.id === body.eventBadgeId);
            if (!eventBadge) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found' } };
            }

            // Find existing claim for this team + event-badge
            const allClaims = await badgeClaimsStorage.getAll();
            const existing = allClaims.find(c =>
                c.eventBadgeId === body.eventBadgeId &&
                c.teamId === body.teamId
            );

            if (existing) {
                // Update assignment on existing claim
                const updated = await badgeClaimsStorage.update(existing.id, {
                    assignedToUserId: body.assignedToUserId || null
                });
                return { status: 200, jsonBody: updated };
            } else {
                // Create a draft claim with just assignment
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

// GET /api/events/:eventId/badge-summary - Get badge summary for an event (points per team)
app.http('event-badge-summary', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/{eventId}/badge-summary',
    handler: async (request, context) => {
        try {
            const eventId = request.params.eventId;

            const claims = await badgeClaimsStorage.getAll();
            const badges = await badgesStorage.getAll();
            const teams = await Storage.teams.getAll();

            // Get approved claims for this event
            const eventClaims = claims.filter(c => c.eventId === eventId && c.status === 'approved');

            // Calculate points per team
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

            // Sort by total points descending
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
