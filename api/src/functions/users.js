const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, canManageUser } = require('../shared/auth');
const { generateId, isGuid } = require('../shared/id');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const { Validator, readJson, INVALID_JSON } = require('../shared/validate');
const participationsStorage = new GenericStorage('participations');

// The only columns a profile edit may touch. Everything else in the body (isPortalAdmin,
// teamId, invitationPending, arbitrary keys that would become SQL columns) is dropped.
const PROFILE_LIMITS = { firstName: 100, lastName: 100, phone: 50, gamertag: 100, allergies: 2000 };

function profileUpdates(body, v) {
    const updates = {};
    for (const [field, max] of Object.entries(PROFILE_LIMITS)) {
        if (body[field] === undefined) continue;
        const value = v.string(body[field], field, { max });
        if (value !== undefined) updates[field] = value === null ? (field === 'phone' ? null : '') : value;
    }
    if (body.profileComplete !== undefined) {
        const flag = v.boolean(body.profileComplete, 'profileComplete');
        if (flag !== undefined) updates.profileComplete = flag;
    }
    return updates;
}

async function participationsFor(...userIds) {
    return participationsStorage.findBy({ userId: userIds.filter(Boolean) });
}

app.http('users-get-all', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'users/all',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const users = await Storage.users.getAll();
            return {
                status: 200,
                jsonBody: users
            };
        } catch (error) {
            await logError(context, error);
            context.error('Users GET ALL error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

app.http('users-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'users',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const email = request.query.get('email');

            if (email) {
                if (typeof email !== 'string' || email.length > 320) {
                    return { status: 400, jsonBody: { message: 'Invalid email' } };
                }
                const isSelf = auth.user.email && auth.user.email.toLowerCase() === email.trim().toLowerCase();
                if (!isSelf && !auth.user.isAdmin) {
                    return {
                        status: 403,
                        jsonBody: { message: 'You do not have permission to view this profile' }
                    };
                }

                const user = await Storage.users.getByEmail(email.trim());
                if (!user) {
                    return {
                        status: 404,
                        jsonBody: { message: 'User not found' }
                    };
                }
                return {
                    status: 200,
                    jsonBody: user
                };
            }

            return {
                status: 400,
                jsonBody: { message: 'Email query parameter required' }
            };

        } catch (error) {
            await logError(context, error);
            context.error('Users GET error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

app.http('users-get-by-id', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'users/{id}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const userId = request.params.id;
            if (!isGuid(userId)) {
                return { status: 404, jsonBody: { message: 'User not found' } };
            }

            const participations = await participationsFor(auth.user.userId, userId);
            if (!canManageUser(auth.user, userId, participations)) {
                return {
                    status: 403,
                    jsonBody: { message: 'You do not have permission to view this profile' }
                };
            }

            const user = await Storage.users.getById(userId);
            if (!user) {
                return {
                    status: 404,
                    jsonBody: { message: 'User not found' }
                };
            }

            return {
                status: 200,
                jsonBody: user
            };

        } catch (error) {
            await logError(context, error);
            context.error('Users GET by ID error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

app.http('users-update', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'users/{id}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const userId = request.params.id;
            if (!isGuid(userId)) {
                return { status: 404, jsonBody: { message: 'User not found' } };
            }

            const body = await readJson(request);
            if (!body) return INVALID_JSON;

            const existingUser = await Storage.users.getById(userId);
            if (!existingUser) {
                return {
                    status: 404,
                    jsonBody: { message: 'User not found' }
                };
            }

            const participations = await participationsFor(auth.user.userId, userId);
            if (!canManageUser(auth.user, userId, participations)) {
                return {
                    status: 403,
                    jsonBody: { message: 'You do not have permission to modify this profile' }
                };
            }

            const v = new Validator();
            const updates = profileUpdates(body, v);

            // Email is identity (it is what the OTP login proves); only an admin may change it.
            if (auth.user.isAdmin && body.email !== undefined) {
                const email = v.email(body.email, 'email');
                if (email && email !== existingUser.email?.toLowerCase()) {
                    const taken = await Storage.users.getByEmail(email);
                    if (taken) return { status: 409, jsonBody: { message: 'Another user already has that email' } };
                    updates.email = email;
                }
            }
            if (v.failed) return v.failure();

            if (Object.keys(updates).length === 0) {
                return { status: 200, jsonBody: existingUser };
            }

            const updatedUser = await Storage.users.update(userId, updates);

            context.log(`User ${userId} updated`);
            return {
                status: 200,
                jsonBody: updatedUser
            };

        } catch (error) {
            await logError(context, error);
            context.error('Users PUT error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

app.http('users-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'users',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await readJson(request);
            if (!body) return INVALID_JSON;

            const v = new Validator();
            const email = v.email(body.email, 'email');
            if (v.failed) return v.failure();

            const isSelf = auth.user.email && auth.user.email.toLowerCase() === email;
            if (!isSelf && !auth.user.isAdmin) {
                return {
                    status: 403,
                    jsonBody: { message: 'You can only create your own user record' }
                };
            }

            const profile = profileUpdates(body, v);
            if (v.failed) return v.failure();

            const existingUser = await Storage.users.getByEmail(email);
            if (existingUser) {
                return {
                    status: 409,
                    jsonBody: { message: 'User already exists', user: existingUser }
                };
            }

            const now = new Date().toISOString();
            const newUser = {
                id: isGuid(body.id) ? body.id : generateId(),
                email,
                firstName: profile.firstName || '',
                lastName: profile.lastName || '',
                phone: profile.phone ?? null,
                gamertag: profile.gamertag || '',
                allergies: profile.allergies || '',
                profileComplete: profile.profileComplete === true,
                createdAt: now,
                updatedAt: now
            };

            if (await Storage.users.getById(newUser.id)) {
                return { status: 409, jsonBody: { message: 'User already exists' } };
            }

            await Storage.users.create(newUser);

            context.log(`User created: ${newUser.id}`);
            return {
                status: 201,
                jsonBody: newUser
            };

        } catch (error) {
            await logError(context, error);
            context.error('Users POST error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
