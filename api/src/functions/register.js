const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { generateId } = require('../shared/id');
const Storage = require('../shared/storage');
const { withTransaction } = require('../shared/storage');
const { sendWelcomeEmail } = require('../shared/welcome-email');
const { requireAuth } = require('../shared/auth');
const { issueSession } = require('../shared/auth');
const { verifyCaptcha } = require('../shared/captcha');
const { sendSequenceDigest } = require('../shared/sequence-digest');
const { Validator, readJson, INVALID_JSON } = require('../shared/validate');
const ParticipationsStore = new (Storage.Storage)('participations');

function isOpenForRegistration(event) {
    return !!event && (event.registrationOpen === true || event.status === 'registration');
}

function teamSizeBounds(event) {
    const min = Number.isInteger(event?.minTeamSize) && event.minTeamSize > 0 ? event.minTeamSize : 1;
    const max = Number.isInteger(event?.maxTeamSize) && event.maxTeamSize >= min ? event.maxTeamSize : Math.max(min, 5);
    return { min, max };
}

// Deterministic default: the open event that starts first (ties broken by id).
async function getDefaultOpenEvent() {
    const events = (await Storage.events.getAll()).filter(isOpenForRegistration);
    events.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || String(a.id).localeCompare(String(b.id)));
    return events.length > 0 ? events[0] : null;
}

app.http('register-start', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'register/start',
    handler: async (request, context) => {
        context.log('Register start called');

        try {
            const body = await readJson(request);
            if (!body) return INVALID_JSON;

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

            const v = new Validator();
            const normalizedEmail = v.email(email, 'email');
            const cleanFirstName = v.string(firstName, 'firstName', { min: 1, max: 100, required: true });
            const cleanLastName = v.string(lastName, 'lastName', { min: 1, max: 100, required: true });
            const cleanPhone = v.string(phone, 'phone', { max: 50 });
            const cleanEventId = v.guid(eventId, 'eventId');
            const cleanTeamName = isTeamRegistration ? v.string(teamName, 'teamName', { min: 2, max: 100, required: true }) : undefined;
            if (isTeamRegistration && !cleanEventId) v.errors.push('eventId is required for team registration');
            if (v.failed) return v.failure();

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

            const existingUser = await Storage.users.getByEmail(normalizedEmail);
            if (existingUser) {
                return {
                    status: 400,
                    jsonBody: { message: 'This email is already registered. Please login instead.' }
                };
            }

            let teamSize = null;
            if (cleanEventId) {
                const event = await Storage.events.getById(cleanEventId);
                if (!event) {
                    return { status: 404, jsonBody: { message: 'Event not found' } };
                }
                if (isTeamRegistration) {
                    if (!isOpenForRegistration(event)) {
                        return { status: 400, jsonBody: { message: 'This event is not open for team registration' } };
                    }
                    const { min, max } = teamSizeBounds(event);
                    teamSize = v.integer(numberOfParticipants, 'numberOfParticipants', { min, max, required: true });
                    if (v.failed) return v.failure();
                    if (await Storage.teams.getByNameInEvent(cleanTeamName, cleanEventId)) {
                        return { status: 409, jsonBody: { message: 'A team with that name already exists for this event' } };
                    }
                }
            }

            const pendingId = generateId();
            const pendingData = {
                id: pendingId,
                email: normalizedEmail,
                firstName: cleanFirstName,
                lastName: cleanLastName,
                phone: cleanPhone || null,
                type: isTeamRegistration ? 'team' : (registrationType === 'interest' ? 'interest' : 'profile'),
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
            };

            if (isTeamRegistration) {
                pendingData.teamName = cleanTeamName;
                pendingData.numberOfParticipants = teamSize;
                pendingData.willParticipate = willParticipate !== false;
                pendingData.eventId = cleanEventId;
            }

            await Storage.pendingRegistrations.create(pendingData);

            if (!(await Storage.allowedEmails.isAllowed(normalizedEmail))) {
                await Storage.allowedEmails.add(normalizedEmail, null);
            }

            context.log(`Registration started, pendingId: ${pendingId}`);
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
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = (await readJson(request)) || {};
            const { email } = body;

            if (!email || typeof email !== 'string') {
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
                // The caller's token may predate the account (userId: null); hand back a current one.
                return {
                    status: 200,
                    jsonBody: {
                        success: true,
                        message: 'Registration already complete.',
                        userId: existingUser.id,
                        ...issueSession(existingUser)
                    }
                };
            }

            const pending = await Storage.pendingRegistrations.getRegistrationByEmail(normalizedEmail);
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

            // Team registrations are bound to their event; others join the open event that starts first.
            let resolvedEvent = null;
            if (pendingEventId) {
                resolvedEvent = await Storage.events.getById(pendingEventId);
                if (!resolvedEvent && isTeamRegistration) {
                    return { status: 400, jsonBody: { message: 'The event for this registration no longer exists. Please start again.' } };
                }
            }
            if (!resolvedEvent) resolvedEvent = await getDefaultOpenEvent();
            const resolvedEventId = resolvedEvent ? resolvedEvent.id : null;

            let teamSize = null;
            if (isTeamRegistration) {
                if (!resolvedEventId) {
                    return { status: 400, jsonBody: { message: 'No event is open for team registration' } };
                }
                const v = new Validator();
                const { min, max } = teamSizeBounds(resolvedEvent);
                teamSize = v.integer(numberOfParticipants, 'numberOfParticipants', { min, max, required: true });
                if (v.failed) return v.failure();
                if (await Storage.teams.getByNameInEvent(teamName, resolvedEventId)) {
                    return { status: 409, jsonBody: { message: 'A team with that name already exists for this event' } };
                }
            }

            const now = new Date().toISOString();
            const userId = generateId();

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

            const defaultHotelNights = {};
            if (resolvedEvent?.hotelEnabled && resolvedEvent.hotelDefaultNights?.length) {
                for (const night of resolvedEvent.hotelDefaultNights) {
                    defaultHotelNights[night] = true;
                }
            }

            // User, team and participation are created together or not at all.
            const teamId = await withTransaction(async () => {
                await Storage.users.create(user);
                await Storage.allowedEmails.add(normalizedEmail, null);

                let createdTeamId = null;
                if (isTeamRegistration && teamName) {
                    createdTeamId = generateId();
                    await Storage.teams.create({
                        id: createdTeamId,
                        teamName: String(teamName).trim(),
                        eventId: resolvedEventId,
                        numberOfParticipants: teamSize,
                        adminUserId: userId,
                        createdAt: now,
                        updatedAt: now
                    });
                }

                if (resolvedEventId) {
                    await ParticipationsStore.create({
                        id: generateId(),
                        userId: userId,
                        email: normalizedEmail,
                        eventId: resolvedEventId,
                        roles: isParticipant ? ['participant'] : [],
                        teamId: createdTeamId,
                        isTeamAdmin: !!createdTeamId,
                        hotelNights: defaultHotelNights,
                        hotelPaidBy: null,
                        createdAt: now,
                        updatedAt: now
                    });
                }

                await Storage.pendingRegistrations.delete(pending.id);
                return createdTeamId;
            });

            context.log(`Registration complete for user ${userId} (${isTeamRegistration ? 'team' : 'profile'}, event ${resolvedEventId || 'none'})`);

            if (resolvedEventId) {
                triggerSequenceEmailsForNewUser(userId, normalizedEmail, firstName, resolvedEventId, context)
                    .catch(err => context.error('Failed to trigger sequence emails:', err));

                sendWelcomeEmail(normalizedEmail, resolvedEventId, context)
                    .then(result => { if (result?.success) context.log(`Welcome email sent to user ${userId}`); })
                    .catch(err => context.error('Failed to send welcome email:', err));
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
                    eventId: resolvedEventId || null,
                    ...issueSession(user)
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
