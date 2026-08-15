// Auth Check Email - Check if email exists in the system (for register/login routing)
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const Storage = require('../shared/storage');
const { checkRateLimit } = require('./auth-send-otp');

// Email routing checks are not OTP deliveries. Keep their counters separate so
// a normal check → send → retry journey does not exhaust the OTP send quota.
const checkRateLimits = {
    byEmail: new Map(),
    byIp: new Map()
};

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

            const normalizedEmail = email.toLowerCase().trim();
            const clientIp = request.headers.get('x-forwarded-for') ||
                request.headers.get('x-client-ip') || 'unknown';

            const ipCheck = checkRateLimit(checkRateLimits.byIp, clientIp, 20);
            if (!ipCheck.allowed) {
                return {
                    status: 429,
                    jsonBody: { message: 'Too many requests. Please try again later.' }
                };
            }

            const emailCheck = checkRateLimit(checkRateLimits.byEmail, normalizedEmail, 20);
            if (!emailCheck.allowed) {
                return {
                    status: 429,
                    jsonBody: { message: 'Too many requests. Please try again later.' }
                };
            }
            
            // Check if user already exists in our system (SQL Users table)
            const existingUser = await Storage.users.getByEmail(normalizedEmail);
            
            // Also check the allowed-emails list
            const isAllowed = await Storage.allowedEmails.isAllowed(normalizedEmail);
            
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
