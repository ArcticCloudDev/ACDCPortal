// Users API - Get and Update user profiles
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const Storage = require('../shared/storage');
const { updateEntraUser } = require('../shared/graph');

// Get all users (for admin dashboard)
app.http('users-get-all', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'users/all',
    handler: async (request, context) => {
        try {
            const users = Storage.users.getAll();
            return {
                status: 200,
                jsonBody: users
            };
        } catch (error) {
            context.error('Users GET ALL error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

// Get user by email (query param)
app.http('users-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'users',
    handler: async (request, context) => {
        try {
            const email = request.query.get('email');
            
            if (email) {
                const user = Storage.users.getByEmail(email);
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
            context.error('Users GET error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

// Get user by ID
app.http('users-get-by-id', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'users/{id}',
    handler: async (request, context) => {
        try {
            const userId = request.params.id;
            
            const user = Storage.users.getById(userId);
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
            context.error('Users GET by ID error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

// Update user by ID
app.http('users-update', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'users/{id}',
    handler: async (request, context) => {
        try {
            const userId = request.params.id;
            
            if (!userId) {
                return {
                    status: 400,
                    jsonBody: { message: 'User ID required' }
                };
            }
            
            const updates = await request.json();
            
            // Don't allow updating certain fields
            delete updates.id;
            delete updates.createdAt;
            
            // Get existing user to check if TBD
            const existingUser = Storage.users.getById(userId);
            if (!existingUser) {
                return {
                    status: 404,
                    jsonBody: { message: 'User not found' }
                };
            }
            
            // Only allow email update if this is a TBD user being converted
            if (updates.email && !existingUser.isTBD) {
                delete updates.email;
            }
            
            // Note: Team membership and admin status is now tracked in participations.teamMemberships
            // teamId and isTeamAdmin fields are deprecated and should not be used
            
            const updatedUser = Storage.users.update(userId, updates);

            // Sync profile to Entra External ID if name or phone changed
            if (updates.firstName || updates.lastName || updates.phone) {
                try {
                    await updateEntraUser(updatedUser.email, {
                        firstName: updates.firstName || updatedUser.firstName,
                        lastName: updates.lastName || updatedUser.lastName,
                        phone: updates.phone || updatedUser.phone
                    });
                    context.log(`Synced profile to Entra for user ${userId}`);
                } catch (entraError) {
                    // Log but don't fail - local update succeeded
                    context.warn(`Failed to sync to Entra: ${entraError.message}`);
                }
            }
            
            context.log(`User ${userId} updated`);
            return {
                status: 200,
                jsonBody: updatedUser
            };
            
        } catch (error) {
            context.error('Users PUT error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

// Create new user
app.http('users-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'users',
    handler: async (request, context) => {
        try {
            const userData = await request.json();
            
            if (!userData.email) {
                return {
                    status: 400,
                    jsonBody: { message: 'Email is required' }
                };
            }
            
            // Check if user already exists
            const existingUser = Storage.users.getByEmail(userData.email);
            if (existingUser) {
                return {
                    status: 409,
                    jsonBody: { message: 'User already exists', user: existingUser }
                };
            }
            
            // Create user
            const newUser = Storage.users.create(userData);
            
            context.log(`User created: ${userData.email}`);
            return {
                status: 201,
                jsonBody: newUser
            };
            
        } catch (error) {
            context.error('Users POST error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
