const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const Storage = require('../shared/storage');
const { Storage: GenericStorage } = require('../shared/storage');
const { generateId, isGuid } = require('../shared/id');
const { Validator, readJson, INVALID_JSON } = require('../shared/validate');

const { sendInterestAcknowledgmentEmail } = require('../shared/interest-acknowledgment');
const { sendSequenceDigest } = require('../shared/sequence-digest');

const leadsStorage = new GenericStorage('interest-leads');
const deliveriesStorage = new GenericStorage('email-deliveries');
const participationsStorage = new GenericStorage('participations');

const INTEREST_STATUSES = ['pre-registration', 'registration'];

async function triggerSequenceEmailsForLead(lead, event, context) {
    return sendSequenceDigest({ event, email: lead.email, firstName: lead.firstName }, context);
}

app.http('interest-record', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'interest/record',
    handler: async (request, context) => {
        try {
            // Interest is recorded for the signed-in person only: the OTP session proves the email.
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await readJson(request);
            if (!body) return INVALID_JSON;
            const { eventId, email, firstName, lastName } = body;

            if (!eventId || !email) {
                return { status: 400, jsonBody: { error: 'eventId and email are required' } };
            }

            const v = new Validator();
            const cleanEventId = v.guid(eventId, 'eventId', { required: true });
            const normalizedEmail = v.email(email, 'email');
            const leadFirstName = v.string(firstName, 'firstName', { max: 100 }) || '';
            const leadLastName = v.string(lastName, 'lastName', { max: 100 }) || '';
            if (v.failed) return v.failure();

            if (!auth.user.email || auth.user.email.toLowerCase() !== normalizedEmail) {
                return { status: 403, jsonBody: { error: 'You can only register interest for your own email address' } };
            }

            const event = await Storage.events.getById(cleanEventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }
            if (!INTEREST_STATUSES.includes(event.status)) {
                return { status: 400, jsonBody: { error: 'Interest registration is not open for this event' } };
            }

            const existingLead = await leadsStorage.findOneBy({ eventId: cleanEventId, email: normalizedEmail });

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
                id: existingLead ? existingLead.id : generateId(),
                eventId: cleanEventId,
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

            context.log(`Interest recorded for event ${event.id}`);

            try {
                const user = await Storage.users.getByEmail(normalizedEmail);
                const userId = user ? user.id : null;

                const existingPart = await participationsStorage.findOneBy({ email: normalizedEmail, eventId: cleanEventId })
                    || (userId ? await participationsStorage.findOneBy({ userId, eventId: cleanEventId }) : undefined);

                if (existingPart) {
                    const roles = existingPart.roles || [];
                    if (!roles.includes('interest')) roles.push('interest');
                    const updates = { roles, updatedAt: new Date().toISOString() };
                    if (userId && !existingPart.userId) updates.userId = userId;
                    await participationsStorage.update(existingPart.id, updates);
                } else {
                    await participationsStorage.create({
                        id: generateId(),
                        email: normalizedEmail,
                        userId: userId,
                        eventId: cleanEventId,
                        roles: ['interest'],
                        teamId: null,
                        isTeamAdmin: false,
                        hotelNights: {},
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                }
            } catch (partError) {
                await logError(context, partError);
                context.error('Warning: Failed to create interest participation:', partError);
            }

            sendInterestAcknowledgmentEmail(normalizedEmail, cleanEventId, context)
                .then(r => context.log(`[INTEREST-RECORD] Interest ack: ${r?.reason || 'ok'}`))
                .catch(err => context.error('[INTEREST-RECORD] Interest ack error:', err));

            try {
                const seqResult = await triggerSequenceEmailsForLead(lead, event, context);
                context.log(`[INTEREST-RECORD] Sequence result: sent=${seqResult?.sent}, reason=${seqResult?.reason}`);
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
            if (eventId && !isGuid(eventId)) {
                return { status: 400, jsonBody: { error: 'Invalid event ID' } };
            }

            let leads = eventId ? await leadsStorage.findBy({ eventId }) : await leadsStorage.getAll();

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
                const byLead = await deliveriesStorage.findBy({ leadId: id });
                const byEmail = email ? (await deliveriesStorage.findBy({ email })).filter(d => !d.userId) : [];
                const seen = new Set();
                for (const d of [...byLead, ...byEmail]) {
                    const key = String(d.id).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    await deliveriesStorage.delete(d.id);
                    cleaned.deliveries++;
                }
            } catch (e) { context.log(`Warning: delivery cleanup failed: ${e.message}`); }

            try {
                const parts = email ? await participationsStorage.findBy({ email, eventId: lead.eventId || undefined }) : [];
                for (const p of parts) {
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

            context.log(`Deleted lead ${id}. Cleaned: ${cleaned.deliveries} deliveries, ${cleaned.participations} participations`);

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

            const body = await readJson(request);
            if (!body) return INVALID_JSON;
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
                const user = await Storage.users.getById(userId);
                if (!user) {
                    return { status: 404, jsonBody: { error: 'User not found' } };
                }
                if (!eventId || !isGuid(eventId)) {
                    return { status: 400, jsonBody: { error: 'eventId is required for user-based restart' } };
                }
                recipient = { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, userId: user.id };
                recipientEventId = eventId;
            }

            const normalizedEmail = (recipient.email || '').toLowerCase();
            const deliveriesToDelete = [
                ...(leadId ? await deliveriesStorage.findBy({ leadId }) : await deliveriesStorage.findBy({ userId })),
                ...(normalizedEmail ? await deliveriesStorage.findBy({ email: normalizedEmail }) : [])
            ];
            const seen = new Set();
            let deletedCount = 0;
            for (const d of deliveriesToDelete) {
                const key = String(d.id).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                await deliveriesStorage.delete(d.id);
                deletedCount++;
            }
            if (deletedCount > 0) {
                context.log(`[RESTART] Deleted ${deletedCount} existing delivery records`);
            }

            const event = await Storage.events.getById(recipientEventId);
            if (!event) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }

            const triggerResult = await triggerSequenceEmailsForLead(recipient, event, context);

            const updatedDeliveries = leadId
                ? await deliveriesStorage.findBy({ leadId })
                : await deliveriesStorage.findBy({ userId });
            const sentDeliveries = updatedDeliveries.filter(d => d.status === 'sent');

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
