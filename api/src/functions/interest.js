const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { Storage } = require('../shared/storage');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const { sendInterestAcknowledgmentEmail } = require('../shared/interest-acknowledgment');
const { sendSequenceDigest } = require('../shared/sequence-digest');

const leadsStorage = new Storage('interest-leads');
const eventsStorage = new Storage('events');

const deliveriesStorage = new Storage('email-deliveries');
const participationsStorage = new Storage('participations');
const usersStorage = new Storage('users');

async function triggerSequenceEmailsForLead(lead, event, context) {
    return sendSequenceDigest({ event, email: lead.email, firstName: lead.firstName }, context);
}

function generateGuid() {
    return uuidv4();
}

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

            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === eventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            const normalizedEmail = email.toLowerCase().trim();
            const leadFirstName = (firstName || '').trim();
            const leadLastName = (lastName || '').trim();

            const allLeadsForRecord = await leadsStorage.getAll();
            const existingLead = allLeadsForRecord.find(l =>
                l.eventId === eventId &&
                l.email.toLowerCase() === normalizedEmail
            );

            if (existingLead && existingLead.verified) {
                return {
                    status: 200,
                    jsonBody: {
                        message: 'You have already registered interest for this event!',
                        alreadyRegistered: true,
                        eventName: event.name
                    }
                };
            }

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

            try {
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

            sendInterestAcknowledgmentEmail(normalizedEmail, eventId, context)
                .then(r => context.log(`[INTEREST-RECORD] Interest ack sent: ${r?.reason || 'ok'}`))
                .catch(err => context.error('[INTEREST-RECORD] Interest ack error:', err));

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

app.http('interest-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'interest/leads',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.query.get('eventId');

            let leads = await leadsStorage.getAll();

            if (eventId) {
                leads = leads.filter(l => l.eventId === eventId);
            }

            const verifiedOnly = request.query.get('verified') !== 'false';
            if (verifiedOnly) {
                leads = leads.filter(l => l.verified);
            }

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

app.http('interest-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'interest/leads/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;

            const lead = await leadsStorage.getById(id);

            if (!lead) {
                return { status: 404, jsonBody: { error: 'Lead not found' } };
            }

            const email = lead.email;

            await leadsStorage.delete(id);

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

            try {
                const allParts = await participationsStorage.getAll();
                for (const p of allParts) {
                    if (!email || p.email?.toLowerCase() !== email.toLowerCase()) continue;
                    if (lead.eventId && p.eventId !== lead.eventId) continue;
                    const roles = p.roles || [];
                    if (!roles.includes('interest')) continue;
                    if (roles.length === 1) {
                        await participationsStorage.delete(p.id);
                    } else {
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

app.http('interest-restart-sequence', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'interest/restart-sequence',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
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

            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === recipientEventId);
            context.log(`[RESTART] Event found:`, event ? { id: event.id, name: event.name, sequenceId: event.sequenceId } : 'NOT FOUND');

            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            const triggerResult = await triggerSequenceEmailsForLead(recipient, event, context);

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
            return { status: 500, jsonBody: { error: 'Failed to restart sequence' } };
        }
    }
});

console.log('Interest API loaded');
