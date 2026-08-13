// Verify OTP API - Verify code and issue JWT session token
// Security: timing-safe comparison, attempt limiting, hashed codes, single-use
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const jwt = require('jsonwebtoken');
const Storage = require('../shared/storage');
const Email = require('../shared/email');
const { getJwtSecret } = require('../shared/auth');

// JWT configuration
// NOTE: JWT_SECRET is intentionally NOT cached as a module-level constant here —
// see the comment on getJwtSecret() in shared/auth.js for why that caused
// intermittent 401s across scaled-out Function App instances.
// Keep the lifetime short to reduce impact if a token is stolen or exposed.
const JWT_EXPIRY = '8h';

// In-memory rate limiter for verify attempts by IP
const verifyRateLimits = new Map(); // ip → { count, resetAt }
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
            
            // Rate limit by IP
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
            
            // Get the stored OTP record
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
            
            // Check if expired
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
            
            // Check attempt limit (5 wrong tries invalidates the code)
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
            
            // Timing-safe code verification
            const isValid = Email.verifyCode(code, otpRecord.codeHash);
            
            if (!isValid) {
                // Increment attempt counter
                otpRecord.attempts = (otpRecord.attempts || 0) + 1;
                await Storage.pendingRegistrations.create(otpRecord); // Update in place
                
                const remaining = (otpRecord.maxAttempts || 5) - otpRecord.attempts;
                return {
                    status: 400,
                    jsonBody: { 
                        success: false,
                        message: `Invalid code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` 
                    }
                };
            }
            
            // Code is valid! Single-use: delete immediately
            await Storage.pendingRegistrations.delete(otpRecord.id);
            
            // Get user data (may not exist yet if this is registration OTP)
            const user = await Storage.users.getByEmail(normalizedEmail);
            
            // Build JWT payload
            const tokenPayload = {
                email: normalizedEmail,
                userId: user ? user.id : null,
                isPortalAdmin: user ? (user.isPortalAdmin || false) : false
            };
            
            // Sign JWT
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

