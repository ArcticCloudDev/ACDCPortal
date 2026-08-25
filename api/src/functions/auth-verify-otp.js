const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const jwt = require('jsonwebtoken');
const Storage = require('../shared/storage');
const Email = require('../shared/email');
const { getJwtSecret } = require('../shared/auth');

const JWT_EXPIRY = '8h';

const verifyRateLimits = new Map();
const VERIFY_IP_MAX = 20;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;

app.http('auth-verify-otp', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'auth/verify-otp',
    handler: async (request, context) => {
        context.log('Auth verify OTP called');

        try {
            const body = await request.json();
            const { email, code } = body;

            if (!email || !code) {
                return {
                    status: 400,
                    jsonBody: { message: 'Email and code are required' }
                };
            }

            const normalizedEmail = email.toLowerCase().trim();
            const clientIp = request.headers.get('x-forwarded-for') ||
                             request.headers.get('x-client-ip') || 'unknown';

            const now = Date.now();
            const ipEntry = verifyRateLimits.get(clientIp);
            if (ipEntry && now < ipEntry.resetAt && ipEntry.count >= VERIFY_IP_MAX) {
                context.warn(`Verify rate limit exceeded for IP: ${clientIp}`);
                return {
                    status: 429,
                    jsonBody: { message: 'Too many attempts. Please try again later.' }
                };
            }
            if (!ipEntry || now > ipEntry.resetAt) {
                verifyRateLimits.set(clientIp, { count: 1, resetAt: now + VERIFY_WINDOW_MS });
            } else {
                ipEntry.count++;
            }

            const otpRecord = await Storage.pendingRegistrations.getById(`otp_${normalizedEmail}`);

            if (!otpRecord) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'No verification code found. Please request a new one.'
                    }
                };
            }

            if (new Date(otpRecord.expiresAt) < new Date()) {
                await Storage.pendingRegistrations.delete(otpRecord.id);
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Code has expired. Please request a new one.'
                    }
                };
            }

            if (otpRecord.attempts >= (otpRecord.maxAttempts || 5)) {
                await Storage.pendingRegistrations.delete(otpRecord.id);
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Too many incorrect attempts. Please request a new code.'
                    }
                };
            }

            const isValid = Email.verifyCode(code, otpRecord.codeHash);

            if (!isValid) {
                otpRecord.attempts = (otpRecord.attempts || 0) + 1;
                await Storage.pendingRegistrations.create(otpRecord);

                const remaining = (otpRecord.maxAttempts || 5) - otpRecord.attempts;
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: `Invalid code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
                    }
                };
            }

            await Storage.pendingRegistrations.delete(otpRecord.id);

            const user = await Storage.users.getByEmail(normalizedEmail);

            const tokenPayload = {
                email: normalizedEmail,
                userId: user ? user.id : null,
                isPortalAdmin: user ? (user.isPortalAdmin || false) : false
            };

            const token = jwt.sign(tokenPayload, getJwtSecret(), {
                expiresIn: JWT_EXPIRY,
                issuer: 'acdc-portal'
            });

            context.log(`Login successful for ${normalizedEmail}`);
            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: 'Verification successful',
                    token: token,
                    user: user ? {
                        id: user.id,
                        email: user.email,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        name: `${user.firstName} ${user.lastName}`,
                        profileComplete: user.profileComplete || false,
                        isPortalAdmin: user.isPortalAdmin || false
                    } : null
                }
            };

        } catch (error) {
            await logError(context, error);
            context.error('Auth verify OTP error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

