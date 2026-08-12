// ACDC Portal - Events API
const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const StorageModule = require('../shared/storage');
const { Storage } = StorageModule;
const { getPool, sql } = require('../shared/sql');
const { listByEvent, createManual, updateManual, updatePaidBy, deleteManual, getSummary, syncParticipationToFinancials } = require('../shared/event-financials');

const eventsStorage = new Storage('events');
const teamsStorage = new Storage('teams');
const participationsStorage = new Storage('participations');

// Helper to generate GUID
function generateGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Helper to check if event status means it's active (visible to public)
function isActiveStatus(status) {
    return status === 'pre-registration' || status === 'registration' || status === 'live';
}

// Helper to check if registration is open based on status
function isRegistrationOpen(status) {
    return status === 'registration';
}

// Helper to generate hotel dates (1 day before start to 1 day after end)
function generateHotelDates(startDate, endDate, daysBefore = 0, daysAfter = 0) {
    const dates = [];
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayLabelsFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    // Use noon to avoid timezone date-shifting (YYYY-MM-DD parsed as UTC midnight can shift)
    const start = new Date(startDate + 'T12:00:00');
    start.setDate(start.getDate() - Math.max(0, daysBefore));
    
    const end = new Date(endDate + 'T12:00:00');
    end.setDate(end.getDate() + Math.max(0, daysAfter));
    
    // Generate dates
    const current = new Date(start);
    while (current <= end) {
        const y = current.getFullYear();
        const m = String(current.getMonth() + 1).padStart(2, '0');
        const d = String(current.getDate()).padStart(2, '0');
        const dateStr = `${y}-${m}-${d}`;
        const dayOfWeek = current.getDay();
        dates.push({
            date: dateStr,
            dayLabel: dayLabels[dayOfWeek],
            dayLabelFull: dayLabelsFull[dayOfWeek]
        });
        current.setDate(current.getDate() + 1);
    }
    
    return dates;
}

// Helper to generate default hotel nights (nights during the event, excluding night before)
function generateDefaultHotelNights(hotelDates, eventStartDate, eventEndDate) {
    const defaults = [];
    const dayLabels = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    
    // Use noon to avoid timezone issues
    const eventStart = new Date(eventStartDate + 'T12:00:00');
    const eventEnd = new Date(eventEndDate + 'T12:00:00');
    
    for (let i = 0; i < hotelDates.length - 1; i++) {
        const currentDate = new Date(hotelDates[i].date + 'T12:00:00');
        const nextDate = new Date(hotelDates[i + 1].date + 'T12:00:00');
        
        // Skip the night before the event starts (day before -> first day)
        if (currentDate < eventStart) {
            continue;
        }
        
        // Include nights strictly within the event (first day up to but not including end day).
        // Nights before the event or on/after the event end date are extra — not defaults.
        if (currentDate >= eventStart && currentDate < eventEnd) {
            const fromDay = dayLabels[currentDate.getDay()];
            const toDay = dayLabels[nextDate.getDay()];
            defaults.push(`${fromDay}-${toDay}`);
        }
    }
    
    return defaults;
}

// GET /api/events - List all events
app.http('events-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events',
    handler: async (request, context) => {
        try {
            const events = await eventsStorage.getAll();
            return {
                status: 200,
                jsonBody: events
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error listing events:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to list events' }
            };
        }
    }
});

// GET /api/events/{id}/image - REMOVED (no longer used)

// GET /api/events/active - Get active event
app.http('events-active', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/active',
    handler: async (request, context) => {
        try {
            const events = await eventsStorage.getAll();
            // Find event with active status (registration or live)
            const activeEvent = events.find(e => isActiveStatus(e.status));
            
            if (!activeEvent) {
                return {
                    status: 404,
                    jsonBody: { error: 'No active event found' }
                };
            }
            
            const { eventImageData, ...activeEventPublic } = activeEvent;
            return {
                status: 200,
                jsonBody: activeEvent
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting active event:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get active event' }
            };
        }
    }
});

// GET /api/events/:id - Get event by ID (loads child tables incl. hotelDefaultNights)
app.http('events-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const event = await StorageModule.events.getById(id);
            
            if (!event) {
                return {
                    status: 404,
                    jsonBody: { error: 'Event not found' }
                };
            }
            
            return {
                status: 200,
                jsonBody: event
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error getting event:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get event' }
            };
        }
    }
});

// Sponsor helper: map a sponsorship row from EventFinancials to the API shape
function mapSponsorFinancial(row) {
    return {
        id: row.Id,
        eventId: row.EventId,
        companyName: row.Description,
        contactPerson: row.ContactPerson || null,
        phoneNumber: row.PhoneNumber || null,
        email: row.ContactEmail || null,
        amount: row.Amount == null ? null : Number(row.Amount),
        sponsorStatus: row.SponsorStatus || 'reached-out',
        notes: row.Notes || null,
        paidBy: row.PaidBy,
        source: row.Source,
        createdAt: row.CreatedAt instanceof Date ? row.CreatedAt.toISOString() : row.CreatedAt,
        updatedAt: row.UpdatedAt instanceof Date ? row.UpdatedAt.toISOString() : (row.UpdatedAt || null)
    };
}

function normalizeSponsorPayload(body = {}, { isUpdate = false } = {}) {
    const payload = {};
    const has = (k) => !isUpdate || Object.prototype.hasOwnProperty.call(body, k);

    if (has('companyName')) {
        const v = (body.companyName || '').toString().trim();
        if (!v) throw new Error('companyName is required');
        payload.description = v;
    }
    if (has('contactPerson'))  payload.contactPerson  = body.contactPerson  ? body.contactPerson.toString().trim()                    : null;
    if (has('phoneNumber'))    payload.phoneNumber    = body.phoneNumber    ? body.phoneNumber.toString().trim()                      : null;
    if (has('email'))          payload.contactEmail   = body.email          ? body.email.toString().trim().toLowerCase()              : null;
    if (has('notes'))          payload.notes          = body.notes          ? body.notes.toString().trim()                            : null;
    if (has('amount')) {
        const raw = body.amount;
        if (raw === '' || raw == null) { payload.amount = 0; }
        else {
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0) throw new Error('amount must be a non-negative number');
            payload.amount = n;
        }
    }
    if (has('sponsorStatus') || has('status')) {
        const validStatuses = new Set(['reached-out', 'negotiating', 'declined', 'confirmed']);
        const s = ((body.sponsorStatus || body.status) || 'reached-out').toString().trim().toLowerCase();
        if (!validStatuses.has(s)) throw new Error('Invalid sponsor status');
        payload.sponsorStatus = s;
    }
    return payload;
}

// GET /api/events/{eventId}/sponsors - List event sponsors (filtered view of EventFinancials)
app.http('event-sponsors-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'events/{eventId}/sponsors',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const pool = await getPool();
            const result = await pool.request()
                .input('eventId', sql.UniqueIdentifier, eventId)
                .query(`
                    SELECT * FROM EventFinancials
                    WHERE EventId = @eventId AND Category = 'sponsorship'
                    ORDER BY
                        CASE SponsorStatus WHEN 'confirmed' THEN 1 WHEN 'negotiating' THEN 2 WHEN 'reached-out' THEN 3 WHEN 'declined' THEN 4 ELSE 5 END,
                        Description ASC
                `);
            return { status: 200, jsonBody: result.recordset.map(mapSponsorFinancial) };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: error.message || 'Failed to list sponsors' } };
        }
    }
});

// POST /api/events/{eventId}/sponsors - Create sponsor
app.http('event-sponsors-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events/{eventId}/sponsors',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const body = await request.json();
            const payload = normalizeSponsorPayload(body);
            const id = generateGuid();
            const pool = await getPool();

            await pool.request()
                .input('id',            sql.UniqueIdentifier,  id)
                .input('eventId',       sql.UniqueIdentifier,  eventId)
                .input('description',   sql.NVarChar(200),     payload.description)
                .input('amount',        sql.Decimal(12, 2),    payload.amount ?? 0)
                .input('contactPerson', sql.NVarChar(200),     payload.contactPerson ?? null)
                .input('phoneNumber',   sql.NVarChar(50),      payload.phoneNumber   ?? null)
                .input('contactEmail',  sql.NVarChar(320),     payload.contactEmail  ?? null)
                .input('sponsorStatus', sql.NVarChar(30),      payload.sponsorStatus ?? 'reached-out')
                .input('notes',         sql.NVarChar(sql.MAX), payload.notes         ?? null)
                .query(`
                    INSERT INTO EventFinancials
                      (Id, EventId, Type, Category, Description, Amount, PaidBy, Source,
                       ContactPerson, PhoneNumber, ContactEmail, SponsorStatus, Notes)
                    VALUES
                      (@id, @eventId, 'income', 'sponsorship', @description, @amount, 'event', 'manual',
                       @contactPerson, @phoneNumber, @contactEmail, @sponsorStatus, @notes)
                `);

            const row = await pool.request()
                .input('id', sql.UniqueIdentifier, id)
                .query('SELECT * FROM EventFinancials WHERE Id = @id');
            return { status: 201, jsonBody: mapSponsorFinancial(row.recordset[0]) };
        } catch (error) {
            const status = /required|Invalid sponsor|amount must/i.test(error.message) ? 400 : 500;
            if (status === 500) await logError(context, error);
            return { status, jsonBody: { error: error.message || 'Failed to create sponsor' } };
        }
    }
});

// PUT /api/events/{eventId}/sponsors/{sponsorId} - Update sponsor
app.http('event-sponsors-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'events/{eventId}/sponsors/{sponsorId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, sponsorId } = request.params;
            const body = await request.json();
            const payload = normalizeSponsorPayload(body, { isUpdate: true });
            const pool = await getPool();

            const existing = await pool.request()
                .input('id',      sql.UniqueIdentifier, sponsorId)
                .input('eventId', sql.UniqueIdentifier, eventId)
                .query(`SELECT * FROM EventFinancials WHERE Id = @id AND EventId = @eventId AND Category = 'sponsorship'`);

            if (!existing.recordset.length) return { status: 404, jsonBody: { error: 'Sponsor not found' } };

            const cur = mapSponsorFinancial(existing.recordset[0]);
            const merged = {
                description:   payload.description   ?? cur.companyName,
                amount:        payload.amount        ?? cur.amount ?? 0,
                contactPerson: payload.contactPerson !== undefined ? payload.contactPerson : cur.contactPerson,
                phoneNumber:   payload.phoneNumber   !== undefined ? payload.phoneNumber   : cur.phoneNumber,
                contactEmail:  payload.contactEmail  !== undefined ? payload.contactEmail  : cur.email,
                sponsorStatus: payload.sponsorStatus ?? cur.sponsorStatus ?? 'reached-out',
                notes:         payload.notes         !== undefined ? payload.notes         : cur.notes
            };

            await pool.request()
                .input('id',            sql.UniqueIdentifier,  sponsorId)
                .input('description',   sql.NVarChar(200),     merged.description)
                .input('amount',        sql.Decimal(12, 2),    merged.amount)
                .input('contactPerson', sql.NVarChar(200),     merged.contactPerson)
                .input('phoneNumber',   sql.NVarChar(50),      merged.phoneNumber)
                .input('contactEmail',  sql.NVarChar(320),     merged.contactEmail)
                .input('sponsorStatus', sql.NVarChar(30),      merged.sponsorStatus)
                .input('notes',         sql.NVarChar(sql.MAX), merged.notes)
                .query(`
                    UPDATE EventFinancials SET
                        Description   = @description,
                        Amount        = @amount,
                        ContactPerson = @contactPerson,
                        PhoneNumber   = @phoneNumber,
                        ContactEmail  = @contactEmail,
                        SponsorStatus = @sponsorStatus,
                        Notes         = @notes,
                        UpdatedAt     = SYSUTCDATETIME()
                    WHERE Id = @id
                `);

            const updated = await pool.request()
                .input('id', sql.UniqueIdentifier, sponsorId)
                .query('SELECT * FROM EventFinancials WHERE Id = @id');
            return { status: 200, jsonBody: mapSponsorFinancial(updated.recordset[0]) };
        } catch (error) {
            const status = /required|Invalid sponsor|amount must/i.test(error.message) ? 400 : 500;
            if (status === 500) await logError(context, error);
            return { status, jsonBody: { error: error.message || 'Failed to update sponsor' } };
        }
    }
});

// DELETE /api/events/{eventId}/sponsors/{sponsorId} - Delete sponsor
app.http('event-sponsors-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'events/{eventId}/sponsors/{sponsorId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, sponsorId } = request.params;
            const pool = await getPool();
            const result = await pool.request()
                .input('id',      sql.UniqueIdentifier, sponsorId)
                .input('eventId', sql.UniqueIdentifier, eventId)
                .query(`DELETE FROM EventFinancials WHERE Id = @id AND EventId = @eventId AND Category = 'sponsorship'`);

            if (!result.rowsAffected[0]) return { status: 404, jsonBody: { error: 'Sponsor not found' } };
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: error.message || 'Failed to delete sponsor' } };
        }
    }
});

// POST /api/events - Create new event
app.http('events-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const body = await request.json();
            
            if (!body.name || !body.startDate || !body.endDate) {
                return {
                    status: 400,
                    jsonBody: { error: 'name, startDate, and endDate are required' }
                };
            }
            
            const events = await eventsStorage.getAll();
            
            // If new event has active status, deactivate others
            const newStatus = body.status || 'draft';
            if (isActiveStatus(newStatus)) {
                for (const e of events) {
                    if (isActiveStatus(e.status)) {
                        await eventsStorage.update(e.id, { status: 'completed' });
                    }
                }
            }
            
            // Generate hotel dates from event dates
            const daysBefore = body.hotelDaysBefore !== undefined ? parseInt(body.hotelDaysBefore) : 0;
            const daysAfter = body.hotelDaysAfter !== undefined ? parseInt(body.hotelDaysAfter) : 0;
            const hotelDates = generateHotelDates(body.startDate, body.endDate, daysBefore, daysAfter);
            const hotelDefaultNights = generateDefaultHotelNights(hotelDates, body.startDate, body.endDate);

            const newEventId = generateGuid();
            const newEvent = {
                id: newEventId,
                name: body.name,
                description: body.description || '',
                startDate: body.startDate,
                endDate: body.endDate,
                location: body.location || '',
                status: newStatus,
                registrationType: body.registrationType || 'team',
                minTeamSize: body.minTeamSize || 3,
                maxTeamSize: body.maxTeamSize || 5,
                sequenceId: body.sequenceId || null,
                sequenceEnabled: body.sequenceEnabled !== undefined ? body.sequenceEnabled : (body.sequenceId ? true : false),
                teamWelcomeEmailId: body.teamWelcomeEmailId || null,
                sendTeamRegistrationEmail: body.sendTeamRegistrationEmail !== undefined ? body.sendTeamRegistrationEmail : true,
                sendWelcomeEmail: body.sendWelcomeEmail !== undefined ? body.sendWelcomeEmail : (body.teamWelcomeEmailId ? true : false),
                sendInterestAcknowledgment: body.sendInterestAcknowledgment || false,
                sendJudgeInvitationEmail: body.sendJudgeInvitationEmail !== undefined ? body.sendJudgeInvitationEmail : true,
                sendCommitteeInvitationEmail: body.sendCommitteeInvitationEmail !== undefined ? body.sendCommitteeInvitationEmail : true,
                teamRegistrationTerms: body.teamRegistrationTerms || null,
                soloQueueTerms: body.soloQueueTerms || null,
                singleRegistrationTerms: body.singleRegistrationTerms || null,
                hotelEnabled: body.hotelEnabled || false,
                hotelMandatory: body.hotelMandatory || false,
                hotelDaysBefore: body.hotelDaysBefore !== undefined ? parseInt(body.hotelDaysBefore) : 0,
                hotelDaysAfter: body.hotelDaysAfter !== undefined ? parseInt(body.hotelDaysAfter) : 0,
                hotelDates: hotelDates,
                hotelDefaultNights: hotelDefaultNights,
                createdAt: new Date().toISOString()
            };

            // Note: Committee/Judge roles are managed via participations (roles[]) — no special teams needed
            
            await eventsStorage.create(newEvent);
            
            context.log(`Event created: ${newEvent.id}`);

            return {
                status: 201,
                jsonBody: newEvent
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error creating event:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to create event' }
            };
        }
    }
});

// PUT /api/events/:id - Update event
app.http('events-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'events/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const body = await request.json();

            const events = await eventsStorage.getAll();
            const existingEvent = events.find(e => e.id === id);

            if (!existingEvent) {
                return {
                    status: 404,
                    jsonBody: { error: 'Event not found' }
                };
            }

            // Remove legacy fields if present in body
            delete body.isActive;
            delete body.registrationOpen;
            
            // Check if event dates changed - if so, regenerate hotel dates
            const datesChanged = (body.startDate && body.startDate !== existingEvent.startDate) ||
                                 (body.endDate && body.endDate !== existingEvent.endDate);
            const hotelConfigChanged = (body.hotelDaysBefore !== undefined && body.hotelDaysBefore !== existingEvent.hotelDaysBefore) ||
                                       (body.hotelDaysAfter !== undefined && body.hotelDaysAfter !== existingEvent.hotelDaysAfter);
            
            // Determine final start/end dates
            const finalStartDate = body.startDate || existingEvent.startDate;
            const finalEndDate = body.endDate || existingEvent.endDate;
            
            // Regenerate hotel dates if event dates changed
            let hotelDates = existingEvent.hotelDates;
            let hotelDefaultNights = existingEvent.hotelDefaultNights;
            
            if (datesChanged || hotelConfigChanged || !hotelDates || hotelDates.length === 0) {
                const finalDaysBefore = body.hotelDaysBefore !== undefined ? parseInt(body.hotelDaysBefore) : (existingEvent.hotelDaysBefore ?? 0);
                const finalDaysAfter = body.hotelDaysAfter !== undefined ? parseInt(body.hotelDaysAfter) : (existingEvent.hotelDaysAfter ?? 0);
                hotelDates = generateHotelDates(finalStartDate, finalEndDate, finalDaysBefore, finalDaysAfter);
                hotelDefaultNights = generateDefaultHotelNights(hotelDates, finalStartDate, finalEndDate);
            }
            
            // Update fields
            const updatedEvent = {
                ...existingEvent,
                ...body,
                id: existingEvent.id, // Preserve ID
                createdAt: existingEvent.createdAt, // Preserve creation date
                sequenceId: body.sequenceId !== undefined ? body.sequenceId : existingEvent.sequenceId,
                sequenceEnabled: body.sequenceEnabled !== undefined ? body.sequenceEnabled : existingEvent.sequenceEnabled,
                teamWelcomeEmailId: body.teamWelcomeEmailId !== undefined ? body.teamWelcomeEmailId : existingEvent.teamWelcomeEmailId,
                sendTeamRegistrationEmail: body.sendTeamRegistrationEmail !== undefined ? body.sendTeamRegistrationEmail : existingEvent.sendTeamRegistrationEmail,
                sendWelcomeEmail: body.sendWelcomeEmail !== undefined ? body.sendWelcomeEmail : existingEvent.sendWelcomeEmail,
                sendInterestAcknowledgment: body.sendInterestAcknowledgment !== undefined ? body.sendInterestAcknowledgment : existingEvent.sendInterestAcknowledgment,
                sendJudgeInvitationEmail: body.sendJudgeInvitationEmail !== undefined ? body.sendJudgeInvitationEmail : existingEvent.sendJudgeInvitationEmail,
                sendCommitteeInvitationEmail: body.sendCommitteeInvitationEmail !== undefined ? body.sendCommitteeInvitationEmail : existingEvent.sendCommitteeInvitationEmail,
                hotelEnabled: body.hotelEnabled !== undefined ? body.hotelEnabled : existingEvent.hotelEnabled,
                hotelMandatory: body.hotelMandatory !== undefined ? body.hotelMandatory : existingEvent.hotelMandatory,
                hotelDaysBefore: body.hotelDaysBefore !== undefined ? parseInt(body.hotelDaysBefore) : (existingEvent.hotelDaysBefore ?? 0),
                hotelDaysAfter: body.hotelDaysAfter !== undefined ? parseInt(body.hotelDaysAfter) : (existingEvent.hotelDaysAfter ?? 0),
                hotelDates: hotelDates,
                hotelDefaultNights: hotelDefaultNights,
                updatedAt: new Date().toISOString()
            };

            // Note: Committee/Judge roles are managed via participations (roles[]) — no special teams needed

            await eventsStorage.updateFull(updatedEvent);

            context.log(`Event updated: ${id}`);

            return {
                status: 200,
                jsonBody: updatedEvent
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error updating event:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to update event' }
            };
        }
    }
});

// DELETE /api/events/:id - Delete event
app.http('events-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'events/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            
            const events = await eventsStorage.getAll();
            const index = events.findIndex(e => e.id === id);
            
            if (index < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Event not found' }
                };
            }
            
            const deletedEvent = events[index];
            await eventsStorage.delete(id);
            
            context.log(`Event deleted: ${id}`);
            
            return {
                status: 200,
                jsonBody: { message: 'Event deleted', event: deletedEvent }
            };
        } catch (error) {
            await logError(context, error);
            context.error('Error deleting event:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to delete event' }
            };
        }
    }
});

console.log('Events API loaded');

// ============================================================
// FINANCIALS ENDPOINTS
// ============================================================

// GET /api/events/{eventId}/financials - List all financial rows
app.http('event-financials-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'events/{eventId}/financials',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const rows = await listByEvent(eventId);
            return { status: 200, jsonBody: rows };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: error.message || 'Failed to list financials' } };
        }
    }
});

// GET /api/events/{eventId}/financials/summary - Financial totals
app.http('event-financials-summary', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/summary',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const summary = await getSummary(eventId);
            return { status: 200, jsonBody: summary };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: error.message || 'Failed to get financial summary' } };
        }
    }
});

// POST /api/events/{eventId}/financials - Create manual row
app.http('event-financials-create', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events/{eventId}/financials',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const eventId = request.params.eventId;
            const body = await request.json();
            const row = await createManual(eventId, body);
            return { status: 201, jsonBody: row };
        } catch (error) {
            const status = /Invalid type|Invalid category|Invalid paidBy|amount must/i.test(error.message) ? 400 : 500;
            if (status === 500) await logError(context, error);
            return { status, jsonBody: { error: error.message || 'Failed to create financial row' } };
        }
    }
});

// PUT /api/events/{eventId}/financials/{rowId} - Update manual row
app.http('event-financials-update', {
    methods: ['PUT'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/{rowId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, rowId } = request.params;
            const body = await request.json();
            const row = await updateManual(rowId, eventId, body);
            return { status: 200, jsonBody: row };
        } catch (error) {
            const status = /not found|Invalid type|Invalid category|Invalid paidBy|amount must/i.test(error.message) ? 400 : 500;
            if (status === 500) await logError(context, error);
            return { status, jsonBody: { error: error.message || 'Failed to update financial row' } };
        }
    }
});

// DELETE /api/events/{eventId}/financials/{rowId} - Delete manual row
app.http('event-financials-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/{rowId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, rowId } = request.params;
            const deleted = await deleteManual(rowId, eventId);
            if (!deleted) return { status: 404, jsonBody: { error: 'Row not found or not deletable' } };
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: error.message || 'Failed to delete financial row' } };
        }
    }
});

// PATCH /api/events/{eventId}/financials/{rowId} - Update paidBy on any row (auto or manual)
app.http('event-financials-patch', {
    methods: ['PATCH'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/{rowId}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId, rowId } = request.params;
            const { paidBy } = await request.json();
            if (!paidBy) return { status: 400, jsonBody: { error: 'paidBy is required' } };
            await updatePaidBy(rowId, eventId, paidBy);
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            const status = /Invalid paidBy|not found/i.test(error.message) ? 400 : 500;
            if (status === 500) await logError(context, error);
            return { status, jsonBody: { error: error.message || 'Failed to update row' } };
        }
    }
});

// POST /api/events/{eventId}/financials/recalculate
// Rebuilds hotel + food auto rows for every participant in the event.
app.http('event-financials-recalculate', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'events/{eventId}/financials/recalculate',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const { eventId } = request.params;

            // Load event
            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === eventId);
            if (!event) return { status: 404, jsonBody: { error: 'Event not found' } };

            // Load all participations for this event
            const allParticipations = await participationsStorage.getAll();
            const eventParticipations = allParticipations.filter(p => p.eventId === eventId);

            // Sync hotel + food rows for each participant
            let updated = 0;
            const errors = [];
            for (const participation of eventParticipations) {
                try {
                    await syncParticipationToFinancials(event, participation);
                    updated++;
                } catch (err) {
                    errors.push({ participationId: participation.id, error: err.message });
                    context.warn(`Recalculate: failed for participation ${participation.id}: ${err.message}`);
                }
            }

            return {
                status: 200,
                jsonBody: { updated, total: eventParticipations.length, errors }
            };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: error.message || 'Failed to recalculate financials' } };
        }
    }
});
