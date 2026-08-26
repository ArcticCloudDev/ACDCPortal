const { app } = require('@azure/functions');
const { requireAuth, isTeamAuthorized } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { sendEmail, processTemplate } = require('../shared/mail');
const { buildInvitationEmail } = require('../shared/invitation-email');
const { buildEmailHtml } = require('../shared/email-builder');
const Storage = require('../shared/storage');
const { generateId } = require('../shared/id');
const fs = require('fs').promises;
const path = require('path');
const { sendSequenceDigest } = require('../shared/sequence-digest');

const InvitationsStore = new Storage.Storage('invitations');
const ParticipationsStore = new Storage.Storage('participations');
const UsersStore = new Storage.Storage('users');

async function isInvitationAuthorized(user, invitation) {
    if (!user) return false;
    if (user.isPortalAdmin) return true;
    if (invitation.teamId) {
        const team = await Storage.teams.getById(invitation.teamId);
        if (!team) return false;
        const participations = await ParticipationsStore.getAll();
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

        const extractImageSrc = (html) => {
            if (!html) return '';
            const match = html.match(/src="([^"]+)"/);
            return match ? match[1] : html;
        };

        const portalUrl = process.env.PORTAL_URL || 'https://your-portal.com';
        const acceptUrl = `${portalUrl}/accept-invitation.html?invite=${invitation.id}`;

        const inviteeName = [invitation.inviteeFirstName, invitation.inviteeLastName].filter(Boolean).join(' ');
        const mergeData = {
            teamName: invitation.teamName || 'the team',
            fullName: inviteeName || invitation.email.split('@')[0],
            eventName: eventName,
            teamAdminName: invitation.inviterName || 'Event Organizer',
            portalUrl: acceptUrl
        };

        const rawBody = eventTheme.body || globalDefaults.body || '';
        const rawClosing = eventTheme.closing || globalDefaults.closing || '';
        mergeData.bodyText = processTemplate(rawBody, mergeData);
        mergeData.closingText = processTemplate(rawClosing, mergeData);

        const htmlContent = buildEmailHtml(template, mergeData, eventTheme);
        const subject = processTemplate(eventTheme.subject || template.subject, mergeData);

        return { success: true, htmlContent, subject };
    } catch (error) {
        await logError(context, error);
        context.error('Error building team welcome email for invitation:', error);
        return { success: false, reason: error.message };
    }
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

            const body = await request.json();
            const {
                email, teamId, eventId, role, inviterName, inviterEmail, message,
                inviteeFirstName, inviteeLastName, inviteePhone, inviteeGamertag, inviteeAllergies
            } = body;
            const inviterId = auth.user.userId;

            if (!email || !inviterId) {
                return { status: 400, jsonBody: { error: 'email and inviterId are required' } };
            }
            if (!teamId && !eventId) {
                return { status: 400, jsonBody: { error: 'teamId or eventId is required' } };
            }

            if (teamId) {
                const team = await Storage.teams.getById(teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }
                const participations = await ParticipationsStore.getAll();
                if (!isTeamAuthorized(auth.user, team, participations)) {
                    return { status: 403, jsonBody: { error: 'You do not have permission to invite members to this team' } };
                }
            } else if (role && role !== 'participant') {
                if (!auth.user.isPortalAdmin) {
                    return { status: 403, jsonBody: { error: 'Only portal admins can send judge/committee/sponsor invitations' } };
                }
            }

            let teamName = null;
            let resolvedEventId = eventId;

            if (teamId) {
                const team = await Storage.teams.getById(teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }
                teamName = team.teamName || team.name;
                resolvedEventId = resolvedEventId || team.eventId;

                if (!role || role === 'participant') {
                    const existingUser = await Storage.users.getByEmail(email);
                    const allParticipations = await ParticipationsStore.getAll();
                    const matchingParticipations = allParticipations.filter(participation => {
                        if (participation.email?.toLowerCase() !== email.toLowerCase()) return false;
                        return participation.teamId || (participation.teamMemberships || []).some(membership => membership.teamId);
                    });
                    const belongsToAnotherTeam = matchingParticipations.some(participation => {
                        const memberships = participation.teamMemberships || [];
                        return (participation.teamId && participation.teamId !== teamId)
                            || memberships.some(membership => membership.teamId !== teamId);
                    });
                    if (belongsToAnotherTeam) {
                        return { status: 400, jsonBody: { error: `${email} is already on a team` } };
                    }
                    const isConfirmedMemberOfTargetTeam = existingUser
                        && !existingUser.invitationPending
                        && matchingParticipations.some(participation => {
                            const memberships = participation.teamMemberships || [];
                            return participation.teamId === teamId
                                || memberships.some(membership => membership.teamId === teamId);
                        });
                    if (isConfirmedMemberOfTargetTeam) {
                        return { status: 400, jsonBody: { error: `${email} is already on this team` } };
                    }

                    if (!existingUser && matchingParticipations.length > 0) {
                        for (const participation of matchingParticipations) {
                            await ParticipationsStore.delete(participation.id);
                        }
                        const invitations = await InvitationsStore.getAll();
                        for (const staleInvitation of invitations) {
                            if (staleInvitation.status === 'pending'
                                && staleInvitation.teamId === teamId
                                && staleInvitation.email?.toLowerCase() === email.toLowerCase()) {
                                await InvitationsStore.delete(staleInvitation.id);
                            }
                        }
                    }
                }
            }

            const allInvitations = await InvitationsStore.getAll();
            const existingInvite = allInvitations.find(i => {
                if (i.email.toLowerCase() !== email.toLowerCase() || i.status !== 'pending') return false;
                if (role && i.role === role && i.eventId === resolvedEventId) return true;
                if (teamId && i.teamId === teamId) return true;
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
                email: email.toLowerCase(),
                inviteeFirstName: inviteeFirstName || null,
                inviteeLastName: inviteeLastName || null,
                inviteePhone: inviteePhone || null,
                inviteeGamertag: inviteeGamertag || null,
                inviteeAllergies: inviteeAllergies || null,
                teamId: teamId || null,
                teamName: teamName,
                eventId: resolvedEventId || null,
                role: role || null,
                inviterId,
                inviterName: inviterName || 'Event Organizer',
                inviterEmail: inviterEmail || '',
                message: message || 'Join our team for the Arctic Cloud Developer Challenge!',
                status: 'pending',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            };

            if (teamId && (!role || role === 'participant')) {
                const now = new Date().toISOString();
                let contact = await Storage.users.getByEmail(invitation.email);

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

                const participations = await ParticipationsStore.getAll();
                const existingParticipation = participations.find(participation =>
                    participation.eventId === resolvedEventId
                    && (participation.userId === contact.id
                        || participation.email?.toLowerCase() === invitation.email)
                );

                if (existingParticipation) {
                    await ParticipationsStore.update(existingParticipation.id, {
                        userId: contact.id,
                        email: invitation.email,
                        teamId,
                        isTeamAdmin: false,
                        profileVerification: false,
                        updatedAt: now
                    });
                } else if (resolvedEventId) {
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
                await Storage.allowedEmails.add(email.toLowerCase(), inviterId);
                context.log(`Added ${email} to allowed-emails for ${role} invitation`);

            }

            try {
                let htmlContent, emailSubject;
                context.log(`[DEBUG invitations] Sending email for role='${invitation.role}', email='${invitation.email}', eventId='${invitation.eventId}'`);

                if (invitation.role === 'judge' || invitation.role === 'committee') {
                    context.log(`[DEBUG invitations] Routing to buildInvitationEmail for role '${invitation.role}'`);
                    const result = await buildInvitationEmail(invitation, context);
                    if (!result.success) {
                        throw new Error(`${invitation.role} invitation template failed: ${result.reason}`);
                    }
                    htmlContent = result.htmlContent;
                    emailSubject = result.subject;
                } else {
                    context.log('[DEBUG invitations] Routing to buildTeamWelcomeEmailForInvitation');
                    const result = await buildTeamWelcomeEmailForInvitation(invitation, context);
                    if (!result.success) {
                        throw new Error(`Welcome template failed: ${result.reason}`);
                    }
                    htmlContent = result.htmlContent;
                    emailSubject = result.subject;
                }

                await sendEmail({
                    to: email,
                    subject: emailSubject,
                    htmlContent
                });

                invitation.emailSent = true;
            } catch (emailError) {
                context.log('Failed to send invitation email:', emailError);
                invitation.emailSent = false;
                invitation.emailError = emailError.message;
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

            if (teamId) {
                const team = await Storage.teams.getById(teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }
                const teamParticipations = await ParticipationsStore.getAll();
                if (!isTeamAuthorized(auth.user, team, teamParticipations)) {
                    return { status: 403, jsonBody: { error: 'You do not have permission to view this team\'s invitations' } };
                }
            } else if (email) {
                const isSelf = auth.user.email && auth.user.email.toLowerCase() === email.toLowerCase();
                if (!isSelf && !auth.user.isPortalAdmin) {
                    return { status: 403, jsonBody: { error: 'You do not have permission to view these invitations' } };
                }
            } else if (!auth.user.isPortalAdmin) {
                return { status: 403, jsonBody: { error: 'Admin access required to list all invitations' } };
            }

            let invitations = await InvitationsStore.getAll();

            if (teamId) {
                invitations = invitations.filter(i => i.teamId === teamId);
            }

            if (email) {
                invitations = invitations.filter(
                    i => i.email.toLowerCase() === email.toLowerCase() && i.status === 'pending'
                );
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
            const body = await request.json();
            const { profile } = body;
            const userEmail = auth.user.email?.toLowerCase();
            const userId = auth.user.userId;

            if (!userEmail) {
                return { status: 400, jsonBody: { error: 'Authenticated email is required' } };
            }

            const invitation = await InvitationsStore.getById(id);

            if (!invitation) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }

            if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
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

            let resolvedUserId = userId;
            let existingUser = userId ? await UsersStore.getById(userId) : null;

            if (!existingUser) {
                existingUser = await Storage.users.getByEmail(userEmail.toLowerCase());
            }

            if (!existingUser) {
                const newId = generateId();
                const now = new Date().toISOString();
                const newUser = {
                    id: newId,
                    email: userEmail.toLowerCase(),
                    firstName: profile?.firstName || invitation.inviteeFirstName || '',
                    lastName: profile?.lastName || invitation.inviteeLastName || '',
                    phone: profile?.phone || invitation.inviteePhone || null,
                    gamertag: profile?.gamertag || invitation.inviteeGamertag || '',
                    allergies: profile?.allergies || invitation.inviteeAllergies || '',
                    profileComplete: true,
                    invitationPending: false,
                    teamId: invitation.teamId || null,
                    createdAt: now,
                    updatedAt: now
                };
                await Storage.users.create(newUser);
                existingUser = newUser;
                resolvedUserId = newId;
                context.log(`Created new user ${userEmail} from invitation ${id}`);
            } else {
                resolvedUserId = existingUser.id;
                const userUpdates = { updatedAt: new Date().toISOString() };
                if (profile?.firstName) userUpdates.firstName = profile.firstName;
                if (profile?.lastName) userUpdates.lastName = profile.lastName;
                if (profile?.phone) userUpdates.phone = profile.phone;
                if (profile?.gamertag !== undefined) userUpdates.gamertag = profile.gamertag;
                if (profile?.allergies !== undefined) userUpdates.allergies = profile.allergies;
                userUpdates.profileComplete = true;
                userUpdates.invitationPending = false;
                if (invitation.teamId && (!invitation.role || invitation.role === 'participant')) {
                    userUpdates.teamId = invitation.teamId;
                }
                await UsersStore.update(resolvedUserId, userUpdates);
            }

            if (eventId) {
                const inviteRole = invitation.role || 'participant';
                const allParticipations = await ParticipationsStore.getAll();
                const existingParticipation = allParticipations.find(
                    p => p.email?.toLowerCase() === userEmail.toLowerCase() && p.eventId === eventId
                );

                if (!existingParticipation) {
                    const initialHotelPaidBy = (inviteRole === 'committee' || inviteRole === 'judge')
                        ? 'committee' : null;

                    let defaultHotelNights = {};
                    try {
                        const resolvedEvent = await Storage.events.getById(eventId);
                        if (resolvedEvent?.hotelEnabled && resolvedEvent.hotelDefaultNights?.length) {
                            for (const night of resolvedEvent.hotelDefaultNights) {
                                defaultHotelNights[night] = true;
                            }
                        }
                    } catch (e) {
                        context.log(`Could not load event for hotel defaults: ${e.message}`);
                    }

                    await ParticipationsStore.create({
                        id: generateId(),
                        eventId,
                        email: userEmail.toLowerCase(),
                        userId: resolvedUserId,
                        roles: [inviteRole],
                        teamId: invitation.teamId || null,
                        isTeamAdmin: false,
                        profileVerification: true,
                        hotelNights: defaultHotelNights,
                        hotelPaidBy: initialHotelPaidBy,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                } else {
                    const updatedRoles = [...(existingParticipation.roles || [])];
                    if (!updatedRoles.includes(inviteRole)) updatedRoles.push(inviteRole);

                    const partUpdates = {
                        roles: updatedRoles,
                        userId: existingParticipation.userId || resolvedUserId,
                        email: existingParticipation.email || userEmail.toLowerCase(),
                        profileVerification: true,
                        updatedAt: new Date().toISOString()
                    };

                    if (invitation.teamId && inviteRole === 'participant') {
                        partUpdates.teamId = invitation.teamId;
                        partUpdates.isTeamAdmin = false;
                        const interestIdx = updatedRoles.indexOf('interest');
                        if (interestIdx !== -1) {
                            updatedRoles.splice(interestIdx, 1);
                            partUpdates.roles = updatedRoles;
                            partUpdates.convertedFrom = 'interest';
                            partUpdates.convertedAt = new Date().toISOString();
                            partUpdates.convertedVia = 'invitation';
                            partUpdates.invitationId = invitation.id;
                        }
                    }

                    await ParticipationsStore.update(existingParticipation.id, partUpdates);
                }

                triggerSequenceEmailsForInvite(resolvedUserId, userEmail, eventId, context)
                    .catch(err => context.log(`Failed sequence emails for ${userEmail}: ${err.message}`));
            }

            await InvitationsStore.update(id, {
                status: 'accepted',
                acceptedAt: new Date().toISOString(),
                acceptedBy: resolvedUserId
            });

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    teamId: invitation.teamId,
                    teamName: invitation.teamName,
                    eventId: eventId,
                    role: invitation.role
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error accepting invitation:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});

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

            await InvitationsStore.update(id, {
                status: 'cancelled',
                cancelledAt: new Date().toISOString()
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

            const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            const invitationForEmail = { ...invitation, expiresAt: newExpiry };

            let htmlContent, emailSubject;

            if (invitationForEmail.role === 'judge' || invitationForEmail.role === 'committee') {
                const result = await buildInvitationEmail(invitationForEmail, context);
                if (!result.success) {
                    throw new Error(`${invitationForEmail.role} invitation template failed: ${result.reason}`);
                }
                htmlContent = result.htmlContent;
                emailSubject = `Reminder: ${result.subject}`;
            } else {
                const result = await buildTeamWelcomeEmailForInvitation(invitationForEmail, context);
                if (!result.success) {
                    throw new Error(`Welcome template failed: ${result.reason}`);
                }
                htmlContent = result.htmlContent;
                emailSubject = `Reminder: ${result.subject}`;
            }

            await sendEmail({
                to: invitationForEmail.email,
                subject: emailSubject,
                htmlContent
            });

            await InvitationsStore.update(id, { expiresAt: newExpiry });

            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            await logError(context, error);
            context.error('Error resending invitation:', error);
            return { status: 500, jsonBody: { message: 'Internal server error' } };
        }
    }
});
