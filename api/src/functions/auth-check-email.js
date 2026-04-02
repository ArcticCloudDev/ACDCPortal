// Auth Check Email - Check if email exists in the system (for register/login routing)
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const Storage = require('../shared/storage');

app.http('auth-check-email', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'auth/check-email',
    handler: async (request, context) => {
        context.log('Auth check email called');
        
        try {
            const body = await request.json();
            const { email } = body;
            
            if (!email) {
                return {
                    status: 400,
                    jsonBody: { message: 'Email is required' }
                };
            }
            
            // Check if user already exists in our system (SQL Users table)
            const existingUser = await Storage.users.getByEmail(email);
            
            // Also check the allowed-emails list
            const isAllowed = await Storage.allowedEmails.isAllowed(email);
            
            if (existingUser) {
                // User exists → they should sign in, not register
                context.log(`Existing user found: ${email}`);
                return {
                    status: 200,
                    jsonBody: { 
                        allowed: true,
                        isNewUser: false,
                        message: 'Email verified, proceed with login' 
                    }
                };
            }
            
            if (isAllowed) {
                // In allowed list but no user record yet (e.g., invited but never logged in)
                context.log(`Allowed email, new user: ${email}`);
                return {
                    status: 200,
                    jsonBody: { 
                        allowed: true,
                        isNewUser: true,
                        message: 'New user, proceed with sign-up' 
                    }
                };
            }
            
            // Not in system at all → brand new, needs to register
            context.log(`Unknown email: ${email}`);
            return {
                status: 200,
                jsonBody: { 
                    allowed: false,
                    isNewUser: true,
                    message: 'New email, proceed with registration' 
                }
            };
            
        } catch (error) {
            await logError(context, error);
            context.error('Auth check email error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
