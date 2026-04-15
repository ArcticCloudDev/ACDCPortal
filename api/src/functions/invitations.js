const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { sendEmail, processTemplate } = require('../shared/mail');
const { buildInvitationEmail } = require('../shared/invitation-email');
const { buildEmailHtml } = require('../shared/email-builder');
const Storage = require('../shared/storage');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

// Atomic per-row stores — no delete-all-reinsert, ever
const InvitationsStore = new Storage.Storage('invitations');
const ParticipationsStore = new Storage.Storage('participations');
const UsersStore = new Storage.Storage('users');
const EmailDeliveriesStore = new Storage.Storage('email-deliveries');
const EmailCampaignsStore = new Storage.Storage('email-campaigns');

/**
 * Trigger sequence emails for a user after accepting invitation.
 */
async function triggerSequenceEmailsForInvite(userId, userEmail, eventId, context) {
    try {
        const user = await Storage.users.getById(userId);
        const email = user?.email || userEmail;
        const firstName = user?.firstName || 'Participant';

        if (!email) {
            context.log(`No email found for sequence emails: ${userId}`);
            return;
        }

        // Look up event to get its sequenceId
        const event = await Storage.events.getById(eventId);
        if (!event || !event.sequenceEnabled || !event.sequenceId) {
            context.log(`Event ${eventId} not found or sequence not enabled`);
            return;
        }

        const campaigns = await EmailCampaignsStore.getAll();
        const sequenceCampaigns = campaigns
            .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence' && c.status === 'live')
            .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

        if (sequenceCampaigns.length === 0) {
            context.log(`No sequence campaigns for sequence ${event.sequenceId} (event ${eventId})`);
            return;
        }

        const allDeliveries = await EmailDeliveriesStore.getAll();
        const userDeliveries = new Set(
            allDeliveries
                .filter(d => d.email.toLowerCase() === email.toLowerCase() && d.status === 'sent')
                .map(d => d.campaignId)
        );

        // Filter to only unsent campaigns
        const campaignsToSend = sequenceCampaigns.filter(c => !userDeliveries.has(c.id));
        if (campaignsToSend.length === 0) {
            context.log(`All sequence emails already sent to ${email}`);
            return;
        }

        // Build digest email with all unsent campaigns in one message
        const messageBlocks = campaignsToSend.map((campaign, index) => `
            <tr>
                <td style="padding: 0;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                            <td style="background-color: #1e293b; padding: 14px 40px;">
                                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                                    <tr>
                                        <td>
                                            <span style="color: #94a3b8; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase;">UPDATE ${index + 1} OF ${campaignsToSend.length}</span>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td style="padding-top: 4px;">
                                            <span style="color: #ffffff; font-size: 18px; font-weight: 700;">${campaign.subject}</span>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding: 28px 40px 8px 40px; color: #334155; font-size: 15px; line-height: 1.75;">
                                ${campaign.content}
                            </td>
                        </tr>
                        ${campaign.ctaUrl ? `
                        <tr>
                            <td style="padding: 0 40px 32px 40px; text-align: center;">
                                <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                                    <tr>
                                        <td align="center" bgcolor="#1d4ed8" style="background-color: #1d4ed8; border-radius: 8px; padding: 14px 36px;">
                                            <a href="${campaign.ctaUrl}" style="display: block; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; line-height: 1.2;">
                                                ${campaign.ctaText || 'Learn More'}
                                            </a>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                        ` : `<tr><td style="padding-bottom: 32px;"></td></tr>`}
                    </table>
                </td>
            </tr>
        `).join('');

        const digestTemplatePath = path.join(__dirname, '../../data/email-templates/sequence-digest.html');
        const digestTemplate = await fs.readFile(digestTemplatePath, 'utf-8');
        const digestHtml = processTemplate(digestTemplate, {
            eventName: event.name,
            firstName: firstName,
            digestCount: campaignsToSend.length.toString(),
            digestContent: messageBlocks,
            year: new Date().getFullYear().toString()
        });

        try {
            await sendEmail({
                to: email,
                subject: `${event.name} - Important Updates`,
                htmlContent: digestHtml
            });

            // Record each delivery atomically — no delete-all-reinsert
            for (const campaign of campaignsToSend) {
                await EmailDeliveriesStore.create({
                    id: uuidv4(),
                    campaignId: campaign.id,
                    email: email,
                    userId: userId,
                    status: 'sent',
                    sentAt: new Date().toISOString(),
                    sentVia: 'digest',
                    createdAt: new Date().toISOString()
                });
            }
            context.log(`Sent digest of ${campaignsToSend.length} sequence emails to ${email} for event ${eventId}`);
        } catch (err) {
            await logError(context, err);
            for (const campaign of campaignsToSend) {
                await EmailDeliveriesStore.create({
                    id: uuidv4(),
                    campaignId: campaign.id,
                    email: email,
                    userId: userId,
                    status: 'failed',
                    error: err.message,
                    createdAt: new Date().toISOString()
                });
            }
            context.log(`Failed to send digest to ${email}: ${err.message}`);
        }
    } catch (error) {
        await logError(context, error);
        context.log(`Warning: Failed to trigger sequence emails: ${error.message}`);
    }
}

// Helper to build team welcome email for invited participants using the team-welcome template
async function buildTeamWelcomeEmailForInvitation(invitation, context) {
    try {
        // Load system email config from SQL
        const config = await Storage.readData('system-email-config.json');
        const template = config.templates['team-welcome'];

        if (!template) {
            return { success: false, reason: 'team-welcome template not configured' };
        }

        // Get event for name and theme
        const event = invitation.eventId ? await Storage.events.getById(invitation.eventId) : null;
        const eventName = event ? event.name : 'the event';

        // Get event-specific theme or use global defaults
        const eventTheme = invitation.eventId ? (template.eventThemes[invitation.eventId] || {}) : {};
        const globalDefaults = template.editableSections;

        // Extract image src from HTML (same as team-welcome.js)
        const extractImageSrc = (html) => {
            if (!html) return '';
            const match = html.match(/src="([^"]+)"/);
            return match ? match[1] : html;
        };

        const portalUrl = process.env.PORTAL_URL || 'https://your-portal.com';
        const acceptUrl = `${portalUrl}/accept-invitation.html?invite=${invitation.id}`;

        // Build merge data from invitation object
        const inviteeName = [invitation.inviteeFirstName, invitation.inviteeLastName].filter(Boolean).join(' ');
        const mergeData = {
            teamName: invitation.teamName || 'the team',
            fullName: inviteeName || invitation.email.split('@')[0],
            eventName: eventName,
            teamAdminName: invitation.inviterName || 'Team Admin',
            portalUrl: acceptUrl
        };

        // Pre-process the editable body/closing sections so nested {{placeholders}} are resolved
        const rawBody = eventTheme.body || globalDefaults.body || '';
        const rawClosing = eventTheme.closing || globalDefaults.closing || '';
        mergeData.bodyText = processTemplate(rawBody, mergeData);
        mergeData.closingText = processTemplate(rawClosing, mergeData);

        // Build HTML using the JSON-driven builder — pass per-event structural overrides
        const htmlContent = buildEmailHtml(template, mergeData, eventTheme);
        const subject = processTemplate(eventTheme.subject || template.subject, mergeData);

        return { success: true, htmlContent, subject };
    } catch (error) {
        await logError(context, error);
        context.error('Error building team welcome email for invitation:', error);
        return { success: false, reason: error.message };
    }
}

// Create invitation
app.http('invitations-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'invitations',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { email, teamId, eventId, role, inviterId, inviterName, inviterEmail, message, inviteeFirstName, inviteeLastName } = body;
            
            // Role-based invites (judge/committee) need eventId; team invites need teamId
            if (!email || !inviterId) {
                return { status: 400, jsonBody: { error: 'email and inviterId are required' } };
            }
            if (!teamId && !eventId) {
                return { status: 400, jsonBody: { error: 'teamId or eventId is required' } };
            }
            
            let teamName = null;
            let resolvedEventId = eventId;

            if (teamId) {
                // Team-based invitation — get team info
                const team = await Storage.teams.getById(teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }
                teamName = team.teamName || team.name;
                resolvedEventId = resolvedEventId || team.eventId;

                // Check if user already on a team (only for participant invites)
                if (!role || role === 'participant') {
                    const existingUser = await Storage.users.getByEmail(email);
                    if (existingUser && existingUser.teamId) {
                        return { status: 400, jsonBody: { error: `${email} is already on a team` } };
                    }
                }
            }
            
            // Check for existing pending invitation for same email+event+role combo
            const allInvitations = await InvitationsStore.getAll();
            const existingInvite = allInvitations.find(i => {
                if (i.email.toLowerCase() !== email.toLowerCase() || i.status !== 'pending') return false;
                // For role invites, check same event+role
                if (role && i.role === role && i.eventId === resolvedEventId) return true;
                // For team invites, check same team
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
            
            // Create invitation
            const invitation = {
                id: uuidv4(),
                email: email.toLowerCase(),
                inviteeFirstName: inviteeFirstName || null,
                inviteeLastName: inviteeLastName || null,
                teamId: teamId || null,
                teamName: teamName,
                eventId: resolvedEventId || null,
                role: role || null, // 'judge', 'committee', 'sponsor', or null for team participant
                inviterId,
                inviterName: inviterName || 'Team Admin',
                inviterEmail: inviterEmail || '',
                message: message || 'Join our team for the Arctic Cloud Developer Challenge!',
                status: 'pending',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days
            };
            
            await InvitationsStore.create(invitation);
            
            // For judge/committee invitations: add to allowed emails
            // This ensures they can log in when they click the invitation link
            if (role === 'judge' || role === 'committee') {
                // Add to allowed emails so they pass auth-check-email
                await Storage.allowedEmails.add(email.toLowerCase(), inviterId);
                context.log(`Added ${email} to allowed-emails for ${role} invitation`);
                

            }
            
            // Send invitation email
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
                    // Team/participant invitation — use team-welcome template
                    context.log('[DEBUG invitations] Routing to buildTeamWelcomeEmailForInvitation');
                    const result = await buildTeamWelcomeEmailForInvitation(invitation, context);
                    if (!result.success) {
                        throw new Error(`Team welcome template failed: ${result.reason}`);
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
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// List invitations (for a team or by email)
app.http('invitations-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'invitations',
    handler: async (request, context) => {
        try {
            const teamId = request.query.get('teamId');
            const email = request.query.get('email');
            
            let invitations = await InvitationsStore.getAll();

            // Filter by team
            if (teamId) {
                invitations = invitations.filter(i => i.teamId === teamId);
            }
            
            // Filter by email (for checking pending invites for a user)
            if (email) {
                invitations = invitations.filter(
                    i => i.email.toLowerCase() === email.toLowerCase() && i.status === 'pending'
                );
            }
            
            // Clean up expired invitations
            const now = new Date();
            invitations = invitations.map(i => ({
                ...i,
                isExpired: new Date(i.expiresAt) < now
            }));
            
            return { status: 200, jsonBody: invitations };
        } catch (error) {
            await logError(context, error);
            context.error('Error listing invitations:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Get single invitation
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

            // Enrich with event name if eventId is present
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
                    // Non-critical, continue without event details
                }
            }
            
            return { 
                status: 200, 
                jsonBody: { ...invitation, isExpired, eventName, eventStartDate, eventEndDate, eventLocation } 
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting invitation:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Accept invitation
app.http('invitations-accept', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'invitations/{id}/accept',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const body = await request.json();
            const { userId, userEmail, profile } = body;
            
            if (!userEmail) {
                return { status: 400, jsonBody: { error: 'userEmail is required' } };
            }
            
            const invitation = await InvitationsStore.getById(id);

            if (!invitation) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }

            // Verify email matches
            if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
                return { status: 403, jsonBody: { error: 'Email does not match invitation' } };
            }
            
            // Check if expired
            if (new Date(invitation.expiresAt) < new Date()) {
                return { status: 400, jsonBody: { error: 'Invitation has expired' } };
            }
            
            // Check if already accepted
            if (invitation.status !== 'pending') {
                return { status: 400, jsonBody: { error: `Invitation already ${invitation.status}` } };
            }
            
            // Resolve eventId from team if not on invitation
            let eventId = invitation.eventId;
            if (!eventId && invitation.teamId) {
                const team = await Storage.teams.getById(invitation.teamId);
                eventId = team?.eventId;
            }
            
            // Get or create user
            let resolvedUserId = userId;
            let existingUser = userId ? await UsersStore.getById(userId) : null;

            if (!existingUser) {
                // New invitee — look up by email first, then create if still missing
                existingUser = await Storage.users.getByEmail(userEmail.toLowerCase());
            }

            if (!existingUser) {
                // First-time invitee: create account from invitation data + submitted profile
                const newId = uuidv4();
                const now = new Date().toISOString();
                const newUser = {
                    id: newId,
                    email: userEmail.toLowerCase(),
                    firstName: profile?.firstName || invitation.inviteeFirstName || '',
                    lastName: profile?.lastName || invitation.inviteeLastName || '',
                    phone: profile?.phone || '',
                    profileComplete: true,
                    roles: ['participant'],
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
                userUpdates.profileComplete = true;
                if (invitation.teamId && (!invitation.role || invitation.role === 'participant')) {
                    userUpdates.teamId = invitation.teamId;
                }
                await UsersStore.update(resolvedUserId, userUpdates);
            }
            
            // Create or update participation for this event (atomic per-row)
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
                        id: uuidv4(),
                        eventId,
                        email: userEmail.toLowerCase(),
                        userId: resolvedUserId,
                        roles: [inviteRole],
                        teamId: invitation.teamId || null,
                        isTeamAdmin: false,
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

            // Update invitation status atomically
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
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Cancel/revoke invitation
app.http('invitations-cancel', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'invitations/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const existing = await InvitationsStore.getById(id);

            if (!existing) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }

            await InvitationsStore.update(id, {
                status: 'cancelled',
                cancelledAt: new Date().toISOString()
            });
            
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            await logError(context, error);
            context.error('Error cancelling invitation:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Resend invitation email
app.http('invitations-resend', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'invitations/{id}/resend',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const invitation = await InvitationsStore.getById(id);

            if (!invitation) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }

            if (invitation.status !== 'pending') {
                return { status: 400, jsonBody: { error: 'Can only resend pending invitations' } };
            }

            const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            // Update expiry in a local copy for use in the email builder
            const invitationForEmail = { ...invitation, expiresAt: newExpiry };
            
            // Send email - route by role
            let htmlContent, emailSubject;

            if (invitationForEmail.role === 'judge' || invitationForEmail.role === 'committee') {
                const result = await buildInvitationEmail(invitationForEmail, context);
                if (!result.success) {
                    throw new Error(`${invitationForEmail.role} invitation template failed: ${result.reason}`);
                }
                htmlContent = result.htmlContent;
                emailSubject = `Reminder: ${result.subject}`;
            } else {
                // Team/participant invitation — use team-welcome template
                const result = await buildTeamWelcomeEmailForInvitation(invitationForEmail, context);
                if (!result.success) {
                    throw new Error(`Team welcome template failed: ${result.reason}`);
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
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});
