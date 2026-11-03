const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth } = require('../shared/auth');
const { Storage: GenericStorage } = require('../shared/storage');
const { generateId } = require('../shared/id');
const { isHttpUrl, toInt } = require('../shared/validate');
const { deleteBadgeCascade } = require('../shared/admin-queries');

const badgesStorage = new GenericStorage('badges');

const VALID_CATEGORIES = ['soft', 'low-code', 'pro-code', 'sponsor'];
const VALID_CLAIM_TYPES = ['common', 'exclusive'];
const CATEGORY_ORDER = { 'soft': 0, 'low-code': 1, 'pro-code': 2, 'sponsor': 3 };

// Validates the writable badge fields present in `body`. Returns an error string or null.
function validateBadgeBody(body, { requireAll }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object';
    if (requireAll || body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) return 'Badge name is required';
        if (body.name.length > 200) return 'Badge name must be at most 200 characters';
    }
    if (requireAll && !body.category) return 'Badge category is required';
    if (body.category !== undefined && !VALID_CATEGORIES.includes(body.category)) {
        return `Category must be one of: ${VALID_CATEGORIES.join(', ')}`;
    }
    if (body.claimType !== undefined && body.claimType !== null && !VALID_CLAIM_TYPES.includes(body.claimType)) {
        return `claimType must be one of: ${VALID_CLAIM_TYPES.join(', ')}`;
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') return 'description must be a string';
    if (body.points !== undefined && body.points !== null && body.points !== '' && toInt(body.points, { min: 0, max: 1000000 }) === null) {
        return 'points must be a non-negative integer';
    }
    if (body.imageUrl !== undefined && body.imageUrl !== null && body.imageUrl !== '' && !isHttpUrl(body.imageUrl)) {
        return 'imageUrl must be an http(s) URL';
    }
    return null;
}

function isValidBadgeId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 100;
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

            badges.sort((a, b) => {
                const catDiff = (CATEGORY_ORDER[a.category] ?? 99) - (CATEGORY_ORDER[b.category] ?? 99);
                if (catDiff !== 0) return catDiff;
                return (a.name || '').localeCompare(b.name || '');
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
            const badge = isValidBadgeId(id) ? await badgesStorage.getById(id) : null;

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
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();

            const validationError = validateBadgeBody(body, { requireAll: true });
            if (validationError) {
                return { status: 400, jsonBody: { error: validationError } };
            }

            const newBadge = {
                id: generateId(),
                name: body.name.trim(),
                description: body.description || '',
                category: body.category,
                claimType: body.claimType || 'common',
                imageUrl: body.imageUrl || '',
                points: toInt(body.points, { min: 0, max: 1000000 }) ?? 0,
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
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await request.json();

            const badge = isValidBadgeId(id) ? await badgesStorage.getById(id) : null;

            if (!badge) {
                return { status: 404, jsonBody: { error: 'Badge not found' } };
            }

            const validationError = validateBadgeBody(body, { requireAll: false });
            if (validationError) {
                return { status: 400, jsonBody: { error: validationError } };
            }

            const updates = {
                name: body.name !== undefined ? body.name.trim() : badge.name,
                description: body.description !== undefined ? (body.description || '') : badge.description,
                category: body.category !== undefined ? body.category : badge.category,
                claimType: body.claimType ? body.claimType : (badge.claimType || 'common'),
                imageUrl: body.imageUrl !== undefined ? (body.imageUrl || '') : badge.imageUrl,
                points: body.points !== undefined && body.points !== null && body.points !== '' ? toInt(body.points, { min: 0, max: 1000000 }) : badge.points,
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
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;

            const badge = isValidBadgeId(id) ? await badgesStorage.getById(id) : null;

            if (!badge) {
                return { status: 404, jsonBody: { error: 'Badge not found' } };
            }

            // Claims -> event assignments -> badge, atomically (FK order).
            await deleteBadgeCascade(id);

            context.log(`Badge deleted: ${badge.name}`);
            return { status: 200, jsonBody: { message: 'Badge deleted' } };
        } catch (error) {
            await logError(context, error);
            context.error('Badges DELETE error:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete badge' } };
        }
    }
});
