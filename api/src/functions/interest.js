// ACDC Portal - Interest Registration API
const { app } = require('@azure/functions');
const { Storage } = require('../shared/storage');
const { sendEmail, processTemplate } = require('../shared/mail');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const leadsStorage = new Storage('interest-leads');
const eventsStorage = new Storage('events');
const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');
const participationsStorage = new Storage('participations');

// Helper to trigger sequence emails for interest leads
async function triggerSequenceEmailsForLead(lead, event, context) {
    try {
        context.log(`[SEQUENCE] Starting sequence emails for ${lead.email}, event: ${event.name}`);
        
        // Check if event has sequence enabled
        if (!event.sequenceEnabled) {
            context.log(`[SEQUENCE] Sequence not enabled for event ${event.id}`);
            return;
        }
        
        // Check if event has a sequence assigned (backward compatibility)
        if (!event.sequenceId) {
            context.log(`[SEQUENCE] No sequence assigned to event ${event.id}`);
            return;
        }
        
        // Get sequence campaigns for this sequence
        const campaignData = await campaignsStorage.getRaw();
        context.log(`[SEQUENCE] Loaded ${campaignData?.campaigns?.length || 0} total campaigns`);
        
        const sequenceCampaigns = (campaignData?.campaigns || [])
            .filter(c => c.sequenceId === event.sequenceId && c.type === 'sequence')
            .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

        context.log(`[SEQUENCE] Found ${sequenceCampaigns.length} sequence campaigns for sequence ${event.sequenceId}`);
        
        if (sequenceCampaigns.length === 0) {
            context.log(`[SEQUENCE] No sequence campaigns for event ${event.id}`);
            return;
        }

        // Get existing deliveries for this email
        const deliveryData = await deliveriesStorage.getRaw() || { deliveries: [] };
        const userDeliveries = new Set(
            deliveryData.deliveries
                .filter(d => d.email.toLowerCase() === lead.email.toLowerCase() && d.status === 'sent')
                .map(d => d.campaignId)
        );

        // Filter campaigns that haven't been sent yet
        const campaignsToSend = sequenceCampaigns.filter(campaign => !userDeliveries.has(campaign.id));
        
        if (campaignsToSend.length === 0) {
            context.log(`[SEQUENCE] All emails already sent to ${lead.email}`);
            return;
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
                          <td style="padding: 28px 40px 32px 40px; color: #334155; font-size: 15px; line-height: 1.75;">
                            ${campaign.content}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
            `).join('');

            // Load digest template
            const digestTemplatePath = path.join(__dirname, '../../../data/email-templates/sequence-digest.html');
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
                leadId: lead.id,
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
                
                // Create individual delivery records for each campaign (for tracking)
                for (const campaign of campaignsToSend) {
                    deliveryData.deliveries.push({
                        id: generateGuid(),
                        campaignId: campaign.id,
                        email: lead.email,
                        leadId: lead.id,
                        status: 'sent',
                        sentAt: delivery.sentAt,
                        createdAt: delivery.createdAt,
                        digestId: delivery.id // Link to digest
                    });
                }
            } catch (err) {
                context.log(`[SEQUENCE] ERROR sending digest email: ${err.message}`);
                context.error(err);
                delivery.status = 'failed';
                delivery.error = err.message;
            }

            deliveryData.deliveries.push(delivery);
        } else {
            // Single email - send normally
            const campaign = campaignsToSend[0];
            context.log(`[SEQUENCE] Sending single email to ${lead.email}: "${campaign.subject}"`);
            
            const delivery = {
                id: generateGuid(),
                campaignId: campaign.id,
                email: lead.email,
                leadId: lead.id,
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
            } catch (err) {
                context.log(`[SEQUENCE] ERROR sending email: ${err.message}`);
                context.error(err);
                delivery.status = 'failed';
                delivery.error = err.message;
            }

            deliveryData.deliveries.push(delivery);
        }

        if (deliveryData.deliveries.length > 0) {
            await deliveriesStorage.saveRaw(deliveryData);
        }

        context.log(`[SEQUENCE] COMPLETE: Sent ${sent}/${campaignsToSend.length} sequence emails to ${lead.email} for event ${event.id}`);
    } catch (error) {
        // Don't fail the main operation if this fails
        context.log(`[SEQUENCE] WARNING: Failed to trigger sequence emails: ${error.message}`);
        context.error(error);
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
    const templatePath = path.join(__dirname, '../../../data/email-templates/verification.html');
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
            const data = await leadsStorage.getRaw();
            const leads = data.leads || [];
            const existingIndex = leads.findIndex(l => 
                l.eventId === eventId && 
                l.email.toLowerCase() === email.toLowerCase()
            );

            const lead = {
                id: existingIndex >= 0 ? leads[existingIndex].id : generateGuid(),
                eventId,
                email: email.toLowerCase(),
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                verificationCode,
                codeExpiresAt,
                verified: existingIndex >= 0 ? leads[existingIndex].verified : false,
                verifiedAt: existingIndex >= 0 ? leads[existingIndex].verifiedAt : null,
                createdAt: existingIndex >= 0 ? leads[existingIndex].createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            if (existingIndex >= 0) {
                leads[existingIndex] = lead;
            } else {
                leads.push(lead);
            }

            await leadsStorage.saveRaw({ leads });

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

            const data = await leadsStorage.getRaw();
            const leads = data.leads || [];
            const leadIndex = leads.findIndex(l => l.id === leadId);

            if (leadIndex < 0) {
                return { status: 404, jsonBody: { error: 'Registration not found' } };
            }

            const lead = leads[leadIndex];

            // Check if this email+event combo is already verified by someone else
            // (could happen if they register again with a new request while one is pending)
            const alreadyVerified = leads.find(l => 
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
            const verifiedLead = {
                ...lead,
                verified: true,
                verifiedAt: new Date().toISOString(),
                verificationCode: null, // Clear the code
                codeExpiresAt: null
            };
            
            leads[leadIndex] = verifiedLead;

            await leadsStorage.saveRaw({ leads });

            context.log(`Interest verified for ${verifiedLead.email}`);

            // Mirror verified interest into participations with roles:['interest']
            try {
                const partData = await participationsStorage.getRaw();
                const participations = partData?.participations || [];
                const existingPart = participations.findIndex(p =>
                    p.email?.toLowerCase() === verifiedLead.email.toLowerCase() &&
                    p.eventId === verifiedLead.eventId
                );

                if (existingPart >= 0) {
                    // Already has a participation — ensure 'interest' role is present
                    if (!participations[existingPart].roles) participations[existingPart].roles = [];
                    if (!participations[existingPart].roles.includes('interest')) {
                        participations[existingPart].roles.push('interest');
                    }
                    participations[existingPart].interestVerified = true;
                    participations[existingPart].interestDate = verifiedLead.verifiedAt;
                    participations[existingPart].interestSource = 'interest-form';
                    participations[existingPart].updatedAt = new Date().toISOString();
                } else {
                    // Create new participation (email-only, no userId yet)
                    participations.push({
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
                        teamMemberships: [],
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                }

                await participationsStorage.saveRaw({ participations });
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
            
            if (event) {
                // Trigger sequence emails for this lead using the verified lead object
                try {
                    context.log('[VERIFY] About to call triggerSequenceEmailsForLead');
                    await triggerSequenceEmailsForLead(verifiedLead, event, context);
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
            const data = await leadsStorage.getRaw();
            const leads = data.leads || [];
            const existingIndex = leads.findIndex(l =>
                l.eventId === eventId &&
                l.email.toLowerCase() === normalizedEmail
            );

            if (existingIndex >= 0 && leads[existingIndex].verified) {
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
                id: existingIndex >= 0 ? leads[existingIndex].id : generateGuid(),
                eventId,
                email: normalizedEmail,
                firstName: leadFirstName,
                lastName: leadLastName,
                verificationCode: null,
                codeExpiresAt: null,
                verified: true,
                verifiedAt: new Date().toISOString(),
                createdAt: existingIndex >= 0 ? leads[existingIndex].createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            if (existingIndex >= 0) {
                leads[existingIndex] = lead;
            } else {
                leads.push(lead);
            }
            await leadsStorage.saveRaw({ leads });

            context.log(`Interest recorded (authenticated) for ${normalizedEmail} on event ${event.name}`);

            // Mirror into participations with roles:['interest']
            try {
                // Look up user to set userId on participation
                const user = Storage.users.getByEmail(normalizedEmail);
                const userId = user ? user.id : null;

                const partData = await participationsStorage.getRaw();
                const participations = partData?.participations || [];
                const existingPart = participations.findIndex(p =>
                    p.email?.toLowerCase() === normalizedEmail &&
                    p.eventId === eventId
                );

                if (existingPart >= 0) {
                    if (!participations[existingPart].roles) participations[existingPart].roles = [];
                    if (!participations[existingPart].roles.includes('interest')) {
                        participations[existingPart].roles.push('interest');
                    }
                    // Update userId if we found the user and it wasn't set before
                    if (userId && !participations[existingPart].userId) {
                        participations[existingPart].userId = userId;
                    }
                    participations[existingPart].interestVerified = true;
                    participations[existingPart].interestDate = lead.verifiedAt;
                    participations[existingPart].interestSource = 'unified-register';
                    participations[existingPart].updatedAt = new Date().toISOString();
                } else {
                    participations.push({
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
                        teamMemberships: [],
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                }

                await participationsStorage.saveRaw({ participations });
                context.log(`Participation with interest role created/updated for ${normalizedEmail}`);
            } catch (partError) {
                context.error('Warning: Failed to create interest participation:', partError);
            }

            // Trigger sequence emails
            try {
                await triggerSequenceEmailsForLead(lead, event, context);
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
            context.error('Error recording interest:', error);
            return { status: 500, jsonBody: { error: 'Failed to record interest' } };
        }
    }
});

// GET /api/interest/leads?eventId=xxx - List leads for an event (admin)
app.http('interest-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'interest/leads',
    handler: async (request, context) => {
        try {
            const eventId = request.query.get('eventId');

            const data = await leadsStorage.getRaw();
            let leads = data.leads || [];

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
            context.error('Error listing leads:', error);
            return { status: 500, jsonBody: { error: 'Failed to list leads' } };
        }
    }
});

// DELETE /api/interest/leads/:id - Delete a lead (admin)
app.http('interest-delete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'interest/leads/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;

            const data = await leadsStorage.getRaw();
            const leads = data.leads || [];
            const leadIndex = leads.findIndex(l => l.id === id);

            if (leadIndex < 0) {
                return { status: 404, jsonBody: { error: 'Lead not found' } };
            }

            const lead = leads[leadIndex];
            const email = lead.email;

            // Remove the lead
            leads.splice(leadIndex, 1);
            await leadsStorage.saveRaw({ leads });

            // Cascade: clean up email deliveries for this lead
            let cleaned = { deliveries: 0, participations: 0 };
            try {
                const delData = await deliveriesStorage.getRaw() || { deliveries: [] };
                const deliveries = delData.deliveries || [];
                const before = deliveries.length;
                const filtered = deliveries.filter(d => {
                    if (d.leadId === id) return false;
                    if (email && d.email?.toLowerCase() === email.toLowerCase() && !d.userId) return false;
                    return true;
                });
                if (filtered.length < before) {
                    cleaned.deliveries = before - filtered.length;
                    await deliveriesStorage.saveRaw({ deliveries: filtered });
                }
            } catch (e) { context.log(`Warning: delivery cleanup failed: ${e.message}`); }

            // Cascade: clean up interest-only participations for this email
            try {
                const partData = await participationsStorage.getRaw() || { participations: [] };
                const participations = partData.participations || [];
                const beforePart = participations.length;
                const filteredPart = participations.filter(p => {
                    if (email && p.email?.toLowerCase() === email.toLowerCase() &&
                        p.roles?.length === 1 && p.roles[0] === 'interest') return false;
                    return true;
                });
                if (filteredPart.length < beforePart) {
                    cleaned.participations = beforePart - filteredPart.length;
                    await participationsStorage.saveRaw({ participations: filteredPart });
                }
            } catch (e) { context.log(`Warning: participation cleanup failed: ${e.message}`); }

            context.log(`Deleted lead ${id} (${email}). Cleaned: ${cleaned.deliveries} deliveries`);

            return { status: 200, jsonBody: { message: 'Lead deleted', cleaned } };
        } catch (error) {
            context.error('Error deleting lead:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete lead' } };
        }
    }
});

// POST /api/interest/restart-sequence - Manually trigger sequence for a lead
app.http('interest-restart-sequence', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'interest/restart-sequence',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { leadId } = body;

            if (!leadId) {
                return { status: 400, jsonBody: { error: 'leadId is required' } };
            }

            // Get lead
            const data = await leadsStorage.getRaw();
            const lead = (data.leads || []).find(l => l.id === leadId);

            if (!lead) {
                return { status: 404, jsonBody: { error: 'Lead not found' } };
            }

            if (!lead.verified) {
                return { status: 400, jsonBody: { error: 'Lead is not verified' } };
            }

            context.log(`[RESTART] Manually restarting sequence for ${lead.email}`);

            // Delete existing delivery records for this lead to allow resend
            const deliveryData = await deliveriesStorage.getRaw() || { deliveries: [] };
            const beforeCount = deliveryData.deliveries.length;
            deliveryData.deliveries = deliveryData.deliveries.filter(d => d.leadId !== leadId);
            const removedCount = beforeCount - deliveryData.deliveries.length;
            
            if (removedCount > 0) {
                await deliveriesStorage.saveRaw(deliveryData);
                context.log(`[RESTART] Deleted ${removedCount} existing delivery records for lead ${leadId}`);
            }

            // Fetch event to get sequenceId
            const events = await eventsStorage.getAll();
            context.log(`[RESTART] Loaded ${events.length} events`);
            const event = events.find(e => e.id === lead.eventId);
            context.log(`[RESTART] Event found:`, event ? { id: event.id, name: event.name, sequenceId: event.sequenceId } : 'NOT FOUND');

            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found for this lead' } };
            }

            // Trigger sequence emails
            await triggerSequenceEmailsForLead(lead, event, context);

            // Get delivery count after sending
            const updatedDeliveryData = await deliveriesStorage.getRaw();
            const leadDeliveries = (updatedDeliveryData?.deliveries || [])
                .filter(d => d.leadId === leadId && d.status === 'sent');

            return {
                status: 200,
                jsonBody: {
                    message: 'Sequence restarted',
                    sent: leadDeliveries.length,
                    lead: {
                        email: lead.email,
                        firstName: lead.firstName,
                        lastName: lead.lastName
                    }
                }
            };
        } catch (error) {
            context.error('Error restarting sequence:', error);
            return { status: 500, jsonBody: { error: 'Failed to restart sequence: ' + error.message } };
        }
    }
});

console.log('Interest API loaded');
