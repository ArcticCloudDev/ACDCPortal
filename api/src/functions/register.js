const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { v4: uuidv4 } = require('uuid');
const Storage = require('../shared/storage');
const { sendWelcomeEmail } = require('../shared/welcome-email');
const { requireAuth } = require('../shared/auth');
const { verifyCaptcha } = require('../shared/captcha');
const { sendSequenceDigest } = require('../shared/sequence-digest');
const ParticipationsStore = new (Storage.Storage)('participations');

app.http('register-start', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'register/start',
    handler: async (request, context) => {
        context.log('Register start called');

        try {
            const body = await request.json();
            const { email, firstName, lastName, phone, teamName, numberOfParticipants, willParticipate, captchaToken, registrationType, eventId } = body;

            if (!email || !firstName || !lastName) {
                return {
                    status: 400,
                    jsonBody: { message: 'Name and email are required' }
                };
            }

            if (registrationType !== 'interest' && !phone) {
                return {
                    status: 400,
                    jsonBody: { message: 'Phone is required' }
                };
            }

            const isTeamRegistration = registrationType === 'team';
            if (isTeamRegistration && (!teamName || !numberOfParticipants)) {
                return {
                    status: 400,
                    jsonBody: { message: 'Team name and number of participants are required for team registration' }
                };
            }

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

            const existingUser = await Storage.users.getByEmail(email);
            if (existingUser) {
                return {
                    status: 400,
                    jsonBody: { message: 'This email is already registered. Please login instead.' }
                };
            }

            const pendingId = uuidv4();
            const pendingData = {
                id: pendingId,
                email: email.toLowerCase().trim(),
                firstName,
                lastName,
                phone: phone || null,
                type: isTeamRegistration ? 'team' : (registrationType === 'interest' ? 'interest' : 'profile'),
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
            };

            if (isTeamRegistration) {
                pendingData.teamName = teamName;
                pendingData.numberOfParticipants = parseInt(numberOfParticipants);
                pendingData.willParticipate = willParticipate !== false;
                pendingData.eventId = eventId || null;
            }

            await Storage.pendingRegistrations.create(pendingData);

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

async function triggerSequenceEmailsForNewUser(userId, userEmail, firstName, eventId, context) {
    return sendSequenceDigest({ eventId, email: userEmail, firstName, userId }, context);
}

app.http('register-complete', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'register/complete',
    handler: async (request, context) => {
        context.log('Register complete called');

        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { email } = body;

            if (!email) {
                return {
                    status: 400,
                    jsonBody: { message: 'Email is required' }
                };
            }

            const normalizedEmail = email.toLowerCase().trim();
            if (auth.user.email?.toLowerCase() !== normalizedEmail) {
                return {
                    status: 403,
                    jsonBody: { message: 'Authenticated email does not match registration' }
                };
            }

            const existingUser = await Storage.users.getByEmail(normalizedEmail);
            if (existingUser) {
                return {
                    status: 200,
                    jsonBody: {
                        success: true,
                        message: 'Registration already complete.',
                        userId: existingUser.id
                    }
                };
            }

            const pending = await Storage.pendingRegistrations.getByEmail(normalizedEmail);
            if (!pending) {
                return {
                    status: 400,
                    jsonBody: { message: 'No pending registration found for this email. Please start again.' }
                };
            }

            if (new Date(pending.expiresAt) < new Date()) {
                await Storage.pendingRegistrations.delete(pending.id);
                return {
                    status: 400,
                    jsonBody: { message: 'Registration expired. Please start again.' }
                };
            }

            const { firstName, lastName, phone, teamName, numberOfParticipants, willParticipate, type: registrationType, eventId: pendingEventId } = pending;
            const isTeamRegistration = registrationType === 'team';
            const isParticipant = isTeamRegistration ? (willParticipate !== false) : false;

            const now = new Date().toISOString();
            const userId = uuidv4();

            const user = {
                id: userId,
                email: normalizedEmail,
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
            await Storage.allowedEmails.add(normalizedEmail, null);

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

            let resolvedEventId = pendingEventId;
            if (!resolvedEventId) {
                const events = await Storage.events.getAll();
                const activeEvent = events.find(e => e.registrationOpen || e.status === 'registration');
                if (activeEvent) resolvedEventId = activeEvent.id;
            }

            if (resolvedEventId) {
                const roles = isParticipant ? ['participant'] : [];

                let defaultHotelNights = {};
                try {
                    const resolvedEvent = await Storage.events.getById(resolvedEventId);
                    if (resolvedEvent?.hotelEnabled && resolvedEvent.hotelDefaultNights?.length) {
                        for (const night of resolvedEvent.hotelDefaultNights) {
                            defaultHotelNights[night] = true;
                        }
                    }
                } catch (e) {
                    context.log(`Could not load event for hotel defaults: ${e.message}`);
                }

                const participation = {
                    id: uuidv4(),
                    userId: userId,
                    email: normalizedEmail,
                    eventId: resolvedEventId,
                    roles: roles,
                    teamId: teamId,
                    isTeamAdmin: !!teamId,
                    hotelNights: defaultHotelNights,
                    hotelPaidBy: null,
                    createdAt: now,
                    updatedAt: now
                };
                await ParticipationsStore.create(participation);
                context.log(`Participation created for ${email} in event ${resolvedEventId}`);
            }

            await Storage.pendingRegistrations.delete(pending.id);

            if (resolvedEventId) {
                triggerSequenceEmailsForNewUser(userId, email, firstName, resolvedEventId, context)
                    .catch(err => context.error(`Failed to trigger sequence emails for ${email}:`, err));
            }

            if (resolvedEventId) {
                sendWelcomeEmail(email, resolvedEventId, context)
                    .then(result => { if (result?.success) context.log(`Welcome email sent to ${email}`); })
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

