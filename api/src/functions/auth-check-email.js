const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const Storage = require('../shared/storage');
const { checkRateLimit } = require('./auth-send-otp');

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

            const existingUser = await Storage.users.getByEmail(normalizedEmail);

            const isAllowed = await Storage.allowedEmails.isAllowed(normalizedEmail);

            if (existingUser) {
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
