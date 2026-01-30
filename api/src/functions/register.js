// Register API - Two-phase registration with reCAPTCHA + Entra External ID
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const Graph = require('../shared/graph');

// Phase 1: Start registration - validate captcha, create Entra user
app.http('register-start', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'register/start',
    handler: async (request, context) => {
        context.log('Register start called');
        
        try {
            const body = await request.json();
            const { email, firstName, lastName, captchaToken } = body;
            
            // Validate required fields
            if (!email || !firstName || !lastName) {
                return {
                    status: 400,
                    jsonBody: { message: 'Email, first name, and last name are required' }
                };
            }
            
            // Validate reCAPTCHA
            if (!captchaToken) {
                return {
                    status: 400,
                    jsonBody: { message: 'reCAPTCHA verification required' }
                };
            }
            
            const captchaValid = await verifyCaptcha(captchaToken, context);
            if (!captchaValid) {
                return {
                    status: 400,
                    jsonBody: { message: 'reCAPTCHA verification failed. Please try again.' }
                };
            }
            
            // Check if email already registered in our system
            const existingUser = Storage.users.getByEmail(email);
            if (existingUser) {
                return {
                    status: 400,
                    jsonBody: { message: 'This email is already registered. Please login instead.' }
                };
            }
            
            // reCAPTCHA passed, email not registered - ready for sign-up
            // We don't create Entra user here - let the user flow handle it
            // This ensures pure Email OTP with no password
            
            context.log(`Registration validated for: ${email}`);
            return {
                status: 200,
                jsonBody: { 
                    success: true,
                    message: 'Validation passed. Proceed to sign-up.'
                }
            };
            
        } catch (error) {
            context.error('Register start error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

// Phase 2: Complete registration - save team data (called after MS OTP verified)
app.http('register-complete', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'register/complete',
    handler: async (request, context) => {
        context.log('Register complete called');
        
        try {
            const body = await request.json();
            const { email, firstName, lastName, phone, teamName, numberOfParticipants } = body;
            
            // Validate required fields
            if (!email || !firstName || !lastName || !phone || !teamName || !numberOfParticipants) {
                return {
                    status: 400,
                    jsonBody: { message: 'All fields are required' }
                };
            }
            
            // Check if already fully registered
            const existingUser = Storage.users.getByEmail(email);
            if (existingUser) {
                return {
                    status: 400,
                    jsonBody: { message: 'Registration already complete. Please login.' }
                };
            }
            
            // Create team and user
            const now = new Date().toISOString();
            const userId = uuidv4();
            const teamId = uuidv4();
            
            const user = {
                id: userId,
                email: email.toLowerCase().trim(),
                firstName: firstName,
                lastName: lastName,
                phone: phone,
                allergies: null,
                hotelWedThu: false,
                hotelThuSun: true,
                hotelSunMon: false,
                profileComplete: false,
                createdAt: now,
                updatedAt: now
            };
            
            const team = {
                id: teamId,
                teamName: teamName,
                numberOfParticipants: parseInt(numberOfParticipants),
                adminUserId: userId,
                createdAt: now,
                updatedAt: now
            };
            
            // Save to storage
            Storage.users.create(user);
            Storage.teams.create(team);
            Storage.allowedEmails.add(email, null);
            
            context.log(`Registration complete: ${email}, team: ${teamName}`);
            
            return {
                status: 200,
                jsonBody: { 
                    success: true,
                    message: 'Registration complete!',
                    userId: userId,
                    teamId: teamId
                }
            };
            
        } catch (error) {
            context.error('Register complete error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

// Helper: Verify reCAPTCHA token
async function verifyCaptcha(token, context) {
    const secret = process.env.RECAPTCHA_SECRET_KEY;
    
    if (!secret) {
        context.warn('RECAPTCHA_SECRET_KEY not set - skipping verification in dev mode');
        return true; // Allow in dev if not configured
    }
    
    try {
        const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${secret}&response=${token}`
        });
        
        const data = await response.json();
        context.log(`reCAPTCHA score: ${data.score}, success: ${data.success}`);
        
        // v3 returns a score (0.0-1.0), we require at least 0.5
        return data.success && (data.score === undefined || data.score >= 0.5);
    } catch (error) {
        context.error('reCAPTCHA verification error:', error);
        return false;
    }
}
