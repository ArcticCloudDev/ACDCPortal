// Register Verify - Verify code, create team and user
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');

app.http('register-verify', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'register/verify',
    handler: async (request, context) => {
        context.log('Register verify called');
        
        try {
            const body = await request.json();
            const { registrationId, email, verificationCode } = body;
            
            // Validate required fields
            if (!registrationId || !email || !verificationCode) {
                return {
                    status: 400,
                    jsonBody: { message: 'Registration ID, email, and verification code are required' }
                };
            }
            
            // Get pending registration
            const registration = await Storage.pendingRegistrations.getById(registrationId);
            
            if (!registration) {
                return {
                    status: 400,
                    jsonBody: { message: 'Registration not found or expired. Please try again.' }
                };
            }
            
            // Check if expired
            if (new Date(registration.expiresAt) < new Date()) {
                await Storage.pendingRegistrations.delete(registrationId);
                return {
                    status: 400,
                    jsonBody: { message: 'Verification code has expired. Please register again.' }
                };
            }
            
            // Verify email matches
            if (registration.email.toLowerCase() !== email.toLowerCase()) {
                return {
                    status: 400,
                    jsonBody: { message: 'Email does not match registration' }
                };
            }
            
            // Verify code
            if (registration.verificationCode !== verificationCode) {
                return {
                    status: 400,
                    jsonBody: { message: 'Invalid verification code' }
                };
            }
            
            // All verified! Create team and user
            const now = new Date().toISOString();
            const userId = uuidv4();
            const teamId = uuidv4();
            
            // Create user first
            const user = {
                id: userId,
                email: registration.email,
                firstName: registration.firstName,
                lastName: registration.lastName,
                phone: registration.phone,
                allergies: null,
                hotelWedThu: false,
                hotelThuSun: true, // Default
                hotelSunMon: false,
                profileComplete: false,
                createdAt: now,
                updatedAt: now
            };
            
            // Create team
            const team = {
                id: teamId,
                teamName: registration.teamName,
                numberOfParticipants: registration.numberOfParticipants,
                adminUserId: userId,
                createdAt: now,
                updatedAt: now
            };
            
            // Save to storage
            await Storage.users.create(user);
            await Storage.teams.create(team);
            
            // Add email to allowed list
            await Storage.allowedEmails.add(registration.email, null);
            
            // Delete pending registration
            await Storage.pendingRegistrations.delete(registrationId);
            
            context.log(`Registration complete for ${registration.email}, team: ${team.teamName}`);
            
            return {
                status: 200,
                jsonBody: { 
                    message: 'Registration successful! You can now log in.',
                    teamId: teamId,
                    userId: userId
                }
            };
            
        } catch (error) {
            await logError(context, error);
            context.error('Register verify error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
