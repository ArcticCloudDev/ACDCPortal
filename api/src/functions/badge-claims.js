const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, isTeamMember, hasEventRole } = require('../shared/auth');
const { Storage: GenericStorage } = require('../shared/storage');
const { generateId } = require('../shared/id');

const badgesStorage = new GenericStorage('badges');
const eventBadgesStorage = new GenericStorage('event-badges');
const badgeClaimsStorage = new GenericStorage('badge-claims');
const participationsStorage = new GenericStorage('participations');
const teamsStorage = new GenericStorage('teams');

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
                id: generateId(),
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
                id: generateId(),
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
                    id: generateId(),
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
