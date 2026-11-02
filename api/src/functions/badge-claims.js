const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, isTeamMember, hasEventRole } = require('../shared/auth');
const { Storage: GenericStorage } = require('../shared/storage');
const StorageModule = require('../shared/storage');
const { generateId, isGuid, sameId } = require('../shared/id');
const { isHttpUrl, upperId } = require('../shared/validate');
const q = require('../shared/admin-queries');

const badgesStorage = new GenericStorage('badges');
const eventBadgesStorage = new GenericStorage('event-badges');
const badgeClaimsStorage = new GenericStorage('badge-claims');

const MAX_TEXT = 2000;

// Optional GUID body field: returns { value } (null when absent) or { error }.
function optionalGuid(body, key) {
    const value = body[key];
    if (value === undefined || value === null || value === '') return { value: null };
    return isGuid(value) ? { value } : { error: `${key} must be a GUID` };
}

// blogUrl: empty or an http(s) URL; evidence: free text. Both fit NVARCHAR(2000).
function validateClaimText({ blogUrl, evidence }) {
    if (blogUrl !== undefined && blogUrl !== null && blogUrl !== '') {
        if (typeof blogUrl !== 'string' || blogUrl.length > MAX_TEXT) return `blogUrl must be at most ${MAX_TEXT} characters`;
        if (!isHttpUrl(blogUrl)) return 'blogUrl must be an http(s) URL';
    }
    if (evidence !== undefined && evidence !== null && evidence !== '') {
        if (typeof evidence !== 'string') return 'evidence must be a string';
        if (evidence.length > MAX_TEXT) return `evidence must be at most ${MAX_TEXT} characters`;
    }
    return null;
}

// The team must exist and belong to the badge's event.
async function teamForEventBadge(teamId, eventBadge) {
    const team = await StorageModule.teams.getById(teamId);
    if (!team) return { error: { status: 404, body: { error: 'Team not found' } } };
    if (!sameId(team.eventId, eventBadge.eventId)) return { error: { status: 400, body: { error: 'Team does not belong to the event this badge is assigned to' } } };
    return { team };
}

async function isJudgeOrAdmin(actor, eventId) {
    if (actor.isPortalAdmin) return true;
    const participations = await q.participationsForUser(actor.userId);
    return hasEventRole(actor, upperId(eventId), 'judge', participations);
}

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

            if ((eventId && !isGuid(eventId)) || (teamId && !isGuid(teamId))) {
                return { status: 400, jsonBody: { error: 'eventId and teamId must be GUIDs' } };
            }
            if (status && !['draft', 'pending', 'approved', 'declined'].includes(status)) {
                return { status: 400, jsonBody: { error: 'Invalid status filter' } };
            }

            const actor = q.asActor(auth.user);
            let claims = await q.claims({ eventId, teamId, status, badgeId: badgeId || undefined });

            if (!actor.isPortalAdmin) {
                const participations = await q.participationsForUser(actor.userId);
                claims = claims.filter(c => {
                    if (c.eventId && (hasEventRole(actor, upperId(c.eventId), 'judge', participations)
                        || hasEventRole(actor, upperId(c.eventId), 'committee', participations))) {
                        return true;
                    }
                    return c.teamId && isTeamMember(actor, upperId(c.teamId), participations);
                });
            }

            const badges = await q.badgesByIds(claims.map(c => c.badgeId));
            const teams = await q.teamsByIds(claims.map(c => c.teamId));

            const enriched = claims.map(c => {
                const team = teams.find(t => sameId(t.id, c.teamId));
                return {
                    ...c,
                    badge: badges.find(b => b.id === c.badgeId) || null,
                    team: team ? { id: c.teamId, teamName: team.teamName } : null
                };
            });

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

            if (!body || !body.eventBadgeId || !body.teamId) {
                return { status: 400, jsonBody: { error: 'eventBadgeId and teamId are required' } };
            }
            if (!isGuid(body.eventBadgeId) || !isGuid(body.teamId)) {
                return { status: 400, jsonBody: { error: 'eventBadgeId and teamId must be GUIDs' } };
            }
            const claimedBy = optionalGuid(body, 'claimedBy');
            const assignedTo = optionalGuid(body, 'assignedToUserId');
            const textError = validateClaimText(body) || claimedBy.error || assignedTo.error;
            if (textError) {
                return { status: 400, jsonBody: { error: textError } };
            }

            const actor = q.asActor(auth.user);
            const claimParticipations = await q.participationsForUser(actor.userId);
            if (!isTeamMember(actor, upperId(body.teamId), claimParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to claim badges for this team' } };
            }

            const eventBadge = await eventBadgesStorage.getById(body.eventBadgeId);
            if (!eventBadge || !eventBadge.isActive) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found or inactive' } };
            }

            const teamCheck = await teamForEventBadge(body.teamId, eventBadge);
            if (teamCheck.error) {
                return { status: teamCheck.error.status, jsonBody: teamCheck.error.body };
            }

            const claims = await q.claims({ eventBadgeId: body.eventBadgeId, teamId: body.teamId });
            const existingClaim = claims.find(c => c.status !== 'declined' && c.status !== 'draft');
            if (existingClaim) {
                return { status: 409, jsonBody: { error: 'Team has already claimed this badge', existingClaim } };
            }

            const blogUrl = body.blogUrl || body.evidence || '';
            const evidence = body.evidence || body.blogUrl || '';
            const claimer = claimedBy.value || actor.userId || null;

            const declinedClaim = claims.find(c => c.status === 'declined');

            if (declinedClaim) {
                const upgraded = await badgeClaimsStorage.update(declinedClaim.id, {
                    status: 'pending',
                    blogUrl,
                    evidence,
                    claimedBy: claimer,
                    claimedAt: new Date().toISOString(),
                    reviewedBy: null,
                    reviewedAt: null
                });
                context.log(`Badge re-claimed: team ${body.teamId} re-claims badge ${eventBadge.badgeId}`);
                return { status: 201, jsonBody: upgraded };
            }

            const draftClaim = claims.find(c => c.status === 'draft');

            if (draftClaim) {
                const upgraded = await badgeClaimsStorage.update(draftClaim.id, {
                    status: 'pending',
                    blogUrl,
                    evidence,
                    claimedBy: claimer,
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
                blogUrl,
                evidence,
                assignedToUserId: assignedTo.value,
                claimedBy: claimer,
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

            if (!body || !body.status || !['approved', 'declined'].includes(body.status)) {
                return { status: 400, jsonBody: { error: 'status must be "approved" or "declined"' } };
            }

            if (body.status === 'declined' && (typeof body.declineReason !== 'string' || !body.declineReason.trim())) {
                return { status: 400, jsonBody: { error: 'declineReason is required when declining' } };
            }
            const reviewedBy = optionalGuid(body, 'reviewedBy');
            if (reviewedBy.error) {
                return { status: 400, jsonBody: { error: reviewedBy.error } };
            }

            const claim = isGuid(id) ? await badgeClaimsStorage.getById(id) : null;

            if (!claim) {
                return { status: 404, jsonBody: { error: 'Badge claim not found' } };
            }

            const actor = q.asActor(auth.user);
            if (!(await isJudgeOrAdmin(actor, claim.eventId))) {
                return { status: 403, jsonBody: { error: 'Only judges or admins can review badge claims' } };
            }

            // A badge with a dedicated judge is reviewed by that judge (or a portal admin) only.
            const eventBadge = await eventBadgesStorage.getById(claim.eventBadgeId);
            if (eventBadge?.judgeUserId && !actor.isPortalAdmin && !sameId(eventBadge.judgeUserId, actor.userId)) {
                return { status: 403, jsonBody: { error: 'This badge is reviewed by its assigned judge' } };
            }

            if (claim.status !== 'pending') {
                return { status: 409, jsonBody: { error: `Only pending claims can be reviewed (this claim is ${claim.status})` } };
            }

            const updated = await badgeClaimsStorage.update(id, {
                status: body.status,
                declineReason: body.status === 'declined' ? body.declineReason.trim() : null,
                reviewedBy: actor.userId || reviewedBy.value || null,
                reviewedAt: new Date().toISOString()
            });

            context.log(`Badge claim ${id} ${body.status} by ${actor.userId || 'unknown'}`);
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

            const claim = isGuid(id) ? await badgeClaimsStorage.getById(id) : null;

            if (!claim) {
                return { status: 404, jsonBody: { error: 'Badge claim not found' } };
            }

            if (claim.status === 'approved') {
                return { status: 400, jsonBody: { error: 'Cannot modify an approved claim' } };
            }

            const assignedTo = optionalGuid(body || {}, 'assignedToUserId');
            const textError = validateClaimText(body || {}) || assignedTo.error;
            if (textError) {
                return { status: 400, jsonBody: { error: textError } };
            }

            const actor = q.asActor(auth.user);
            const updateParticipations = await q.participationsForUser(actor.userId);
            if (!isTeamMember(actor, upperId(claim.teamId), updateParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to modify this claim' } };
            }

            const updated = await badgeClaimsStorage.update(id, {
                evidence: body.evidence !== undefined ? (body.evidence || '') : claim.evidence,
                blogUrl: body.blogUrl !== undefined ? (body.blogUrl || '') : (claim.blogUrl || ''),
                assignedToUserId: body.assignedToUserId !== undefined ? assignedTo.value : claim.assignedToUserId,
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

            const claim = isGuid(id) ? await badgeClaimsStorage.getById(id) : null;

            if (!claim) {
                return { status: 404, jsonBody: { error: 'Badge claim not found' } };
            }

            const actor = q.asActor(auth.user);
            if (!(await isJudgeOrAdmin(actor, claim.eventId))) {
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

            if (!body || !body.eventBadgeId || !body.teamId) {
                return { status: 400, jsonBody: { error: 'eventBadgeId and teamId are required' } };
            }
            if (!isGuid(body.eventBadgeId) || !isGuid(body.teamId)) {
                return { status: 400, jsonBody: { error: 'eventBadgeId and teamId must be GUIDs' } };
            }
            const awardedBy = optionalGuid(body, 'awardedBy');
            const textError = validateClaimText({ blogUrl: body.blogUrl }) || awardedBy.error;
            if (textError) {
                return { status: 400, jsonBody: { error: textError } };
            }

            const eventBadge = await eventBadgesStorage.getById(body.eventBadgeId);
            if (!eventBadge || !eventBadge.isActive) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found or inactive' } };
            }

            const actor = q.asActor(auth.user);
            if (!(await isJudgeOrAdmin(actor, eventBadge.eventId))) {
                return { status: 403, jsonBody: { error: 'Only judges or admins can award badges' } };
            }
            if (eventBadge.judgeUserId && !actor.isPortalAdmin && !sameId(eventBadge.judgeUserId, actor.userId)) {
                return { status: 403, jsonBody: { error: 'This badge is awarded by its assigned judge' } };
            }

            const badge = await badgesStorage.getById(eventBadge.badgeId);
            if (!badge || (badge.claimType || 'common') !== 'exclusive') {
                return { status: 400, jsonBody: { error: 'Only exclusive badges can be awarded by judges' } };
            }

            const teamCheck = await teamForEventBadge(body.teamId, eventBadge);
            if (teamCheck.error) {
                return { status: teamCheck.error.status, jsonBody: teamCheck.error.body };
            }

            const claims = await q.claims({ eventBadgeId: body.eventBadgeId, teamId: body.teamId });
            const existingClaim = claims.find(c => c.status !== 'declined');
            if (existingClaim) {
                return { status: 409, jsonBody: { error: 'This badge has already been awarded to this team', existingClaim } };
            }

            const awarder = awardedBy.value || actor.userId || null;
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
                claimedBy: awarder,
                claimedAt: new Date().toISOString(),
                reviewedBy: awarder,
                reviewedAt: new Date().toISOString()
            };

            await badgeClaimsStorage.create(newClaim);

            context.log(`Exclusive badge awarded: ${badge.name} to team ${body.teamId} by ${awarder || 'unknown'}`);
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

            if (!body || !body.eventBadgeId || !body.teamId) {
                return { status: 400, jsonBody: { error: 'eventBadgeId and teamId are required' } };
            }
            if (!isGuid(body.eventBadgeId) || !isGuid(body.teamId)) {
                return { status: 400, jsonBody: { error: 'eventBadgeId and teamId must be GUIDs' } };
            }
            const assignedTo = optionalGuid(body, 'assignedToUserId');
            if (assignedTo.error) {
                return { status: 400, jsonBody: { error: assignedTo.error } };
            }

            const actor = q.asActor(auth.user);
            const assignParticipations = await q.participationsForUser(actor.userId);
            if (!isTeamMember(actor, upperId(body.teamId), assignParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to assign badges for this team' } };
            }

            const eventBadge = await eventBadgesStorage.getById(body.eventBadgeId);
            if (!eventBadge) {
                return { status: 404, jsonBody: { error: 'Event-badge assignment not found' } };
            }

            const teamCheck = await teamForEventBadge(body.teamId, eventBadge);
            if (teamCheck.error) {
                return { status: teamCheck.error.status, jsonBody: teamCheck.error.body };
            }

            const existing = (await q.claims({ eventBadgeId: body.eventBadgeId, teamId: body.teamId }))[0];

            if (existing) {
                const updated = await badgeClaimsStorage.update(existing.id, {
                    assignedToUserId: assignedTo.value
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
                    assignedToUserId: assignedTo.value,
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
