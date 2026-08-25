const { app } = require('@azure/functions');
const crypto = require('crypto');
const { logError } = require('../shared/error-log');
const { requireAuth } = require('../shared/auth');
const { Storage: GenericStorage } = require('../shared/storage');

const badgesStorage = new GenericStorage('badges');
const eventBadgesStorage = new GenericStorage('event-badges');

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

