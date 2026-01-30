// Verify OTP API - Verify OTP code and create session
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');

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
            
            // Get the stored OTP
            const loginOtp = Storage.pendingRegistrations.getById(`login_${normalizedEmail}`);
            
            if (!loginOtp) {
                return {
                    status: 400,
                    jsonBody: { 
                        success: false,
                        message: 'No OTP found. Please request a new code.' 
                    }
                };
            }
            
            // Check if expired
            if (new Date(loginOtp.expiresAt) < new Date()) {
                Storage.pendingRegistrations.delete(loginOtp.id);
                return {
                    status: 400,
                    jsonBody: { 
                        success: false,
                        message: 'Code has expired. Please request a new one.' 
                    }
                };
            }
            
            // Verify the code
            if (loginOtp.verificationCode !== code) {
                return {
                    status: 400,
                    jsonBody: { 
                        success: false,
                        message: 'Invalid code. Please try again.' 
                    }
                };
            }
            
            // Code is valid! Get user data
            const user = Storage.users.getByEmail(normalizedEmail);
            
            if (!user) {
                return {
                    status: 404,
                    jsonBody: { 
                        success: false,
                        message: 'User not found' 
                    }
                };
            }
            
            // Clean up the OTP
            Storage.pendingRegistrations.delete(loginOtp.id);
            
            // Generate a simple session token (in production, use JWT)
            const sessionToken = uuidv4();
            
            context.log(`Login successful for ${normalizedEmail}`);
            return {
                status: 200,
                jsonBody: { 
                    success: true,
                    message: 'Login successful',
                    token: sessionToken,
                    user: {
                        id: user.id,
                        email: user.email,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        profileComplete: user.profileComplete,
                        isPortalAdmin: user.isPortalAdmin || false
                    }
                }
            };
            
        } catch (error) {
            context.error('Auth verify OTP error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
