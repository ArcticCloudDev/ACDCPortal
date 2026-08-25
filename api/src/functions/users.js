const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, canManageUser } = require('../shared/auth');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const participationsStorage = new GenericStorage('participations');

app.http('users-get-all', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'users/all',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
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
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const email = request.query.get('email');

            if (email) {
                const isSelf = auth.user.email && auth.user.email.toLowerCase() === email.toLowerCase();
                if (!isSelf && !auth.user.isPortalAdmin) {
                    return {
                        status: 403,
                        jsonBody: { message: 'You do not have permission to view this profile' }
                    };
                }

                const user = await Storage.users.getByEmail(email);
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
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const userId = request.params.id;

            const participations = await participationsStorage.getAll();
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
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return {
                    status: auth.status,
                    jsonBody: auth.jsonBody
                };
            }

            const userId = request.params.id;

            if (!userId) {
                return {
                    status: 400,
                    jsonBody: { message: 'User ID required' }
                };
            }

            const updates = await request.json();

            delete updates.id;
            delete updates.createdAt;
            delete updates.isPortalAdmin;

            const existingUser = await Storage.users.getById(userId);
            if (!existingUser) {
                return {
                    status: 404,
                    jsonBody: { message: 'User not found' }
                };
            }

            const participations = await participationsStorage.getAll();
            if (!canManageUser(auth.user, userId, participations)) {
                return {
                    status: 403,
                    jsonBody: { message: 'You do not have permission to modify this profile' }
                };
            }

            if (updates.email && !existingUser.isTBD) {
                delete updates.email;
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
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const userData = await request.json();

            if (!userData.email) {
                return {
                    status: 400,
                    jsonBody: { message: 'Email is required' }
                };
            }

            delete userData.isPortalAdmin;

            const isSelf = auth.user.email && auth.user.email.toLowerCase() === userData.email.toLowerCase();
            if (!isSelf && !auth.user.isPortalAdmin) {
                return {
                    status: 403,
                    jsonBody: { message: 'You can only create your own user record' }
                };
            }

            const existingUser = await Storage.users.getByEmail(userData.email);
            if (existingUser) {
                return {
                    status: 409,
                    jsonBody: { message: 'User already exists', user: existingUser }
                };
            }

            const newUser = await Storage.users.create(userData);

            context.log(`User created: ${userData.email}`);
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

