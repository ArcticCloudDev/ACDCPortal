// Register Initiate - Start registration, send verification code
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const Email = require('../shared/email');

app.http('register-initiate', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'register/initiate',
    handler: async (request, context) => {
        context.log('Register initiate called');
        
        try {
            const body = await request.json();
            const { firstName, lastName, email, phone, teamName, numberOfParticipants } = body;
            
            // Validate required fields
            if (!firstName || !lastName || !email || !phone || !teamName || !numberOfParticipants) {
                return {
                    status: 400,
                    jsonBody: { message: 'All fields are required' }
                };
            }
            
            // Validate email format
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return {
                    status: 400,
                    jsonBody: { message: 'Invalid email format' }
                };
            }
            
            // Validate number of participants
            const numParticipants = parseInt(numberOfParticipants);
            if (isNaN(numParticipants) || numParticipants < 1 || numParticipants > 5) {
                return {
                    status: 400,
                    jsonBody: { message: 'Number of participants must be between 1 and 5' }
                };
            }
            
            // Check if team name already exists
            const existingTeam = await Storage.teams.getByName(teamName);
            if (existingTeam) {
                return {
                    status: 400,
                    jsonBody: { message: 'A team with this name already exists' }
                };
            }
            
            // Check if email is already registered
            const existingUser = await Storage.users.getByEmail(email);
            if (existingUser) {
                return {
                    status: 400,
                    jsonBody: { message: 'This email is already registered' }
                };
            }
            
            // Generate verification code
            const verificationCode = Email.generateCode();
            
            // Create pending registration
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes
            
            const registration = {
                id: uuidv4(),
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: email.toLowerCase().trim(),
                phone: phone.trim(),
                teamName: teamName.trim(),
                numberOfParticipants: numParticipants,
                verificationCode: verificationCode,
                expiresAt: expiresAt.toISOString(),
                createdAt: now.toISOString()
            };
            
            await Storage.pendingRegistrations.create(registration);
            
            // Send verification code
            await Email.sendVerificationCode(email, verificationCode);
            
            context.log(`Registration initiated for ${email}`);
            
            return {
                status: 200,
                jsonBody: { 
                    message: 'Verification code sent to your email',
                    registrationId: registration.id,
                    email: email
                }
            };
            
        } catch (error) {
            context.error('Register initiate error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
