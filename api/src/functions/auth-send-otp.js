// Login OTP API - Send OTP code for login
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const Storage = require('../shared/storage');
const Email = require('../shared/email');

app.http('auth-send-otp', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'auth/send-otp',
    handler: async (request, context) => {
        context.log('Auth send OTP called');
        
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
            
            // Check if email is in allowed list
            const isAllowed = Storage.allowedEmails.isAllowed(normalizedEmail);
            
            if (!isAllowed) {
                context.log(`Login attempt for unregistered email: ${normalizedEmail}`);
                return {
                    status: 401,
                    jsonBody: { 
                        success: false,
                        message: 'Invalid login - email not registered' 
                    }
                };
            }
            
            // Generate OTP code
            const otpCode = Email.generateCode();
            
            // Store OTP in pending registrations (reusing the structure)
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes
            
            // Store login OTP separately from registration
            const loginOtp = {
                id: `login_${normalizedEmail}`,
                email: normalizedEmail,
                verificationCode: otpCode,
                type: 'login',
                expiresAt: expiresAt.toISOString(),
                createdAt: now.toISOString()
            };
            
            Storage.pendingRegistrations.create(loginOtp);
            
            // Send OTP via email
            await Email.sendVerificationCode(normalizedEmail, otpCode);
            
            context.log(`Login OTP sent to ${normalizedEmail}`);
            return {
                status: 200,
                jsonBody: { 
                    success: true,
                    message: 'One-time password sent to your email'
                }
            };
            
        } catch (error) {
            context.error('Auth send OTP error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
