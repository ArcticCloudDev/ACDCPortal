const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const Storage = require('../shared/storage');
const { checkRateLimit } = require('./auth-send-otp');
const { getClientIp } = require('../shared/auth');
const { isEmail, normalizeEmail } = require('../shared/validate');

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
            let body;
            try {
                body = await request.json();
            } catch {
                body = {};
            }
            const { email } = body || {};

            if (!email || !isEmail(email)) {
                return {
                    status: 400,
                    jsonBody: { message: 'A valid email is required' }
                };
            }

            const normalizedEmail = normalizeEmail(email);
            // Right-most X-Forwarded-For hop (appended by the SWA edge), never a client-chosen value.
            const clientIp = getClientIp(request);

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
                context.log('Existing user found');
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
                context.log('Allowed email, new user');
                return {
                    status: 200,
                    jsonBody: {
                        allowed: true,
                        isNewUser: true,
                        message: 'New user, proceed with sign-up'
                    }
                };
            }

            context.log('Unknown email');
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
