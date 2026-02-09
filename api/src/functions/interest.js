// ACDC Portal - Interest Registration API
const { app } = require('@azure/functions');
const { Storage } = require('../shared/storage');
const { sendEmail, processTemplate } = require('../shared/mail');
const fs = require('fs').promises;
const path = require('path');

const leadsStorage = new Storage('interest-leads');
const eventsStorage = new Storage('events');
const campaignsStorage = new Storage('email-campaigns');
const deliveriesStorage = new Storage('email-deliveries');

// Helper to trigger sequence emails for interest leads
async function triggerSequenceEmailsForLead(lead, event, context) {
    try {
        context.log(`[SEQUENCE] Starting sequence emails for ${lead.email}, event: ${event.name}`);
        
        // Check if event has a sequence assigned
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

        let sent = 0;
        for (const campaign of sequenceCampaigns) {
            context.log(`[SEQUENCE] Processing campaign ${campaign.id}, order ${campaign.sequenceOrder}`);
            
            // Skip if already sent
            if (userDeliveries.has(campaign.id)) {
                context.log(`[SEQUENCE] Skipping campaign ${campaign.id} - already sent`);
                continue;
            }

            const delivery = {
                id: 'del_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6),
                campaignId: campaign.id,
                email: lead.email,
                leadId: lead.id,
                status: 'pending',
                createdAt: new Date().toISOString()
            };

            try {
                context.log(`[SEQUENCE] Sending email to ${lead.email}: "${campaign.subject}"`);
                
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
                context.log(`Failed to send sequence email to ${lead.email}: ${err.message}`);
            }

            deliveryData.deliveries.push(delivery);
        }

        if (deliveryData.deliveries.length > 0) {
            await deliveriesStorage.saveRaw(deliveryData);
        }

        context.log(`[SEQUENCE] COMPLETE: Sent ${sent}/${sequenceCampaigns.length} sequence emails to ${lead.email} for event ${event.id}`);
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
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Helper to get verification email HTML
function getVerificationEmailHtml(code, eventName, firstName) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" width="500" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <tr>
                        <td style="background: linear-gradient(135deg, #1a365d 0%, #2d4a6f 50%, #3b82f6 100%); padding: 30px; text-align: center;">
                            <h1 style="color: #ffffff; margin: 0; font-size: 22px;">Verify Your Interest</h1>
                            <p style="color: #93c5fd; margin: 8px 0 0; font-size: 14px;">${eventName}</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 30px; text-align: center;">
                            <p style="color: #334155; font-size: 16px; margin: 0 0 20px;">
                                Hi ${firstName},<br>
                                Use this code to verify your interest registration:
                            </p>
                            <div style="background: #f1f5f9; border-radius: 8px; padding: 20px; margin: 20px 0;">
                                <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a365d;">${code}</span>
                            </div>
                            <p style="color: #64748b; font-size: 14px; margin: 20px 0 0;">
                                This code expires in 15 minutes.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="background-color: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
                            <p style="color: #94a3b8; font-size: 12px; margin: 0;">Arctic Cloud Developer Challenge</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
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
                await sendEmail({
                    to: email,
                    subject: `Verification Code for ${event.name}`,
                    htmlContent: getVerificationEmailHtml(verificationCode, event.name, firstName)
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

            return { status: 200, jsonBody: sanitizedLeads };
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

            leads.splice(leadIndex, 1);
            await leadsStorage.saveRaw({ leads });

            return { status: 200, jsonBody: { message: 'Lead deleted' } };
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

            // Get delivery count
            const deliveryData = await deliveriesStorage.getRaw();
            const leadDeliveries = (deliveryData?.deliveries || [])
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
