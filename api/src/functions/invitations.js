const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { readData, writeData } = require('../shared/storage');
const { sendEmail, processTemplate } = require('../shared/mail');
const { buildInvitationEmail } = require('../shared/invitation-email');
const { buildEmailHtml } = require('../shared/email-builder');
const Storage = require('../shared/storage');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

/**
 * Trigger sequence emails for a user after accepting invitation.
 * Same logic as participations.js triggerSequenceEmails but uses readData/writeData.
 */
async function triggerSequenceEmailsForInvite(userId, userEmail, eventId, context) {
    try {
        const usersData = await readData('users.json');
        const users = Array.isArray(usersData) ? usersData : (usersData.users || []);
        const user = users.find(u => u.id === userId);
        const email = user?.email || userEmail;
        const firstName = user?.firstName || 'Participant';

        if (!email) {
            context.log(`No email found for sequence emails: ${userId}`);
            return;
        }

        // Look up event to get its sequenceId
        const eventsData = await readData('events.json');
        const events = Array.isArray(eventsData) ? eventsData : (eventsData.events || []);
        const event = events.find(e => e.id === eventId);
        if (!event || !event.sequenceEnabled || !event.sequenceId) {
            context.log(`Event ${eventId} not found or sequence not enabled`);
            return;
        }

        const campaignData = await readData('email-campaigns.json');
        const campaigns = campaignData?.campaigns || campaignData || [];
        const sequenceCampaigns = campaigns
            .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence' && c.status === 'live')
            .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

        if (sequenceCampaigns.length === 0) {
            context.log(`No sequence campaigns for sequence ${event.sequenceId} (event ${eventId})`);
            return;
        }

        const deliveryData = await readData('email-deliveries.json') || { deliveries: [] };
        const deliveries = deliveryData.deliveries || [];
        const userDeliveries = new Set(
            deliveries
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
        const fs = require('fs').promises;
        const path = require('path');
        const { processTemplate } = require('../shared/mail');

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

            // Record deliveries for all campaigns included in the digest
            for (const campaign of campaignsToSend) {
                deliveries.push({
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
                deliveries.push({
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

        await writeData('email-deliveries.json', { deliveries });
    } catch (error) {
        await logError(context, error);
        context.log(`Warning: Failed to trigger sequence emails: ${error.message}`);
    }
}

// Helper to get invitations array from data (handles both {invitations:[]} and [] formats)
function getInvitationsArray(data) {
    return data.invitations || data;
}

// Helper to get users array from data (users.json is a plain array)
function getUsersArray(data) {
    return Array.isArray(data) ? data : (data.users || []);
}

// Helper to get teams array from data (teams.json is a plain array)
function getTeamsArray(data) {
    return Array.isArray(data) ? data : (data.teams || []);
}

// Helper to build team welcome email for invited participants using the team-welcome template
async function buildTeamWelcomeEmailForInvitation(invitation, context) {
    try {
        // Load system email config
        const configPath = path.join(__dirname, '../../data/system-email-config.json');
        const configData = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configData);
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
                const teamsData = await readData('teams.json');
                const team = teamsData.find(t => t.id === teamId);
                if (!team) {
                    return { status: 404, jsonBody: { error: 'Team not found' } };
                }
                teamName = team.teamName || team.name;
                resolvedEventId = resolvedEventId || team.eventId;

                // Check if user already on a team (only for participant invites)
                if (!role || role === 'participant') {
                    const usersData = await readData('users.json');
                    const existingUser = usersData.find(u => u.email.toLowerCase() === email.toLowerCase());
                    if (existingUser && existingUser.teamId) {
                        return { status: 400, jsonBody: { error: `${email} is already on a team` } };
                    }
                }
            }
            
            // Check for existing pending invitation for same email+event+role combo
            const invitationsData = await readData('invitations.json');
            const invitations = invitationsData.invitations || invitationsData;
            const existingInvite = invitations.find(i => {
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
            
            // Handle both {invitations: []} and plain [] formats
            if (invitationsData.invitations) {
                invitationsData.invitations.push(invitation);
                await writeData('invitations.json', invitationsData);
            } else {
                invitationsData.push(invitation);
                await writeData('invitations.json', { invitations: invitationsData });
            }
            
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
            
            const invitationsData = await readData('invitations.json');
            let invitations = invitationsData.invitations || invitationsData;
            
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
            const invitationsData = await readData('invitations.json');
            const invitations = getInvitationsArray(invitationsData);
            const invitation = invitations.find(i => i.id === id);
            
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
                    const eventsData = await readData('events.json');
                    const event = eventsData.find(e => e.id === invitation.eventId);
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
            const { userId, userEmail } = body;
            
            if (!userId || !userEmail) {
                return { status: 400, jsonBody: { error: 'userId and userEmail are required' } };
            }
            
            const invitationsData = await readData('invitations.json');
            const invitations = getInvitationsArray(invitationsData);
            const invitationIndex = invitations.findIndex(i => i.id === id);
            
            if (invitationIndex === -1) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }
            
            const invitation = invitations[invitationIndex];
            
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
                const teamsData = await readData('teams.json');
                const teams = getTeamsArray(teamsData);
                const team = teams.find(t => t.id === invitation.teamId);
                eventId = team?.eventId;
            }
            
            // Get user info
            const usersData = await readData('users.json');
            const users = getUsersArray(usersData);
            const userIndex = users.findIndex(u => u.id === userId);
            
            if (userIndex === -1) {
                return { status: 404, jsonBody: { error: 'User not found' } };
            }
            
            // For team participant invites, update legacy teamId on user
            if (invitation.teamId && (!invitation.role || invitation.role === 'participant')) {
                users[userIndex].teamId = invitation.teamId;
                users[userIndex].updatedAt = new Date().toISOString();
            }
            
            // Fill in first/last name from invitation if user has blank values
            if (invitation.inviteeFirstName && !users[userIndex].firstName) {
                users[userIndex].firstName = invitation.inviteeFirstName;
            }
            if (invitation.inviteeLastName && !users[userIndex].lastName) {
                users[userIndex].lastName = invitation.inviteeLastName;
            }
            
            await writeData('users.json', users);
            
            // Create or update participation for this event
            if (eventId) {
                const participationsData = await readData('participations.json');
                const participations = participationsData.participations || participationsData;
                
                // Determine roles for this invitation
                const inviteRole = invitation.role || 'participant';
                
                // Check if user already has a participation for this event (email + eventId is the unique key)
                let participationIndex = participations.findIndex(
                    p => p.email?.toLowerCase() === userEmail.toLowerCase() && p.eventId === eventId
                );
                
                if (participationIndex === -1) {
                    // Determine hotelPaidBy for judges/committee
                    const initialHotelPaidBy = (inviteRole === 'committee' || inviteRole === 'judge')
                        ? 'committee' : null;

                    // Create new participation with roles[]
                    const newParticipation = {
                        id: uuidv4(),
                        eventId: eventId,
                        email: userEmail.toLowerCase(),
                        userId: userId,
                        roles: [inviteRole],
                        teamId: invitation.teamId || null,
                        isTeamAdmin: false,
                        hotelNights: {},
                        hotelPaidBy: initialHotelPaidBy,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                    participations.push(newParticipation);
                } else {
                    // Update existing participation — add role
                    const existing = participations[participationIndex];
                    if (!existing.roles) existing.roles = [];
                    if (!existing.roles.includes(inviteRole)) {
                        existing.roles.push(inviteRole);
                    }
                    // If team invite, set the team and update teamMemberships
                    if (invitation.teamId && inviteRole === 'participant') {
                        existing.teamId = invitation.teamId;
                        existing.isTeamAdmin = false;
                        // Remove 'interest' role — user is upgrading to full participant
                        const interestIdx = existing.roles.indexOf('interest');
                        if (interestIdx !== -1) {
                            existing.roles.splice(interestIdx, 1);
                            // Track the conversion from interest to participant
                            existing.convertedFrom = 'interest';
                            existing.convertedAt = new Date().toISOString();
                            existing.convertedVia = 'invitation';
                            existing.invitationId = invitation.id;
                        }
                    }
                    // Populate userId/email if missing
                    existing.userId = existing.userId || userId;
                    existing.email = existing.email || userEmail.toLowerCase();
                    existing.updatedAt = new Date().toISOString();
                    participations[participationIndex] = existing;
                }
                
                await writeData('participations.json', { participations });

                // Trigger sequence emails for ALL roles — judges/committee get the same info as participants
                triggerSequenceEmailsForInvite(userId, userEmail, eventId, context)
                    .catch(err => context.log(`Failed sequence emails for ${userEmail}: ${err.message}`));
            }
            
            // Update invitation status
            invitations[invitationIndex].status = 'accepted';
            invitations[invitationIndex].acceptedAt = new Date().toISOString();
            invitations[invitationIndex].acceptedBy = userId;
            await writeData('invitations.json', { invitations });
            
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
            const invitationsData = await readData('invitations.json');
            const invitations = getInvitationsArray(invitationsData);
            const invitationIndex = invitations.findIndex(i => i.id === id);
            
            if (invitationIndex === -1) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }
            
            invitations[invitationIndex].status = 'cancelled';
            invitations[invitationIndex].cancelledAt = new Date().toISOString();
            await writeData('invitations.json', { invitations });
            
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
            const invitationsData = await readData('invitations.json');
            const invitations = getInvitationsArray(invitationsData);
            const invitation = invitations.find(i => i.id === id);
            
            if (!invitation) {
                return { status: 404, jsonBody: { error: 'Invitation not found' } };
            }
            
            if (invitation.status !== 'pending') {
                return { status: 400, jsonBody: { error: 'Can only resend pending invitations' } };
            }
            
            // Extend expiration
            invitation.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            
            // Send email - route by role
            let htmlContent, emailSubject;

            if (invitation.role === 'judge' || invitation.role === 'committee') {
                const result = await buildInvitationEmail(invitation, context);
                if (!result.success) {
                    throw new Error(`${invitation.role} invitation template failed: ${result.reason}`);
                }
                htmlContent = result.htmlContent;
                emailSubject = `Reminder: ${result.subject}`;
            } else {
                // Team/participant invitation — use team-welcome template
                const result = await buildTeamWelcomeEmailForInvitation(invitation, context);
                if (!result.success) {
                    throw new Error(`Team welcome template failed: ${result.reason}`);
                }
                htmlContent = result.htmlContent;
                emailSubject = `Reminder: ${result.subject}`;
            }
            
            await sendEmail({
                to: invitation.email,
                subject: emailSubject,
                htmlContent
            });
            
            invitation.lastResent = new Date().toISOString();
            await writeData('invitations.json', { invitations });
            
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            await logError(context, error);
            context.error('Error resending invitation:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});
