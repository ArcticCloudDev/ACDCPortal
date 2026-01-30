const { app } = require('@azure/functions');
const { readData, writeData } = require('../shared/storage');
const { sendEmail, processTemplate } = require('../shared/mail');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

// Helper to get invitation template
async function getInvitationTemplate() {
    const templatePath = path.join(__dirname, '../../../data/email-templates/invitation.html');
    return await fs.readFile(templatePath, 'utf8');
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

// Create invitation
app.http('invitations-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'invitations',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { email, teamId, inviterId, inviterName, inviterEmail, message } = body;
            
            if (!email || !teamId || !inviterId) {
                return { status: 400, jsonBody: { error: 'email, teamId, and inviterId are required' } };
            }
            
            // Get team info (teams.json is a plain array)
            const teamsData = await readData('teams.json');
            const team = teamsData.find(t => t.id === teamId);
            if (!team) {
                return { status: 404, jsonBody: { error: 'Team not found' } };
            }
            
            // Check if user already exists and is on a team (users.json is a plain array)
            const usersData = await readData('users.json');
            const existingUser = usersData.find(u => u.email.toLowerCase() === email.toLowerCase());
            if (existingUser && existingUser.teamId) {
                return { status: 400, jsonBody: { error: `${email} is already on a team` } };
            }
            
            // Check for existing pending invitation (invitations.json uses {invitations: []} format)
            const invitationsData = await readData('invitations.json');
            const invitations = invitationsData.invitations || invitationsData;
            const existingInvite = invitations.find(
                i => i.email.toLowerCase() === email.toLowerCase() && i.status === 'pending'
            );
            if (existingInvite) {
                return { 
                    status: 409, // Conflict - resource already exists
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
                teamId,
                teamName: team.teamName || team.name,
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
            
            // Send invitation email
            try {
                const template = await getInvitationTemplate();
                const portalUrl = process.env.PORTAL_URL || 'https://yourapp.azurestaticapps.net';
                const acceptUrl = `${portalUrl}?invite=${invitation.id}`;
                
                const htmlContent = processTemplate(template, {
                    firstName: email.split('@')[0], // Best guess at name
                    inviterName: invitation.inviterName,
                    teamName: invitation.teamName,
                    message: invitation.message,
                    acceptUrl: acceptUrl,
                    inviterEmail: invitation.inviterEmail
                });
                
                await sendEmail({
                    to: email,
                    subject: `You're invited to join ${invitation.teamName} - ACDC`,
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
            
            return { 
                status: 200, 
                jsonBody: { ...invitation, isExpired } 
            };
        } catch (error) {
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
            
            // Get team info to find the eventId
            const teamsData = await readData('teams.json');
            const teams = getTeamsArray(teamsData);
            const team = teams.find(t => t.id === invitation.teamId);
            const eventId = team?.eventId || invitation.eventId;
            
            // Add user to team (users.json is a plain array)
            const usersData = await readData('users.json');
            const users = getUsersArray(usersData);
            const userIndex = users.findIndex(u => u.id === userId);
            
            if (userIndex === -1) {
                return { status: 404, jsonBody: { error: 'User not found' } };
            }
            
            // Update user with team
            users[userIndex].teamId = invitation.teamId;
            users[userIndex].updatedAt = new Date().toISOString();
            await writeData('users.json', users);
            
            // Create or update participation for this event
            if (eventId) {
                const participationsData = await readData('participations.json');
                const participations = participationsData.participations || participationsData;
                
                // Check if user already has a participation for this event
                let participationIndex = participations.findIndex(
                    p => p.userId === userId && p.eventId === eventId
                );
                
                if (participationIndex === -1) {
                    // Create new participation
                    const newParticipation = {
                        id: uuidv4(),
                        eventId: eventId,
                        userId: userId,
                        teamMemberships: [{
                            teamId: invitation.teamId,
                            isAdmin: false,
                            isParticipant: true,
                            joinedAt: new Date().toISOString(),
                            invitedBy: invitation.inviterId
                        }],
                        status: 'confirmed',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                    participations.push(newParticipation);
                } else {
                    // Add team membership to existing participation
                    const existingMembership = participations[participationIndex].teamMemberships?.find(
                        m => m.teamId === invitation.teamId
                    );
                    if (!existingMembership) {
                        participations[participationIndex].teamMemberships = participations[participationIndex].teamMemberships || [];
                        participations[participationIndex].teamMemberships.push({
                            teamId: invitation.teamId,
                            isAdmin: false,
                            isParticipant: true,
                            joinedAt: new Date().toISOString(),
                            invitedBy: invitation.inviterId
                        });
                        participations[participationIndex].updatedAt = new Date().toISOString();
                    }
                }
                
                await writeData('participations.json', { participations });
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
                    eventId: eventId
                } 
            };
        } catch (error) {
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
            
            // Send email
            const template = await getInvitationTemplate();
            const portalUrl = process.env.PORTAL_URL || 'https://yourapp.azurestaticapps.net';
            const acceptUrl = `${portalUrl}?invite=${invitation.id}`;
            
            const htmlContent = processTemplate(template, {
                firstName: invitation.email.split('@')[0],
                inviterName: invitation.inviterName,
                teamName: invitation.teamName,
                message: invitation.message,
                acceptUrl: acceptUrl,
                inviterEmail: invitation.inviterEmail
            });
            
            await sendEmail({
                to: invitation.email,
                subject: `Reminder: You're invited to join ${invitation.teamName} - ACDC`,
                htmlContent
            });
            
            invitation.lastResent = new Date().toISOString();
            await writeData('invitations.json', { invitations });
            
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            context.error('Error resending invitation:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});
