// ACDC Portal - Interest Registration API
const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { sendEmail, processTemplate } = require('../shared/mail');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const { sendInterestAcknowledgmentEmail } = require('../shared/interest-acknowledgment');

const leadsStorage = new Storage('interest-leads');
const eventsStorage = new Storage('events');
const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');
const participationsStorage = new Storage('participations');
const usersStorage = new Storage('users');

// Helper to trigger sequence emails for a recipient (lead or user)
// recipient: { id, email, firstName, userId? } — if userId is set, deliveries are stored with userId instead of leadId
async function triggerSequenceEmailsForLead(lead, event, context) {
    try {
        context.log(`[SEQUENCE] Starting sequence emails for ${lead.email}, event: ${event.name}`);

        const result = {
            sent: 0,
            failed: 0,
            eligible: 0,
            totalCampaigns: 0,
            reason: null
        };

        // Determine recipient identifier for delivery records
        const recipientIdField = lead.userId ? { userId: lead.userId } : { leadId: lead.id };
        
        // Check if event has sequence enabled
        if (!event.sequenceEnabled) {
            context.log(`[SEQUENCE] Sequence not enabled for event ${event.id}`);
            result.reason = 'sequence-disabled';
            return result;
        }
        
        // Check if event has a sequence assigned (backward compatibility)
        if (!event.sequenceId) {
            context.log(`[SEQUENCE] No sequence assigned to event ${event.id}`);
            result.reason = 'no-sequence-assigned';
            return result;
        }
        
        // Get sequence campaigns for this sequence
        const allCampaigns = await campaignsStorage.getAll();
        context.log(`[SEQUENCE] Loaded ${allCampaigns.length} total campaigns`);
        
        const sequenceCampaigns = allCampaigns
            .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence')
            .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

        result.totalCampaigns = sequenceCampaigns.length;

        context.log(`[SEQUENCE] Found ${sequenceCampaigns.length} sequence campaigns for sequence ${event.sequenceId}`);
        
        if (sequenceCampaigns.length === 0) {
            context.log(`[SEQUENCE] No sequence campaigns for event ${event.id}`);
            result.reason = 'no-sequence-campaigns';
            return result;
        }

        // Get existing deliveries for this email
        const existingDeliveries = await deliveriesStorage.getAll();
        const userDeliveries = new Set(
            existingDeliveries
                .filter(d => d.email.toLowerCase() === lead.email.toLowerCase() && d.status === 'sent')
                .map(d => d.campaignId)
        );

        // Filter campaigns that haven't been sent yet
        const campaignsToSend = sequenceCampaigns.filter(campaign => !userDeliveries.has(campaign.id));
        result.eligible = campaignsToSend.length;
        
        if (campaignsToSend.length === 0) {
            context.log(`[SEQUENCE] All emails already sent to ${lead.email}`);
            result.reason = 'already-sent';
            return result;
        }

        context.log(`[SEQUENCE] ${campaignsToSend.length} email(s) to send to ${lead.email}`);

        let sent = 0;

        // If multiple emails to send, combine into one digest email
        if (campaignsToSend.length > 1) {
            context.log(`[SEQUENCE] Combining ${campaignsToSend.length} emails into digest`);
            
            // Create digest email
            const digestSubject = `${event.name} — Your ${campaignsToSend.length} Updates`;
            
            // Build message blocks as HTML table rows
            const messageBlocks = campaignsToSend.map((campaign, index) => `
                  <tr>
                    <td style="padding: 0;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                          <td style="background-color: #1e293b; padding: 14px 40px;">
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                              <tr>
                                <td>
                                  <span style="color: #ffffff; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase;">UPDATE ${index + 1} OF ${campaignsToSend.length}</span>
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

            // Load digest template
            const digestTemplatePath = path.join(__dirname, '../../data/email-templates/sequence-digest.html');
            let digestTemplate = await fs.readFile(digestTemplatePath, 'utf-8');
            const digestContent = processTemplate(digestTemplate, {
                eventName: event.name,
                firstName: lead.firstName || '',
                digestCount: campaignsToSend.length.toString(),
                digestContent: messageBlocks,
                year: new Date().getFullYear().toString()
            });

            const delivery = {
                id: generateGuid(),
                campaignId: campaignsToSend.map(c => c.id).join(','), // Track all campaigns in digest
                email: lead.email,
                ...recipientIdField,
                status: 'pending',
                createdAt: new Date().toISOString(),
                isDigest: true,
                digestCount: campaignsToSend.length
            };

            try {
                context.log(`[SEQUENCE] Sending digest email to ${lead.email}`);
                
                await sendEmail({
                    to: lead.email,
                    subject: digestSubject,
                    htmlContent: digestContent
                });

                context.log(`[SEQUENCE] Digest email sent successfully!`);
                delivery.status = 'sent';
                delivery.sentAt = new Date().toISOString();
                sent = campaignsToSend.length; // Count as all campaigns sent
                result.sent = sent;
                
                // Create individual delivery records for each campaign (for tracking)
                for (const campaign of campaignsToSend) {
                    await deliveriesStorage.create({
                        id: generateGuid(),
                        campaignId: campaign.id,
                        email: lead.email,
                        ...recipientIdField,
                        status: 'sent',
                        sentAt: delivery.sentAt,
                        createdAt: delivery.createdAt,
                        digestId: delivery.id // Link to digest
                    });
                }
            } catch (err) {
                await logError(context, err);
                context.log(`[SEQUENCE] ERROR sending digest email: ${err.message}`);
                context.error(err);
                delivery.status = 'failed';
                delivery.error = err.message;
                result.failed = campaignsToSend.length;
                result.reason = 'send-failed';
            }

            await deliveriesStorage.create(delivery);
        } else {
            // Single email - send normally
            const campaign = campaignsToSend[0];
            context.log(`[SEQUENCE] Sending single email to ${lead.email}: "${campaign.subject}"`);
            
            const delivery = {
                id: generateGuid(),
                campaignId: campaign.id,
                email: lead.email,
                ...recipientIdField,
                status: 'pending',
                createdAt: new Date().toISOString()
            };

            try {
                await sendEmail({
                    to: lead.email,
                    subject: campaign.subject,
                    htmlContent: campaign.content,
                    firstName: lead.firstName || 'Friend',
                    ctaUrl: campaign.ctaUrl,
                    ctaText: campaign.ctaText
                });

                context.log(`[SEQUENCE] Email sent successfully!`);
                delivery.status = 'sent';
                delivery.sentAt = new Date().toISOString();
                sent++;
                result.sent = sent;
            } catch (err) {
                await logError(context, err);
                context.log(`[SEQUENCE] ERROR sending email: ${err.message}`);
                context.error(err);
                delivery.status = 'failed';
                delivery.error = err.message;
                result.failed = 1;
                result.reason = 'send-failed';
            }

            await deliveriesStorage.create(delivery);
        }

        context.log(`[SEQUENCE] COMPLETE: Sent ${sent}/${campaignsToSend.length} sequence emails to ${lead.email} for event ${event.id}`);
        if (result.sent > 0 && !result.reason) {
            result.reason = 'sent';
        }
        return result;
    } catch (error) {
        await logError(context, error);
        // Don't fail the main operation if this fails
        context.log(`[SEQUENCE] WARNING: Failed to trigger sequence emails: ${error.message}`);
        context.error(error);
        return {
            sent: 0,
            failed: 1,
            eligible: 0,
            totalCampaigns: 0,
            reason: 'trigger-error',
            error: error.message
        };
    }
}


// Helper to generate 6-digit verification code
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper to generate GUID
function generateGuid() {
    return uuidv4();
}

// Helper to get verification email HTML from template
async function getVerificationEmailHtml(code, eventName, firstName) {
    const templatePath = path.join(__dirname, '../../data/email-templates/verification.html');
    const template = await fs.readFile(templatePath, 'utf-8');
    return processTemplate(template, {
        code: code,
        eventName: eventName,
        firstName: firstName
    });
}

// POST /api/interest/register - Submit interest (sends verification code)
app.http('interest-register', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'interest/register',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { eventId, email, firstName, lastName } = body;

            if (!eventId || !email || !firstName || !lastName) {
                return { 
                    status: 400, 
                    jsonBody: { error: 'eventId, email, firstName, and lastName are required' } 
                };
            }

            // Validate event exists
            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === eventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            // Generate verification code
            const verificationCode = generateVerificationCode();
            const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

            // Check for existing lead (verified or not) - update with new code
            const allLeads = await leadsStorage.getAll();
            const existingLead = allLeads.find(l =>
                l.eventId === eventId &&
                l.email.toLowerCase() === email.toLowerCase()
            );

            const lead = {
                id: existingLead ? existingLead.id : generateGuid(),
                eventId,
                email: email.toLowerCase(),
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                verificationCode,
                codeExpiresAt,
                verified: existingLead ? existingLead.verified : false,
                verifiedAt: existingLead ? existingLead.verifiedAt : null,
                createdAt: existingLead ? existingLead.createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            if (existingLead) {
                await leadsStorage.update(lead.id, lead);
            } else {
                await leadsStorage.create(lead);
            }

            // Send verification email
            try {
                const verificationHtml = await getVerificationEmailHtml(verificationCode, event.name, firstName);
                await sendEmail({
                    to: email,
                    subject: `Verification Code for ${event.name}`,
                    htmlContent: verificationHtml
                });
                context.log(`Verification email sent to ${email}`);
            } catch (emailError) {
                context.error('Failed to send verification email:', emailError);
                return { 
                    status: 500, 
                    jsonBody: { error: 'Failed to send verification email. Please try again.' } 
                };
            }

            return {
                status: 200,
                jsonBody: { 
                    message: 'Verification code sent to your email',
                    leadId: lead.id
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error registering interest:', error);
            return { status: 500, jsonBody: { error: 'Failed to register interest' } };
        }
    }
});

// POST /api/interest/verify - Verify code and confirm registration
app.http('interest-verify', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'interest/verify',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { leadId, code } = body;

            if (!leadId || !code) {
                return { status: 400, jsonBody: { error: 'leadId and code are required' } };
            }

            const lead = await leadsStorage.getById(leadId);

            if (!lead) {
                return { status: 404, jsonBody: { error: 'Registration not found' } };
            }

            // Check if this email+event combo is already verified by someone else
            // (could happen if they register again with a new request while one is pending)
            const allLeadsForVerify = await leadsStorage.getAll();
            const alreadyVerified = allLeadsForVerify.find(l =>
                l.eventId === lead.eventId &&
                l.email.toLowerCase() === lead.email.toLowerCase() &&
                l.verified &&
                l.id !== lead.id
            );
            
            if (alreadyVerified) {
                return { 
                    status: 200, 
                    jsonBody: { 
                        message: 'You have already registered interest for this event!',
                        alreadyRegistered: true,
                        lead: {
                            firstName: alreadyVerified.firstName,
                            lastName: alreadyVerified.lastName,
                            email: alreadyVerified.email
                        }
                    } 
                };
            }

            if (lead.verified) {
                return { 
                    status: 200, 
                    jsonBody: { 
                        message: 'You have already registered interest for this event!',
                        alreadyRegistered: true,
                        lead: {
                            firstName: lead.firstName,
                            lastName: lead.lastName,
                            email: lead.email
                        }
                    } 
                };
            }

            // Check code expiration
            if (new Date() > new Date(lead.codeExpiresAt)) {
                return { status: 400, jsonBody: { error: 'Verification code has expired. Please request a new one.' } };
            }

            // Check code match
            if (lead.verificationCode !== code.trim()) {
                return { status: 400, jsonBody: { error: 'Invalid verification code' } };
            }

            // Mark as verified
            const verifiedAt = new Date().toISOString();
            const verifiedLead = {
                ...lead,
                verified: true,
                verifiedAt,
                verificationCode: null,
                codeExpiresAt: null
            };

            await leadsStorage.update(leadId, {
                verified: true,
                verifiedAt,
                verificationCode: null,
                codeExpiresAt: null,
                updatedAt: new Date().toISOString()
            });

            context.log(`Interest verified for ${verifiedLead.email}`);

            // Mirror verified interest into participations with roles:['interest']
            try {
                const allPartsForVerify = await participationsStorage.getAll();
                const existingPart = allPartsForVerify.find(p =>
                    p.email?.toLowerCase() === verifiedLead.email.toLowerCase() &&
                    p.eventId === verifiedLead.eventId
                );

                if (existingPart) {
                    // Already has a participation — ensure 'interest' role is present
                    const roles = existingPart.roles || [];
                    if (!roles.includes('interest')) roles.push('interest');
                    await participationsStorage.update(existingPart.id, {
                        roles,
                        interestVerified: true,
                        interestDate: verifiedLead.verifiedAt,
                        interestSource: 'interest-form',
                        updatedAt: new Date().toISOString()
                    });
                } else {
                    // Create new participation (email-only, no userId yet)
                    await participationsStorage.create({
                        id: generateGuid(),
                        email: verifiedLead.email.toLowerCase(),
                        userId: null,
                        eventId: verifiedLead.eventId,
                        roles: ['interest'],
                        teamId: null,
                        isTeamAdmin: false,
                        hotelNights: {},
                        interestVerified: true,
                        interestDate: verifiedLead.verifiedAt,
                        interestSource: 'interest-form',
                        interestFirstName: verifiedLead.firstName,
                        interestLastName: verifiedLead.lastName,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                }
                context.log(`Participation with interest role created/updated for ${verifiedLead.email}`);
            } catch (partError) {
                context.error('Warning: Failed to create interest participation:', partError);
                // Don't fail the main flow
            }

            context.log(`About to trigger sequences for lead:`, { email: verifiedLead.email, eventId: verifiedLead.eventId, firstName: verifiedLead.firstName });
            
            // Fetch event to get sequenceId
            const events = await eventsStorage.getAll();
            context.log(`[SEQUENCE] Loaded ${events.length} events`);
            const event = events.find(e => e.id === verifiedLead.eventId);
            context.log(`[SEQUENCE] Event found:`, event ? { id: event.id, name: event.name, sequenceId: event.sequenceId } : 'NOT FOUND');
            
                // Always send the interest acknowledgment confirmation
            sendInterestAcknowledgmentEmail(verifiedLead.email, verifiedLead.eventId, context)
                .then(r => context.log(`[VERIFY] Interest ack sent: ${r?.reason || 'ok'}`))
                .catch(err => context.error('[VERIFY] Interest ack error:', err));

            // Trigger sequence digest if available
            if (event) {
                try {
                    context.log('[VERIFY] About to call triggerSequenceEmailsForLead');
                    const seqResult = await triggerSequenceEmailsForLead(verifiedLead, event, context);
                    context.log('[VERIFY] triggerSequenceEmailsForLead completed successfully');
                } catch (seqError) {
                    context.error('[VERIFY] ERROR in triggerSequenceEmailsForLead:', seqError);
                    context.error('[VERIFY] Stack:', seqError.stack);
                }
            } else {
                context.log(`Event ${verifiedLead.eventId} not found, skipping sequence emails`);
            }
            
            context.log(`Sequences triggered, returning response`);

            return {
                status: 200,
                jsonBody: { 
                    message: 'Thank you! Your interest has been registered.',
                    lead: {
                        firstName: verifiedLead.firstName,
                        lastName: verifiedLead.lastName,
                        email: verifiedLead.email
                    }
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error verifying interest:', error);
            return { status: 500, jsonBody: { error: 'Failed to verify' } };
        }
    }
});

// POST /api/interest/record - Record interest after authentication (called from unified register page)
// Expects: { eventId, email, firstName, lastName }
// The user has already authenticated via OTP, so no separate verification needed
app.http('interest-record', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'interest/record',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { eventId, email, firstName, lastName } = body;

            if (!eventId || !email) {
                return { status: 400, jsonBody: { error: 'eventId and email are required' } };
            }

            // Validate event exists
            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === eventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            const normalizedEmail = email.toLowerCase().trim();
            const leadFirstName = (firstName || '').trim();
            const leadLastName = (lastName || '').trim();

            // Check for existing lead
            const allLeadsForRecord = await leadsStorage.getAll();
            const existingLead = allLeadsForRecord.find(l =>
                l.eventId === eventId &&
                l.email.toLowerCase() === normalizedEmail
            );

            if (existingLead && existingLead.verified) {
                // Already registered interest — just return success
                return {
                    status: 200,
                    jsonBody: {
                        message: 'You have already registered interest for this event!',
                        alreadyRegistered: true,
                        eventName: event.name
                    }
                };
            }

            // Create or update lead as verified (no separate verification needed — already authenticated)
            const lead = {
                id: existingLead ? existingLead.id : generateGuid(),
                eventId,
                email: normalizedEmail,
                firstName: leadFirstName,
                lastName: leadLastName,
                verificationCode: null,
                codeExpiresAt: null,
                verified: true,
                verifiedAt: new Date().toISOString(),
                createdAt: existingLead ? existingLead.createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            if (existingLead) {
                await leadsStorage.update(lead.id, lead);
            } else {
                await leadsStorage.create(lead);
            }

            context.log(`Interest recorded (authenticated) for ${normalizedEmail} on event ${event.name}`);

            // Mirror into participations with roles:['interest']
            try {
                // Look up user to set userId on participation
                const allUsers = await usersStorage.getAll();
                const user = allUsers.find(u => u.email?.toLowerCase() === normalizedEmail);
                const userId = user ? user.id : null;

                const allPartsForRecord = await participationsStorage.getAll();
                const existingPart = allPartsForRecord.find(p =>
                    p.email?.toLowerCase() === normalizedEmail &&
                    p.eventId === eventId
                );

                if (existingPart) {
                    const roles = existingPart.roles || [];
                    if (!roles.includes('interest')) roles.push('interest');
                    const updates = {
                        roles,
                        interestVerified: true,
                        interestDate: lead.verifiedAt,
                        interestSource: 'unified-register',
                        updatedAt: new Date().toISOString()
                    };
                    // Update userId if we found the user and it wasn't set before
                    if (userId && !existingPart.userId) updates.userId = userId;
                    await participationsStorage.update(existingPart.id, updates);
                } else {
                    await participationsStorage.create({
                        id: generateGuid(),
                        email: normalizedEmail,
                        userId: userId,
                        eventId: eventId,
                        roles: ['interest'],
                        teamId: null,
                        isTeamAdmin: false,
                        hotelNights: {},
                        interestVerified: true,
                        interestDate: lead.verifiedAt,
                        interestSource: 'unified-register',
                        interestFirstName: leadFirstName,
                        interestLastName: leadLastName,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                }
                context.log(`Participation with interest role created/updated for ${normalizedEmail}`);
            } catch (partError) {
                context.error('Warning: Failed to create interest participation:', partError);
            }

            // Always send the interest acknowledgment confirmation
            sendInterestAcknowledgmentEmail(normalizedEmail, eventId, context)
                .then(r => context.log(`[INTEREST-RECORD] Interest ack sent: ${r?.reason || 'ok'}`))
                .catch(err => context.error('[INTEREST-RECORD] Interest ack error:', err));

            // Trigger sequence digest if available
            let seqResult = { sent: 0, reason: null };
            try {
                seqResult = await triggerSequenceEmailsForLead(lead, event, context);
                context.log(`[INTEREST-RECORD] Sequence result: sent=${seqResult.sent}, reason=${seqResult.reason}, campaigns=${seqResult.totalCampaigns}`);
            } catch (seqError) {
                context.error('[INTEREST-RECORD] Sequence email error:', seqError);
            }

            return {
                status: 200,
                jsonBody: {
                    message: 'Thank you! Your interest has been registered.',
                    eventName: event.name,
                    lead: {
                        firstName: leadFirstName,
                        lastName: leadLastName,
                        email: normalizedEmail
                    }
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error recording interest:', error);
            return { status: 500, jsonBody: { error: 'Failed to record interest' } };
        }
    }
});

// GET /api/interest/leads?eventId=xxx - List leads for an event (admin)
app.http('interest-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'interest/leads',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.query.get('eventId');

            let leads = await leadsStorage.getAll();

            // Filter by event if specified
            if (eventId) {
                leads = leads.filter(l => l.eventId === eventId);
            }

            // Only return verified leads (or all if admin needs to see pending)
            const verifiedOnly = request.query.get('verified') !== 'false';
            if (verifiedOnly) {
                leads = leads.filter(l => l.verified);
            }

            // Remove sensitive fields
            const sanitizedLeads = leads.map(l => ({
                id: l.id,
                eventId: l.eventId,
                email: l.email,
                firstName: l.firstName,
                lastName: l.lastName,
                verified: l.verified,
                verifiedAt: l.verifiedAt,
                createdAt: l.createdAt
            }));

            return { status: 200, jsonBody: { leads: sanitizedLeads } };
        } catch (error) {
            await logError(context, error);
            context.error('Error listing leads:', error);
            return { status: 500, jsonBody: { error: 'Failed to list leads' } };
        }
    }
});

// DELETE /api/interest/leads/:id - Delete a lead (admin)
app.http('interest-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'interest/leads/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;

            const lead = await leadsStorage.getById(id);

            if (!lead) {
                return { status: 404, jsonBody: { error: 'Lead not found' } };
            }

            const email = lead.email;

            // Remove the lead (atomic single-row delete)
            await leadsStorage.delete(id);

            // Cascade: clean up email deliveries for this lead
            let cleaned = { deliveries: 0, participations: 0 };
            try {
                const allDeliveries = await deliveriesStorage.getAll();
                const toDeleteDeliveries = allDeliveries.filter(d => {
                    if (d.leadId === id) return true;
                    if (email && d.email?.toLowerCase() === email.toLowerCase() && !d.userId) return true;
                    return false;
                });
                for (const d of toDeleteDeliveries) await deliveriesStorage.delete(d.id);
                cleaned.deliveries = toDeleteDeliveries.length;
            } catch (e) { context.log(`Warning: delivery cleanup failed: ${e.message}`); }

            // Cascade: remove 'interest' role from SQL participations for this lead's email + event
            try {
                const allParts = await participationsStorage.getAll();
                for (const p of allParts) {
                    if (!email || p.email?.toLowerCase() !== email.toLowerCase()) continue;
                    if (lead.eventId && p.eventId !== lead.eventId) continue;
                    const roles = p.roles || [];
                    if (!roles.includes('interest')) continue;
                    if (roles.length === 1) {
                        // Only role was 'interest' — delete the participation entirely
                        await participationsStorage.delete(p.id);
                    } else {
                        // Has other roles — just strip 'interest'
                        await participationsStorage.update(p.id, { roles: roles.filter(r => r !== 'interest') });
                    }
                    cleaned.participations++;
                }
            } catch (e) { context.log(`Warning: participation cleanup failed: ${e.message}`); }

            context.log(`Deleted lead ${id} (${email}). Cleaned: ${cleaned.deliveries} deliveries`);

            return { status: 200, jsonBody: { message: 'Lead deleted', cleaned } };
        } catch (error) {
            await logError(context, error);
            context.error('Error deleting lead:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete lead' } };
        }
    }
});

// POST /api/interest/restart-sequence - Manually trigger sequence for a recipient (lead or user)
app.http('interest-restart-sequence', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'interest/restart-sequence',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            const { leadId, userId, eventId } = body;

            if (!leadId && !userId) {
                return { status: 400, jsonBody: { error: 'leadId or userId is required' } };
            }

            let recipient;
            let recipientEventId;

            if (leadId) {
                // Lead-based restart
                const lead = await leadsStorage.getById(leadId);
                if (!lead) {
                    return { status: 404, jsonBody: { error: 'Lead not found' } };
                }
                if (!lead.verified) {
                    return { status: 400, jsonBody: { error: 'Lead is not verified' } };
                }
                recipient = lead;
                recipientEventId = lead.eventId;
            } else {
                // User-based restart (participants, judges, committee)
                const users = await usersStorage.getAll();
                const user = users.find(u => u.id === userId);
                if (!user) {
                    return { status: 404, jsonBody: { error: 'User not found' } };
                }
                if (!eventId) {
                    return { status: 400, jsonBody: { error: 'eventId is required for user-based restart' } };
                }
                recipient = { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, userId: user.id };
                recipientEventId = eventId;
            }

            context.log(`[RESTART] Manually restarting sequence for ${recipient.email}`);

            // Delete existing delivery records for this recipient to allow resend
            const normalizedEmail = (recipient.email || '').toLowerCase();
            const allDeliveriesForRestart = await deliveriesStorage.getAll();
            const deliveriesToDelete = allDeliveriesForRestart.filter(d => {
                if (leadId) {
                    return d.leadId === leadId || (normalizedEmail && (d.email || '').toLowerCase() === normalizedEmail);
                } else {
                    return d.userId === userId || (normalizedEmail && (d.email || '').toLowerCase() === normalizedEmail);
                }
            });
            for (const d of deliveriesToDelete) await deliveriesStorage.delete(d.id);
            if (deliveriesToDelete.length > 0) {
                context.log(`[RESTART] Deleted ${deliveriesToDelete.length} existing delivery records for ${leadId || userId}`);
            }

            // Fetch event to get sequenceId
            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === recipientEventId);
            context.log(`[RESTART] Event found:`, event ? { id: event.id, name: event.name, sequenceId: event.sequenceId } : 'NOT FOUND');

            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            // Trigger sequence emails
            const triggerResult = await triggerSequenceEmailsForLead(recipient, event, context);

            // Get delivery count after sending
            const updatedDeliveries = await deliveriesStorage.getAll();
            const sentDeliveries = updatedDeliveries
                .filter(d => {
                    if (leadId) return d.leadId === leadId && d.status === 'sent';
                    return d.userId === userId && d.status === 'sent';
                });

            return {
                status: 200,
                jsonBody: {
                    message: 'Sequence restarted',
                    sent: sentDeliveries.length,
                    details: triggerResult,
                    recipient: {
                        email: recipient.email,
                        firstName: recipient.firstName,
                        lastName: recipient.lastName
                    }
                }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error restarting sequence:', error);
            return { status: 500, jsonBody: { error: 'Failed to restart sequence: ' + error.message } };
        }
    }
});

console.log('Interest API loaded');
