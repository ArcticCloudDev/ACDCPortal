const { app } = require('@azure/functions');
const { requireAuth, isTeamAuthorized, issueSession } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { sendEmail, processTemplate } = require('../shared/mail');
const { buildInvitationEmail } = require('../shared/invitation-email');
const { buildEmailHtml } = require('../shared/email-builder');
const Storage = require('../shared/storage');
const { withTransaction } = require('../shared/storage');
const { generateId, isGuid, sameId } = require('../shared/id');
const { Validator, readJson, INVALID_JSON } = require('../shared/validate');
const { sendSequenceDigest } = require('../shared/sequence-digest');

const InvitationsStore = new Storage.Storage('invitations');
const ParticipationsStore = new Storage.Storage('participations');
const UsersStore = new Storage.Storage('users');

const INVITATION_ROLES = ['participant', 'judge', 'committee'];
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const PROFILE_LIMITS = { firstName: 100, lastName: 100, phone: 50, gamertag: 100, allergies: 2000 };

const MAIL_FAILED = { status: 502, jsonBody: { error: 'The invitation email could not be sent. Please try again.', message: 'The invitation email could not be sent. Please try again.' } };

function isTeamInvitation(invitation) {
    return !!invitation.teamId && (!invitation.role || invitation.role === 'participant');
}

async function isInvitationAuthorized(user, invitation) {
    if (!user) return false;
    if (user.isPortalAdmin) return true;
    if (invitation.teamId) {
        const team = await Storage.teams.getById(invitation.teamId);
        if (!team) return false;
        const participations = await ParticipationsStore.findBy({ userId: user.userId });
        return isTeamAuthorized(user, team, participations);
    }
    return false;
}

async function triggerSequenceEmailsForInvite(userId, userEmail, eventId, context) {
    const user = await Storage.users.getById(userId);
    return sendSequenceDigest({
        eventId,
        email: user?.email || userEmail,
        firstName: user?.firstName || 'Participant',
        userId
    }, context);
}

async function buildTeamWelcomeEmailForInvitation(invitation, context) {
    try {
        const config = await Storage.readData('system-email-config.json');
        const template = config.templates['welcome'];

        if (!template) {
            return { success: false, reason: 'welcome template not configured' };
        }

        const event = invitation.eventId ? await Storage.events.getById(invitation.eventId) : null;
        const eventName = event ? event.name : 'the event';

        const eventTheme = invitation.eventId ? (template.eventThemes[invitation.eventId] || {}) : {};
        const globalDefaults = template.editableSections;

        const portalUrl = process.env.PORTAL_URL || 'https://your-portal.com';
        const acceptUrl = `${portalUrl}/accept-invitation.html?invite=${invitation.id}`;

        const inviteeName = [invitation.inviteeFirstName, invitation.inviteeLastName].filter(Boolean).join(' ');
        // User-supplied values (team name, names, message) are HTML-escaped by processTemplate.
        const mergeData = {
            teamName: invitation.teamName || 'the team',
            fullName: inviteeName || invitation.email.split('@')[0],
            firstName: invitation.inviteeFirstName || inviteeName || invitation.email.split('@')[0],
            eventName: eventName,
            teamAdminName: invitation.inviterName || 'Event Organizer',
            inviterName: invitation.inviterName || 'Event Organizer',
            message: invitation.message || '',
            portalUrl: acceptUrl,
            acceptUrl
        };

        const rawBody = eventTheme.body || globalDefaults.body || '';
        const rawClosing = eventTheme.closing || globalDefaults.closing || '';
        mergeData.bodyText = processTemplate(rawBody, mergeData);
        mergeData.closingText = processTemplate(rawClosing, mergeData);

        const htmlContent = buildEmailHtml(template, mergeData, eventTheme);
        const subject = processTemplate(eventTheme.subject || template.subject, mergeData, { html: false });

        return { success: true, htmlContent, subject };
    } catch (error) {
        await logError(context, error);
        context.error('Error building team welcome email for invitation:', error);
        return { success: false, reason: 'Could not build the invitation email' };
    }
}

// Renders the right email for the invitation; { success:false } when a template is missing.
async function buildInvitationMail(invitation, context, { reminder = false } = {}) {
    const result = (invitation.role === 'judge' || invitation.role === 'committee')
        ? await buildInvitationEmail(invitation, context)
        : await buildTeamWelcomeEmailForInvitation(invitation, context);
    if (!result.success) return result;
    return { success: true, htmlContent: result.htmlContent, subject: reminder ? `Reminder: ${result.subject}` : result.subject };
}

function validateProfile(v, profile) {
    if (profile === undefined || profile === null) return {};
    if (typeof profile !== 'object' || Array.isArray(profile)) {
        v.errors.push('profile must be an object');
        return {};
    }
    const clean = {};
    for (const [field, max] of Object.entries(PROFILE_LIMITS)) {
        if (profile[field] === undefined) continue;
        const value = v.string(profile[field], field, { max });
        if (value !== undefined) clean[field] = value;
    }
    return clean;
}

// Distinct people already counted against the team: members plus pending invitees.
async function teamOccupancy(teamId, excludeEmail) {
    const emails = new Set();
    for (const p of await ParticipationsStore.findBy({ teamId })) {
        if (p.email) emails.add(p.email.toLowerCase());
    }
    for (const inv of await InvitationsStore.findBy({ teamId, status: 'pending' })) {
        if (inv.email) emails.add(inv.email.toLowerCase());
    }
    if (excludeEmail) emails.delete(excludeEmail.toLowerCase());
    return emails.size;
}

app.http('invitations-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'invitations',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await readJson(request);
            if (!body) return INVALID_JSON;

            const inviterId = auth.user.userId;
            if (!body.email || !inviterId) {
                return { status: 400, jsonBody: { error: 'email and inviterId are required' } };
            }
            if (!body.teamId && !body.eventId) {
                return { status: 400, jsonBody: { error: 'teamId or eventId is required' } };
            }

            const v = new Validator();
            const email = v.email(body.email, 'email');
            const teamId = v.guid(body.teamId, 'teamId');
            const bodyEventId = v.guid(body.eventId, 'eventId');
            const role = v.oneOf(body.role, 'role', INVITATION_ROLES);
            const inviteeFirstName = v.string(body.inviteeFirstName, 'inviteeFirstName', { max: 100 });
            const inviteeLastName = v.string(body.inviteeLastName, 'inviteeLastName', { max: 100 });
            const inviteePhone = v.string(body.inviteePhone, 'inviteePhone', { max: 50 });
            const inviteeGamertag = v.string(body.inviteeGamertag, 'inviteeGamertag', { max: 100 });
            const inviteeAllergies = v.string(body.inviteeAllergies, 'inviteeAllergies', { max: 2000 });
            const message = v.string(body.message, 'message', { max: 2000 });
            const bodyInviterName = v.string(body.inviterName, 'inviterName', { max: 200 });
            if (v.failed) return v.failure();

            let team = null;
            if (teamId) {
                team = await Storage.teams.getById(teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }
                const participations = await ParticipationsStore.findBy({ userId: inviterId });
                if (!isTeamAuthorized(auth.user, team, participations)) {
                    return { status: 403, jsonBody: { error: 'You do not have permission to invite members to this team' } };
                }
                if (role && role !== 'participant') {
                    return { status: 400, jsonBody: { error: 'Team invitations are for participants' } };
                }
                if (bodyEventId && !sameId(team.eventId, bodyEventId)) {
                    return { status: 400, jsonBody: { error: 'Team does not belong to that event' } };
                }
            } else if (!auth.user.isPortalAdmin) {
                // No team to be authorized on: judge/committee/event-level invitations are admin-only.
                return { status: 403, jsonBody: { error: 'Only portal admins can send invitations without a team' } };
            }

            const resolvedEventId = team ? team.eventId : bodyEventId;
            const event = await Storage.events.getById(resolvedEventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            // The inviter's identity comes from the session, not the body.
            const inviter = await Storage.users.getById(inviterId);
            const inviterName = inviter
                ? (`${inviter.firstName || ''} ${inviter.lastName || ''}`.trim() || bodyInviterName || 'Event Organizer')
                : (bodyInviterName || 'Event Organizer');
            const inviterEmail = (auth.user.email || '').toLowerCase();

            const teamName = team ? (team.teamName || team.name) : null;
            const teamInvite = !!team && (!role || role === 'participant');

            let existingUser = null;
            let staleParticipations = [];
            if (teamInvite) {
                existingUser = await Storage.users.getByEmail(email);
                const matchingParticipations = await ParticipationsStore.findBy({ email, eventId: resolvedEventId });
                if (existingUser) {
                    for (const p of await ParticipationsStore.findBy({ userId: existingUser.id, eventId: resolvedEventId })) {
                        if (!matchingParticipations.some(m => sameId(m.id, p.id))) matchingParticipations.push(p);
                    }
                }
                const onTeam = matchingParticipations.filter(p => p.teamId || (p.teamMemberships || []).some(m => m.teamId));
                const belongsToAnotherTeam = onTeam.some(p =>
                    (p.teamId && !sameId(p.teamId, teamId))
                    || (p.teamMemberships || []).some(m => m.teamId && !sameId(m.teamId, teamId)));
                if (belongsToAnotherTeam) {
                    return { status: 400, jsonBody: { error: `${email} is already on a team` } };
                }
                const isConfirmedMemberOfTargetTeam = existingUser
                    && !existingUser.invitationPending
                    && onTeam.some(p => sameId(p.teamId, teamId) || (p.teamMemberships || []).some(m => sameId(m.teamId, teamId)));
                if (isConfirmedMemberOfTargetTeam) {
                    return { status: 400, jsonBody: { error: `${email} is already on this team` } };
                }
                if (!existingUser) staleParticipations = matchingParticipations;

                const maxTeamSize = Number.isInteger(event.maxTeamSize) && event.maxTeamSize > 0 ? event.maxTeamSize : 5;
                const occupied = await teamOccupancy(teamId, email);
                if (occupied >= maxTeamSize) {
                    return { status: 400, jsonBody: { error: `The team is full: ${maxTeamSize} members including pending invitations` } };
                }
            }

            const pendingForEmail = await InvitationsStore.findBy({ email, status: 'pending' });
            const existingInvite = pendingForEmail.find(i => {
                if (role && i.role === role && sameId(i.eventId, resolvedEventId)) return true;
                if (teamId && sameId(i.teamId, teamId)) return true;
                return false;
            });
            if (existingInvite) {
                return {
                    status: 409,
                    jsonBody: {
                        error: `An invitation is already pending for ${email}`,
                        existingInvitationId: existingInvite.id,
                        canResend: true
                    }
                };
            }

            const invitation = {
                id: generateId(),
                email,
                inviteeFirstName: inviteeFirstName || null,
                inviteeLastName: inviteeLastName || null,
                inviteePhone: inviteePhone || null,
                inviteeGamertag: inviteeGamertag || null,
                inviteeAllergies: inviteeAllergies || null,
                teamId: teamId || null,
                teamName: teamName,
                eventId: resolvedEventId,
                role: role || null,
                inviterId,
                inviterName,
                inviterEmail,
                message: message || 'Join our team for the Arctic Cloud Developer Challenge!',
                status: 'pending',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + INVITATION_TTL_MS).toISOString()
            };

            await withTransaction(async () => {
                if (teamInvite) {
                    const now = new Date().toISOString();

                    // A pending contact without an account left behind by an earlier invitation.
                    for (const participation of staleParticipations) {
                        await ParticipationsStore.delete(participation.id);
                    }

                    let contact = existingUser;
                    if (!contact) {
                        contact = await UsersStore.create({
                            id: generateId(),
                            email: invitation.email,
                            firstName: invitation.inviteeFirstName || '',
                            lastName: invitation.inviteeLastName || '',
                            phone: invitation.inviteePhone || null,
                            gamertag: invitation.inviteeGamertag || '',
                            allergies: invitation.inviteeAllergies || '',
                            profileComplete: false,
                            invitationPending: true,
                            teamId,
                            createdAt: now,
                            updatedAt: now
                        });
                    } else {
                        const contactUpdates = {
                            teamId,
                            invitationPending: true,
                            updatedAt: now
                        };
                        if (invitation.inviteeFirstName) contactUpdates.firstName = invitation.inviteeFirstName;
                        if (invitation.inviteeLastName) contactUpdates.lastName = invitation.inviteeLastName;
                        if (invitation.inviteePhone) contactUpdates.phone = invitation.inviteePhone;
                        if (invitation.inviteeGamertag) contactUpdates.gamertag = invitation.inviteeGamertag;
                        if (invitation.inviteeAllergies) contactUpdates.allergies = invitation.inviteeAllergies;
                        await UsersStore.update(contact.id, contactUpdates);
                        contact = { ...contact, ...contactUpdates };
                    }

                    const existingParticipation = await ParticipationsStore.findOneBy({ userId: contact.id, eventId: resolvedEventId })
                        || await ParticipationsStore.findOneBy({ email: invitation.email, eventId: resolvedEventId });

                    if (existingParticipation) {
                        await ParticipationsStore.update(existingParticipation.id, {
                            userId: contact.id,
                            email: invitation.email,
                            teamId,
                            isTeamAdmin: false,
                            profileVerification: false,
                            updatedAt: now
                        });
                    } else {
                        await ParticipationsStore.create({
                            id: generateId(),
                            eventId: resolvedEventId,
                            email: invitation.email,
                            userId: contact.id,
                            roles: ['participant'],
                            teamId,
                            isTeamAdmin: false,
                            profileVerification: false,
                            hotelNights: {},
                            createdAt: now,
                            updatedAt: now
                        });
                    }
                }

                await InvitationsStore.create(invitation);

                if (role === 'judge' || role === 'committee') {
                    await Storage.allowedEmails.add(email, inviterId);
                }
            });

            try {
                const mail = await buildInvitationMail(invitation, context);
                if (!mail.success) {
                    throw new Error(`Invitation template failed: ${mail.reason}`);
                }
                await sendEmail({ to: email, subject: mail.subject, htmlContent: mail.htmlContent });
                invitation.emailSent = true;
            } catch (emailError) {
                await logError(context, emailError);
                context.warn(`Failed to send invitation email for ${invitation.id}: ${emailError.message}`);
                invitation.emailSent = false;
                invitation.emailError = 'The invitation was saved but the email could not be sent. Use "Resend" to try again.';
            }

            return { status: 201, jsonBody: invitation };
        } catch (error) {
            await logError(context, error);
            context.error('Error creating invitation:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

app.http('invitations-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'invitations',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const teamId = request.query.get('teamId');
            const email = request.query.get('email');

            let invitations;
            if (teamId) {
                const team = await Storage.teams.getById(teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }
                const teamParticipations = await ParticipationsStore.findBy({ userId: auth.user.userId });
                if (!isTeamAuthorized(auth.user, team, teamParticipations)) {
                    return { status: 403, jsonBody: { error: 'You do not have permission to view this team\'s invitations' } };
                }
                invitations = await InvitationsStore.findBy({ teamId });
            } else if (email) {
                if (typeof email !== 'string' || email.length > 320) {
                    return { status: 400, jsonBody: { error: 'Invalid email' } };
                }
                const isSelf = auth.user.email && auth.user.email.toLowerCase() === email.toLowerCase();
                if (!isSelf && !auth.user.isPortalAdmin) {
                    return { status: 403, jsonBody: { error: 'You do not have permission to view these invitations' } };
                }
                invitations = await InvitationsStore.findBy({ email, status: 'pending' });
            } else if (!auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'Admin access required to list all invitations' } };
            } else {
                invitations = await InvitationsStore.getAll();
            }

            const now = new Date();
            invitations = invitations.map(i => ({
                ...i,
                isExpired: new Date(i.expiresAt) < now
            }));

            return { status: 200, jsonBody: invitations };
        } catch (error) {
            await logError(context, error);
            context.error('Error listing invitations:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

app.http('invitations-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'invitations/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const invitation = await InvitationsStore.getById(id);

            if (!invitation) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }

            const isExpired = new Date(invitation.expiresAt) < new Date();

            let eventName = null;
            let eventStartDate = null;
            let eventEndDate = null;
            let eventLocation = null;
            if (invitation.eventId) {
                try {
                    const event = await Storage.events.getById(invitation.eventId);
                    if (event) {
                        eventName = event.name;
                        eventStartDate = event.startDate || null;
                        eventEndDate = event.endDate || null;
                        eventLocation = event.location || null;
                    }
                } catch (err) {
                    await logError(context, err);
                }
            }

            return {
                status: 200,
                jsonBody: {
                    id: invitation.id,
                    role: invitation.role,
                    teamId: invitation.teamId,
                    teamName: invitation.teamName || null,
                    status: invitation.status,
                    expiresAt: invitation.expiresAt,
                    isExpired,
                    emailHint: invitation.email
                        ? invitation.email.replace(/^(.).*(@.*)$/, '$1***$2')
                        : null,
                    eventId: invitation.eventId || null,
                    eventName,
                    eventStartDate,
                    eventEndDate,
                    eventLocation
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting invitation:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

app.http('invitations-accept', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'invitations/{id}/accept',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            if (!isGuid(id)) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }

            const body = await readJson(request);
            if (!body) return INVALID_JSON;

            const v = new Validator();
            const profile = validateProfile(v, body.profile);
            if (v.failed) return v.failure();

            const userEmail = auth.user.email?.toLowerCase();
            const userId = auth.user.userId;

            if (!userEmail) {
                return { status: 400, jsonBody: { error: 'Authenticated email is required' } };
            }

            const invitation = await InvitationsStore.getById(id);

            if (!invitation) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }

            if (invitation.email.toLowerCase() !== userEmail) {
                return { status: 403, jsonBody: { error: 'Email does not match invitation' } };
            }

            if (new Date(invitation.expiresAt) < new Date()) {
                return { status: 400, jsonBody: { error: 'Invitation has expired' } };
            }

            if (invitation.status !== 'pending') {
                return { status: 400, jsonBody: { error: `Invitation already ${invitation.status}` } };
            }

            let eventId = invitation.eventId;
            if (!eventId && invitation.teamId) {
                const team = await Storage.teams.getById(invitation.teamId);
                eventId = team?.eventId;
            }

            const inviteRole = invitation.role || 'participant';

            let defaultHotelNights = {};
            if (eventId) {
                const resolvedEvent = await Storage.events.getById(eventId);
                if (resolvedEvent?.hotelEnabled && resolvedEvent.hotelDefaultNights?.length) {
                    for (const night of resolvedEvent.hotelDefaultNights) {
                        defaultHotelNights[night] = true;
                    }
                }
            }

            // Account, participation and invitation status change together or not at all.
            const { user, resolvedUserId } = await withTransaction(async () => {
                let resolvedUserId = userId;
                let existingUser = userId ? await UsersStore.getById(userId) : null;

                if (!existingUser) {
                    existingUser = await Storage.users.getByEmail(userEmail);
                }

                const now = new Date().toISOString();
                if (!existingUser) {
                    // Judges, committee members and invitees without an account get one here.
                    const newId = generateId();
                    const newUser = {
                        id: newId,
                        email: userEmail,
                        firstName: profile.firstName || invitation.inviteeFirstName || '',
                        lastName: profile.lastName || invitation.inviteeLastName || '',
                        phone: profile.phone || invitation.inviteePhone || null,
                        gamertag: profile.gamertag || invitation.inviteeGamertag || '',
                        allergies: profile.allergies || invitation.inviteeAllergies || '',
                        profileComplete: true,
                        invitationPending: false,
                        teamId: isTeamInvitation(invitation) ? invitation.teamId : null,
                        createdAt: now,
                        updatedAt: now
                    };
                    await Storage.users.create(newUser);
                    existingUser = newUser;
                    resolvedUserId = newId;
                    context.log(`Created new user from invitation ${id}`);
                } else {
                    resolvedUserId = existingUser.id;
                    const userUpdates = { updatedAt: now };
                    if (profile.firstName) userUpdates.firstName = profile.firstName;
                    if (profile.lastName) userUpdates.lastName = profile.lastName;
                    if (profile.phone) userUpdates.phone = profile.phone;
                    if (profile.gamertag !== undefined) userUpdates.gamertag = profile.gamertag ?? '';
                    if (profile.allergies !== undefined) userUpdates.allergies = profile.allergies ?? '';
                    userUpdates.profileComplete = true;
                    userUpdates.invitationPending = false;
                    if (isTeamInvitation(invitation)) {
                        userUpdates.teamId = invitation.teamId;
                    }
                    await UsersStore.update(resolvedUserId, userUpdates);
                    existingUser = { ...existingUser, ...userUpdates };
                }

                if (eventId) {
                    const existingParticipation = await ParticipationsStore.findOneBy({ email: userEmail, eventId })
                        || await ParticipationsStore.findOneBy({ userId: resolvedUserId, eventId });

                    if (!existingParticipation) {
                        const initialHotelPaidBy = (inviteRole === 'committee' || inviteRole === 'judge')
                            ? 'committee' : null;

                        await ParticipationsStore.create({
                            id: generateId(),
                            eventId,
                            email: userEmail,
                            userId: resolvedUserId,
                            roles: [inviteRole],
                            teamId: isTeamInvitation(invitation) ? invitation.teamId : null,
                            isTeamAdmin: false,
                            profileVerification: true,
                            hotelNights: defaultHotelNights,
                            hotelPaidBy: initialHotelPaidBy,
                            createdAt: now,
                            updatedAt: now
                        });
                    } else {
                        const updatedRoles = [...(existingParticipation.roles || [])];
                        if (!updatedRoles.includes(inviteRole)) updatedRoles.push(inviteRole);

                        const partUpdates = {
                            roles: updatedRoles,
                            userId: existingParticipation.userId || resolvedUserId,
                            email: existingParticipation.email || userEmail,
                            profileVerification: true,
                            updatedAt: now
                        };

                        if (invitation.teamId && inviteRole === 'participant') {
                            partUpdates.teamId = invitation.teamId;
                            partUpdates.isTeamAdmin = false;
                            const interestIdx = updatedRoles.indexOf('interest');
                            if (interestIdx !== -1) {
                                updatedRoles.splice(interestIdx, 1);
                                partUpdates.roles = updatedRoles;
                                partUpdates.convertedFrom = 'interest';
                                partUpdates.convertedAt = now;
                                partUpdates.convertedVia = 'invitation';
                                partUpdates.invitationId = invitation.id;
                            }
                        }

                        await ParticipationsStore.update(existingParticipation.id, partUpdates);
                    }
                }

                await InvitationsStore.update(id, {
                    status: 'accepted',
                    acceptedAt: now,
                    acceptedBy: resolvedUserId
                });

                return { user: existingUser, resolvedUserId };
            });

            if (eventId) {
                triggerSequenceEmailsForInvite(resolvedUserId, userEmail, eventId, context)
                    .catch(err => context.log(`Failed sequence emails after invitation ${id}: ${err.message}`));
            }

            // Fresh session: the caller's token may predate the account (userId: null).
            const session = issueSession(user);

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    teamId: invitation.teamId,
                    teamName: invitation.teamName,
                    eventId: eventId,
                    role: invitation.role,
                    token: session.token,
                    user: session.user
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error accepting invitation:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

// Undo the provisional contact a team invitation created, if nothing else depends on it.
async function releaseProvisionalContact(invitation, context) {
    if (!isTeamInvitation(invitation)) return;
    const contact = await Storage.users.getByEmail(invitation.email);
    if (!contact || !contact.invitationPending) return;

    const participations = await ParticipationsStore.findBy({ userId: contact.id });
    for (const p of await ParticipationsStore.findBy({ email: invitation.email })) {
        if (!participations.some(x => sameId(x.id, p.id))) participations.push(p);
    }
    const stubs = participations.filter(p => sameId(p.teamId, invitation.teamId) && !p.profileVerification);
    const others = participations.filter(p => !stubs.includes(p));
    const now = new Date().toISOString();

    const removeAccount = !contact.profileComplete && others.length === 0;
    for (const stub of stubs) {
        if (removeAccount) await ParticipationsStore.delete(stub.id);
        else await ParticipationsStore.update(stub.id, { teamId: null, isTeamAdmin: false, updatedAt: now });
    }
    if (removeAccount) {
        await Storage.users.delete(contact.id);
        context.log(`Removed provisional contact created by invitation ${invitation.id}`);
    } else {
        await UsersStore.update(contact.id, { invitationPending: false, teamId: null, updatedAt: now });
    }
}

app.http('invitations-cancel', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'invitations/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const existing = await InvitationsStore.getById(id);

            if (!existing) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }

            if (!(await isInvitationAuthorized(auth.user, existing))) {
                return { status: 403, jsonBody: { error: 'You do not have permission to cancel this invitation' } };
            }

            if (existing.status !== 'pending') {
                return { status: 400, jsonBody: { error: `Only pending invitations can be cancelled (this one is ${existing.status})` } };
            }

            await withTransaction(async () => {
                await InvitationsStore.update(id, {
                    status: 'cancelled',
                    cancelledAt: new Date().toISOString()
                });
                await releaseProvisionalContact(existing, context);
            });

            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            await logError(context, error);
            context.error('Error cancelling invitation:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

app.http('invitations-resend', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'invitations/{id}/resend',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const invitation = await InvitationsStore.getById(id);

            if (!invitation) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }

            if (!(await isInvitationAuthorized(auth.user, invitation))) {
                return { status: 403, jsonBody: { error: 'You do not have permission to resend this invitation' } };
            }

            if (invitation.status !== 'pending') {
                return { status: 400, jsonBody: { error: 'Can only resend pending invitations' } };
            }

            // Every (re)send sets ExpiresAt = sent + 7 days, so the last send time is derivable
            // without a schema change; one reminder per minute per invitation.
            const lastSentAt = new Date(invitation.expiresAt).getTime() - INVITATION_TTL_MS;
            if (Number.isFinite(lastSentAt) && Date.now() - lastSentAt < RESEND_COOLDOWN_MS) {
                return { status: 429, jsonBody: { error: 'Please wait a minute before resending this invitation' } };
            }

            const newExpiry = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
            const invitationForEmail = { ...invitation, expiresAt: newExpiry };

            const mail = await buildInvitationMail(invitationForEmail, context, { reminder: true });
            if (!mail.success) {
                context.warn(`Invitation ${id} could not be rendered: ${mail.reason}`);
                return MAIL_FAILED;
            }

            try {
                await sendEmail({ to: invitationForEmail.email, subject: mail.subject, htmlContent: mail.htmlContent });
            } catch (mailError) {
                await logError(context, mailError);
                context.warn(`Resend of invitation ${id} failed: ${mailError.message}`);
                return MAIL_FAILED;
            }

            await InvitationsStore.update(id, { expiresAt: newExpiry });

            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            await logError(context, error);
            context.error('Error resending invitation:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});
