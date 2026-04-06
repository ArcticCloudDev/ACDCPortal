// Register API - Two-phase registration with reCAPTCHA + Custom OTP
// Phase 1: Validate captcha → Store pending data
// Phase 2: After OTP verification, complete registration (save team/user to JSON)
// Azure Functions v4 Programming Model
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const { sendTeamWelcomeEmail } = require('../shared/team-welcome');
const ParticipationsStore = new (Storage.Storage)('participations');

// Phase 1: Start registration - validate captcha, store pending data
app.http('register-start', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'register/start',
    handler: async (request, context) => {
        context.log('Register start called');
        
        try {
            const body = await request.json();
            const { email, firstName, lastName, phone, teamName, numberOfParticipants, willParticipate, captchaToken, registrationType, eventId } = body;
            
            // Validate required fields (personal info always required)
            if (!email || !firstName || !lastName) {
                return {
                    status: 400,
                    jsonBody: { message: 'Name and email are required' }
                };
            }

            // Phone required for non-interest registrations
            if (registrationType !== 'interest' && !phone) {
                return {
                    status: 400,
                    jsonBody: { message: 'Phone is required' }
                };
            }
            
            // Team fields required only for team registration
            const isTeamRegistration = registrationType === 'team';
            if (isTeamRegistration && (!teamName || !numberOfParticipants)) {
                return {
                    status: 400,
                    jsonBody: { message: 'Team name and number of participants are required for team registration' }
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
            const existingUser = await Storage.users.getByEmail(email);
            if (existingUser) {
                return {
                    status: 400,
                    jsonBody: { message: 'This email is already registered. Please login instead.' }
                };
            }
            
            // Store pending registration data server-side
            const pendingId = uuidv4();
            const pendingData = {
                id: pendingId,
                email: email.toLowerCase().trim(),
                firstName,
                lastName,
                phone: phone || null,
                registrationType: isTeamRegistration ? 'team' : 'profile',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 min expiry
            };
            
            // Include team fields only for team registration
            if (isTeamRegistration) {
                pendingData.teamName = teamName;
                pendingData.numberOfParticipants = parseInt(numberOfParticipants);
                pendingData.willParticipate = willParticipate !== false;
                pendingData.eventId = eventId || null;
            }
            
            await Storage.pendingRegistrations.create(pendingData);
            
            // Temporarily add email to allowed-emails so auth-send-otp will accept it
            if (!(await Storage.allowedEmails.isAllowed(email))) {
                await Storage.allowedEmails.add(email.toLowerCase().trim(), null);
                context.log(`Temporarily added ${email} to allowed-emails for OTP`);
            }
            
            context.log(`Registration started for: ${email}, pendingId: ${pendingId}`);
            return {
                status: 200,
                jsonBody: { 
                    success: true,
                    pendingId: pendingId,
                    message: 'Account prepared. Proceed to email verification.'
                }
            };
            
        } catch (error) {
            await logError(context, error);
            context.error('Register start error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});

// Phase 2: Complete registration - retrieve pending data and save team/user
// Called after the user verifies their OTP code
app.http('register-complete', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'register/complete',
    handler: async (request, context) => {
        context.log('Register complete called');
        
        try {
            const body = await request.json();
            const { email } = body;
            
            if (!email) {
                return {
                    status: 400,
                    jsonBody: { message: 'Email is required' }
                };
            }
            
            // Check if already fully registered
            const existingUser = await Storage.users.getByEmail(email);
            if (existingUser) {
                // Already done — could be a double-submit. Just return success.
                return {
                    status: 200,
                    jsonBody: { 
                        success: true,
                        message: 'Registration already complete.',
                        userId: existingUser.id
                    }
                };
            }
            
            // Retrieve pending registration data from server storage
            const pending = await Storage.pendingRegistrations.getByEmail(email);
            if (!pending) {
                return {
                    status: 400,
                    jsonBody: { message: 'No pending registration found for this email. Please start again.' }
                };
            }
            
            // Check expiry
            if (new Date(pending.expiresAt) < new Date()) {
                await Storage.pendingRegistrations.delete(pending.id);
                return {
                    status: 400,
                    jsonBody: { message: 'Registration expired. Please start again.' }
                };
            }
            
            const { firstName, lastName, phone, teamName, numberOfParticipants, willParticipate, registrationType, eventId: pendingEventId } = pending;
            const isTeamRegistration = registrationType === 'team';
            const isParticipant = isTeamRegistration ? (willParticipate !== false) : false;
            
            // Create user
            const now = new Date().toISOString();
            const userId = uuidv4();
            
            const user = {
                id: userId,
                email: email.toLowerCase().trim(),
                firstName,
                lastName,
                phone: phone || null,
                profileComplete: !!(firstName && lastName && phone),
                createdAt: now,
                updatedAt: now,
                gamertag: '',
                allergies: ''
            };
            
            await Storage.users.create(user);
            await Storage.allowedEmails.add(email, null);
            
            // Create team only for team registrations
            let teamId = null;
            if (isTeamRegistration && teamName) {
                teamId = uuidv4();
                const team = {
                    id: teamId,
                    teamName: teamName,
                    eventId: pendingEventId || null,
                    numberOfParticipants: parseInt(numberOfParticipants),
                    adminUserId: userId,
                    createdAt: now,
                    updatedAt: now
                };
                await Storage.teams.create(team);
                context.log(`Registration complete: ${email}, team: ${teamName}, isParticipant: ${isParticipant}`);
            } else {
                context.log(`Profile registration complete: ${email} (no team)`);
            }
            
            // Create participation record linking user to event
            let resolvedEventId = pendingEventId;
            if (!resolvedEventId) {
                // Fallback: find the active event with registration open
                const events = await Storage.events.getAll();
                const activeEvent = events.find(e => e.registrationOpen || e.status === 'registration');
                if (activeEvent) resolvedEventId = activeEvent.id;
            }
            
            if (resolvedEventId) {
                const roles = isParticipant ? ['participant'] : [];
                const teamMemberships = teamId ? [{
                    teamId: teamId,
                    isAdmin: true,
                    isParticipant: isParticipant,
                    joinedAt: now
                }] : [];
                const participation = {
                    id: uuidv4(),
                    userId: userId,
                    email: email.toLowerCase().trim(),
                    eventId: resolvedEventId,
                    roles: roles,
                    teamId: teamId,
                    isTeamAdmin: !!teamId,
                    hotelNights: {},
                    hotelPaidBy: null,
                    teamMemberships: teamMemberships,
                    createdAt: now,
                    updatedAt: now
                };
                const participations = await ParticipationsStore.getAll();
                participations.push(participation);
                await ParticipationsStore.saveAll(participations);
                context.log(`Participation created for ${email} in event ${resolvedEventId}`);
            }
            
            // Clean up pending registration
            await Storage.pendingRegistrations.delete(pending.id);

            // Send welcome email for profile/solo registrations (team registrations get their own email via teams.js)
            if (!isTeamRegistration && resolvedEventId) {
                sendTeamWelcomeEmail(email, resolvedEventId, context)
                    .then(result => {
                        if (result?.success) context.log(`Welcome email sent to ${email}`);
                    })
                    .catch(err => context.error(`Failed to send welcome email to ${email}:`, err));
            }
            
            return {
                status: 200,
                jsonBody: { 
                    success: true,
                    registrationType: isTeamRegistration ? 'team' : 'profile',
                    message: isTeamRegistration
                        ? (isParticipant ? 'Registration complete!' : 'Registration complete! You are registered as team admin only.')
                        : 'Account created successfully!',
                    userId: userId,
                    teamId: teamId,
                    isParticipant: isParticipant,
                    eventId: resolvedEventId || null
                }
            };
            
        } catch (error) {
            await logError(context, error);
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
        // Fail-closed: only skip in local dev (localhost), reject in production
        const isLocal = (process.env.AZURE_FUNCTIONS_ENVIRONMENT === 'Development' 
            || process.env.FUNCTIONS_WORKER_RUNTIME === 'node' && !process.env.WEBSITE_HOSTNAME);
        if (isLocal) {
            context.warn('RECAPTCHA_SECRET_KEY not set - allowing in local dev');
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
        context.log(`reCAPTCHA score: ${data.score}, success: ${data.success}`);
        
        // v3 returns a score (0.0-1.0), we require at least 0.5
        return data.success && (data.score === undefined || data.score >= 0.5);
    } catch (error) {
        await logError(context, error);
        context.error('reCAPTCHA verification error:', error);
        return false;
    }
}
