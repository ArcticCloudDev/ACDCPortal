// Auth Check Email - Check if email is in allowed list (for login)
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
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
            
            // Check if email is in allowed list
            const isAllowed = Storage.allowedEmails.isAllowed(email);
            
            if (!isAllowed) {
                context.log(`Login attempt for unregistered email: ${email}`);
                return {
                    status: 401,
                    jsonBody: { 
                        allowed: false,
                        message: 'Invalid login - email not registered' 
                    }
                };
            }
            
            // Check if user already exists in our system (has logged in before)
            const existingUser = Storage.users.getByEmail(email);
            const isNewUser = !existingUser;
            
            context.log(`Email verified for login: ${email}, isNewUser: ${isNewUser}`);
            return {
                status: 200,
                jsonBody: { 
                    allowed: true,
                    isNewUser: isNewUser,
                    message: isNewUser ? 'New user, proceed with sign-up' : 'Email verified, proceed with login' 
                }
            };
            
        } catch (error) {
            context.error('Auth check email error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
