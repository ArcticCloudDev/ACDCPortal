const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const Storage = require('../shared/storage');
const { getPool } = require('../shared/sql');
const Email = require('../shared/email');
const { verifyCaptcha } = require('../shared/captcha');
const { getClientIp } = require('../shared/auth');
const { isEmail, normalizeEmail } = require('../shared/validate');

const rateLimits = {
    byEmail: new Map(),
    byIp: new Map()
};

const RATE_LIMITS = {
    EMAIL_MAX: 3,
    IP_MAX: 10,
    WINDOW_MS: 15 * 60 * 1000,
    COOLDOWN_MS: 60 * 1000
};

function checkCooldown(email) {
    const entry = rateLimits.byEmail.get(email);
    if (!entry || !entry.lastSentAt) return true;
    return (Date.now() - entry.lastSentAt) >= RATE_LIMITS.COOLDOWN_MS;
}

function checkRateLimit(map, key, max) {
    const now = Date.now();
    const entry = map.get(key);

    if (!entry || now > entry.resetAt) {
        map.set(key, { count: 1, resetAt: now + RATE_LIMITS.WINDOW_MS });
        return { allowed: true };
    }

    if (entry.count >= max) {
        return { allowed: false, retryAfterMs: entry.resetAt - now };
    }

    entry.count++;
    return { allowed: true };
}

module.exports = {
    rateLimits,
    RATE_LIMITS,
    checkCooldown,
    checkRateLimit,
    markSent
};

function markSent(email) {
    const entry = rateLimits.byEmail.get(email);
    if (entry) {
        entry.lastSentAt = Date.now();
    }
}

app.http('auth-send-otp', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'auth/send-otp',
    handler: async (request, context) => {
        context.log('Auth send OTP called');

        try {
            let body;
            try {
                body = await request.json();
            } catch {
                body = {};
            }
            const { email, captchaToken } = body || {};

            if (!email || !isEmail(email)) {
                return {
                    status: 400,
                    jsonBody: { message: 'A valid email is required' }
                };
            }

            const normalizedEmail = normalizeEmail(email);
            // Right-most X-Forwarded-For hop (appended by the SWA edge), never a client-chosen value.
            const clientIp = getClientIp(request);

            if (!checkCooldown(normalizedEmail)) {
                return {
                    status: 429,
                    jsonBody: { message: 'Please wait 60 seconds before requesting another code.' }
                };
            }

            const ipCheck = checkRateLimit(rateLimits.byIp, clientIp, RATE_LIMITS.IP_MAX);
            if (!ipCheck.allowed) {
                context.warn(`Rate limit exceeded for IP: ${clientIp}`);
                return {
                    status: 429,
                    jsonBody: { message: 'Too many requests. Please try again later.' }
                };
            }

            const emailCheck = checkRateLimit(rateLimits.byEmail, normalizedEmail, RATE_LIMITS.EMAIL_MAX);
            if (!emailCheck.allowed) {
                context.warn('Rate limit exceeded for an email address');
                return {
                    status: 429,
                    jsonBody: { message: 'Too many codes requested. Please wait before trying again.' }
                };
            }

            // The in-memory maps above are per Function instance; the OTP row itself gives a
            // cooldown that holds across instances (its CreatedAt is the last send time).
            const previousOtp = await Storage.pendingRegistrations.getById(`otp_${normalizedEmail}`);
            if (previousOtp?.createdAt && Date.now() - new Date(previousOtp.createdAt).getTime() < RATE_LIMITS.COOLDOWN_MS) {
                return {
                    status: 429,
                    jsonBody: { message: 'Please wait 60 seconds before requesting another code.' }
                };
            }

            if (captchaToken) {
                const captchaValid = await verifyCaptcha(captchaToken, context);
                if (!captchaValid) {
                    return {
                        status: 400,
                        jsonBody: { message: 'Security verification failed. Please try again.' }
                    };
                }
            }

            const user = await Storage.users.getByEmail(normalizedEmail);
            const isAllowed = await Storage.allowedEmails.isAllowed(normalizedEmail);

            let hasPendingInvitation = false;
            if (!user && !isAllowed) {
                const pool = await getPool();
                const inviteCheck = await pool.request()
                    .input('email', normalizedEmail)
                    .query(`SELECT TOP 1 Id FROM [Invitations] WHERE LOWER(Email) = @email AND Status = 'pending'`);
                hasPendingInvitation = inviteCheck.recordset.length > 0;
            }

            if (!user && !isAllowed && !hasPendingInvitation) {
                context.log(`OTP requested for unknown email: ${normalizedEmail} (not sending)`);
                return {
                    status: 200,
                    jsonBody: {
                        success: true,
                        message: 'If this email is registered, a verification code has been sent.'
                    }
                };
            }

            const otpCode = Email.generateCode();
            const otpHash = Email.hashCode(otpCode);

            const now = new Date();
            const otpRecord = {
                id: `otp_${normalizedEmail}`,
                email: normalizedEmail,
                codeHash: otpHash,
                attempts: 0,
                maxAttempts: 5,
                type: 'login',
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString()
            };

            await Storage.pendingRegistrations.create(otpRecord);

            try {
                await Email.sendVerificationCode(normalizedEmail, otpCode);
            } catch (mailError) {
                // Nothing reached the inbox: take the unusable code back and say so.
                await Storage.pendingRegistrations.delete(otpRecord.id).catch(() => {});
                await logError(context, mailError);
                return {
                    status: 502,
                    jsonBody: { message: 'Could not send the verification email. Please try again.' }
                };
            }

            markSent(normalizedEmail);

            context.log('OTP sent');
            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: 'If this email is registered, a verification code has been sent.'
                }
            };

        } catch (error) {
            await logError(context, error);
            context.error('Auth send OTP error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

