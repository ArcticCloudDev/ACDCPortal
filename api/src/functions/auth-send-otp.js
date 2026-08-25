const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const Storage = require('../shared/storage');
const { getPool } = require('../shared/sql');
const Email = require('../shared/email');

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
            const body = await request.json();
            const { email, captchaToken } = body;

            if (!email) {
                return {
                    status: 400,
                    jsonBody: { message: 'Email is required' }
                };
            }

            const normalizedEmail = email.toLowerCase().trim();
            const clientIp = request.headers.get('x-forwarded-for') ||
                             request.headers.get('x-client-ip') || 'unknown';

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
                context.warn(`Rate limit exceeded for email: ${normalizedEmail}`);
                return {
                    status: 429,
                    jsonBody: { message: 'Too many codes requested. Please wait before trying again.' }
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

            await Email.sendVerificationCode(normalizedEmail, otpCode);

            markSent(normalizedEmail);

            context.log(`OTP sent to ${normalizedEmail}`);
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

async function verifyCaptcha(token, context) {
    const secret = process.env.RECAPTCHA_SECRET_KEY;
    if (!secret) {
        const isLocal = (process.env.AZURE_FUNCTIONS_ENVIRONMENT === 'Development'
            || process.env.FUNCTIONS_WORKER_RUNTIME === 'node' && !process.env.WEBSITE_HOSTNAME);
        if (isLocal) {
            context.warn('RECAPTCHA_SECRET_KEY not configured - allowing in local dev');
            return true;
        }
        context.error('RECAPTCHA_SECRET_KEY not configured in production!');
        return false;
    }

    try {
        const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${secret}&response=${token}`
        });
        const data = await response.json();
        return data.success && (data.score || 1) >= 0.5;
    } catch (error) {
        await logError(context, error);
        context.error('reCAPTCHA verification error:', error);
        return false;
    }
}
