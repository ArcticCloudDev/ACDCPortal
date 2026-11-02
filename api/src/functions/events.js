const { app } = require('@azure/functions');
const { requireAuth, getTokenFromRequest, verifyToken } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const StorageModule = require('../shared/storage');
const { Storage } = StorageModule;
const { generateId, isGuid } = require('../shared/id');
const { isHttpUrl, isIsoDate, toInt, toNumber } = require('../shared/validate');
const { eventDependants, completeOtherActiveEvents, deleteEventLooseRows } = require('../shared/admin-queries');

const eventsStorage = new Storage('events');

const STATUSES = ['draft', 'pre-registration', 'registration', 'live', 'completed'];
const REGISTRATION_TYPES = ['team', 'single', 'solo'];

// Real Events columns a client may set. Anything else in the body is ignored, so a stray
// key (the budget page sends hotelNights) can no longer turn into "Invalid column name".
const STRING_FIELDS = ['name', 'description', 'location', 'currency', 'teamRegistrationTerms', 'soloQueueTerms',
    'singleRegistrationTerms', 'eventImage', 'eventImageData', 'sharepointUrl'];
const BOOL_FIELDS = ['sequenceEnabled', 'sendWelcomeEmail', 'sendInterestAcknowledgment', 'sendJudgeInvitationEmail',
    'sendCommitteeInvitationEmail', 'sendTeamRegistrationEmail', 'hotelEnabled', 'hotelMandatory'];
const GUID_FIELDS = ['sequenceId', 'teamWelcomeEmailId', 'committeeTeamId', 'judgesTeamId'];
const MAX_LENGTH = { name: 200, location: 500, currency: 10, sharepointUrl: 2000, eventImage: 2000 };

function isActiveStatus(status) {
    return status === 'pre-registration' || status === 'registration' || status === 'live';
}

function isAdminRequest(request) {
    const token = getTokenFromRequest(request);
    if (!token) return false;
    const result = verifyToken(token);
    return result.valid && !!result.payload.isPortalAdmin;
}

// Shape returned to anyone who is not a portal admin.
function toPublicEvent(event) {
    const { eventImageData, ...publicEvent } = event;
    return publicEvent;
}

// Picks the allow-listed fields out of `body`, coerces their types and validates them.
// Returns { fields } or { error }. `existing` supplies the other half of cross-field checks on PUT.
function pickEventFields(body, existing = null) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be a JSON object' };
    const fields = {};
    const has = key => body[key] !== undefined;

    for (const key of STRING_FIELDS) {
        if (!has(key)) continue;
        if (body[key] === null) { fields[key] = null; continue; }
        if (typeof body[key] !== 'string') return { error: `${key} must be a string` };
        if (MAX_LENGTH[key] && body[key].length > MAX_LENGTH[key]) return { error: `${key} must be at most ${MAX_LENGTH[key]} characters` };
        fields[key] = body[key];
    }
    if (has('name') && !(fields.name || '').trim()) return { error: 'name is required' };
    if (fields.sharepointUrl && !isHttpUrl(fields.sharepointUrl, { httpsOnly: true })) return { error: 'sharepointUrl must be an https:// URL' };
    if (fields.eventImage && !isHttpUrl(fields.eventImage) && !/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(fields.eventImage)) {
        return { error: 'eventImage must be an http(s) URL' };
    }

    for (const key of BOOL_FIELDS) {
        if (has(key)) fields[key] = body[key] === true || body[key] === 'true' || body[key] === 1;
    }

    for (const key of GUID_FIELDS) {
        if (!has(key)) continue;
        if (body[key] === null || body[key] === '') { fields[key] = null; continue; }
        if (!isGuid(body[key])) return { error: `${key} must be a GUID` };
        fields[key] = body[key];
    }

    if (has('status')) {
        if (!STATUSES.includes(body.status)) return { error: `status must be one of: ${STATUSES.join(', ')}` };
        fields.status = body.status;
    }
    if (has('registrationType')) {
        if (!REGISTRATION_TYPES.includes(body.registrationType)) return { error: `registrationType must be one of: ${REGISTRATION_TYPES.join(', ')}` };
        fields.registrationType = body.registrationType;
    }

    for (const key of ['startDate', 'endDate']) {
        if (!has(key)) continue;
        if (!isIsoDate(body[key])) return { error: `${key} must be a date in YYYY-MM-DD format` };
        fields[key] = body[key];
    }
    const startDate = fields.startDate ?? existing?.startDate;
    const endDate = fields.endDate ?? existing?.endDate;
    if (startDate && endDate && startDate > endDate) return { error: 'endDate must not be before startDate' };

    for (const key of ['minTeamSize', 'maxTeamSize']) {
        if (!has(key)) continue;
        if (body[key] === null) { fields[key] = null; continue; }
        const n = toInt(body[key], { min: 1, max: 100 });
        if (n === null) return { error: `${key} must be an integer between 1 and 100` };
        fields[key] = n;
    }
    const minTeamSize = fields.minTeamSize ?? existing?.minTeamSize;
    const maxTeamSize = fields.maxTeamSize ?? existing?.maxTeamSize;
    if (minTeamSize != null && maxTeamSize != null && minTeamSize > maxTeamSize) return { error: 'minTeamSize must not exceed maxTeamSize' };

    for (const key of ['hotelDaysBefore', 'hotelDaysAfter']) {
        if (!has(key)) continue;
        const n = toInt(body[key], { min: 0, max: 30 });
        if (n === null) return { error: `${key} must be an integer between 0 and 30` };
        fields[key] = n;
    }
    for (const key of ['costPerParticipant', 'hotelRatePerNight', 'foodRatePerDay']) {
        if (!has(key)) continue;
        if (body[key] === null || body[key] === '') { fields[key] = null; continue; }
        const n = toNumber(body[key], { min: 0, max: 9999999999 });
        if (n === null) return { error: `${key} must be a non-negative number` };
        fields[key] = n;
    }
    if (has('foodDays')) {
        if (body.foodDays === null || body.foodDays === '') fields.foodDays = null;
        else {
            const n = toInt(body.foodDays, { min: 0, max: 365 });
            if (n === null) return { error: 'foodDays must be a non-negative integer' };
            fields.foodDays = n;
        }
    }
    if (has('fileCategories')) {
        if (body.fileCategories === null) fields.fileCategories = null;
        else if (!Array.isArray(body.fileCategories) || !body.fileCategories.every(c => typeof c === 'string' && c.length <= 100)) {
            return { error: 'fileCategories must be an array of strings' };
        } else fields.fileCategories = body.fileCategories;
    }

    return { fields };
}

function generateHotelDates(startDate, endDate, daysBefore = 0, daysAfter = 0) {
    const dates = [];
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayLabelsFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const start = new Date(startDate + 'T12:00:00');
    start.setDate(start.getDate() - Math.max(0, daysBefore));

    const end = new Date(endDate + 'T12:00:00');
    end.setDate(end.getDate() + Math.max(0, daysAfter));

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

function generateDefaultHotelNights(hotelDates, eventStartDate, eventEndDate) {
    const defaults = [];
    const dayLabels = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    const eventStart = new Date(eventStartDate + 'T12:00:00');
    const eventEnd = new Date(eventEndDate + 'T12:00:00');

    for (let i = 0; i < hotelDates.length - 1; i++) {
        const currentDate = new Date(hotelDates[i].date + 'T12:00:00');
        const nextDate = new Date(hotelDates[i + 1].date + 'T12:00:00');

        if (currentDate < eventStart) {
            continue;
        }

        if (currentDate >= eventStart && currentDate < eventEnd) {
            const fromDay = dayLabels[currentDate.getDay()];
            const toDay = dayLabels[nextDate.getDay()];
            defaults.push(`${fromDay}-${toDay}`);
        }
    }

    // Events longer than a week repeat weekday labels; EventDefaultNights is UNIQUE (EventId, NightLabel).
    return [...new Set(defaults)];
}

app.http('events-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events',
    handler: async (request, context) => {
        try {
            const events = await eventsStorage.getAll();
            if (isAdminRequest(request)) {
                return { status: 200, jsonBody: events };
            }
            return {
                status: 200,
                jsonBody: events.filter(e => e.status !== 'draft').map(toPublicEvent)
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

app.http('events-active', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/active',
    handler: async (request, context) => {
        try {
            const events = await eventsStorage.getAll();
            const activeEvent = events.find(e => isActiveStatus(e.status));

            if (!activeEvent) {
                return {
                    status: 404,
                    jsonBody: { error: 'No active event found' }
                };
            }

            return {
                status: 200,
                jsonBody: toPublicEvent(activeEvent)
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

app.http('events-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const event = isGuid(id) ? await StorageModule.events.getById(id) : null;
            const admin = isAdminRequest(request);

            if (!event || (event.status === 'draft' && !admin)) {
                return {
                    status: 404,
                    jsonBody: { error: 'Event not found' }
                };
            }

            return {
                status: 200,
                jsonBody: admin ? event : toPublicEvent(event)
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

            if (!body || !body.name || !body.startDate || !body.endDate) {
                return {
                    status: 400,
                    jsonBody: { error: 'name, startDate, and endDate are required' }
                };
            }

            const picked = pickEventFields(body);
            if (picked.error) {
                return { status: 400, jsonBody: { error: picked.error } };
            }
            const fields = picked.fields;

            const newStatus = fields.status || 'draft';
            if (isActiveStatus(newStatus)) {
                await completeOtherActiveEvents();
            }

            const daysBefore = fields.hotelDaysBefore ?? 0;
            const daysAfter = fields.hotelDaysAfter ?? 0;
            const hotelDates = generateHotelDates(fields.startDate, fields.endDate, daysBefore, daysAfter);
            const hotelDefaultNights = generateDefaultHotelNights(hotelDates, fields.startDate, fields.endDate);

            const newEventId = generateId();
            const newEvent = {
                id: newEventId,
                ...fields,
                name: fields.name,
                description: fields.description || '',
                startDate: fields.startDate,
                endDate: fields.endDate,
                location: fields.location || '',
                status: newStatus,
                registrationType: fields.registrationType || 'team',
                minTeamSize: fields.minTeamSize || 3,
                maxTeamSize: fields.maxTeamSize || 5,
                sequenceId: fields.sequenceId || null,
                sequenceEnabled: fields.sequenceEnabled !== undefined ? fields.sequenceEnabled : !!fields.sequenceId,
                teamWelcomeEmailId: fields.teamWelcomeEmailId || null,
                sendTeamRegistrationEmail: fields.sendTeamRegistrationEmail !== undefined ? fields.sendTeamRegistrationEmail : true,
                sendWelcomeEmail: fields.sendWelcomeEmail !== undefined ? fields.sendWelcomeEmail : !!fields.teamWelcomeEmailId,
                sendInterestAcknowledgment: fields.sendInterestAcknowledgment || false,
                sendJudgeInvitationEmail: fields.sendJudgeInvitationEmail !== undefined ? fields.sendJudgeInvitationEmail : true,
                sendCommitteeInvitationEmail: fields.sendCommitteeInvitationEmail !== undefined ? fields.sendCommitteeInvitationEmail : true,
                teamRegistrationTerms: fields.teamRegistrationTerms || null,
                soloQueueTerms: fields.soloQueueTerms || null,
                singleRegistrationTerms: fields.singleRegistrationTerms || null,
                hotelEnabled: fields.hotelEnabled || false,
                hotelMandatory: fields.hotelMandatory || false,
                hotelDaysBefore: daysBefore,
                hotelDaysAfter: daysAfter,
                hotelDates: hotelDates,
                hotelDefaultNights: hotelDefaultNights,
                createdAt: new Date().toISOString()
            };

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

            const existingEvent = isGuid(id) ? await StorageModule.events.getById(id) : null;

            if (!existingEvent) {
                return {
                    status: 404,
                    jsonBody: { error: 'Event not found' }
                };
            }

            const picked = pickEventFields(body, existingEvent);
            if (picked.error) {
                return { status: 400, jsonBody: { error: picked.error } };
            }
            const fields = picked.fields;

            const datesChanged = (fields.startDate && fields.startDate !== existingEvent.startDate) ||
                                 (fields.endDate && fields.endDate !== existingEvent.endDate);
            const hotelConfigChanged = (fields.hotelDaysBefore !== undefined && fields.hotelDaysBefore !== existingEvent.hotelDaysBefore) ||
                                       (fields.hotelDaysAfter !== undefined && fields.hotelDaysAfter !== existingEvent.hotelDaysAfter);

            const finalStartDate = fields.startDate || existingEvent.startDate;
            const finalEndDate = fields.endDate || existingEvent.endDate;
            const finalDaysBefore = fields.hotelDaysBefore !== undefined ? fields.hotelDaysBefore : (existingEvent.hotelDaysBefore ?? 0);
            const finalDaysAfter = fields.hotelDaysAfter !== undefined ? fields.hotelDaysAfter : (existingEvent.hotelDaysAfter ?? 0);

            let hotelDates = existingEvent.hotelDates;
            let hotelDefaultNights = existingEvent.hotelDefaultNights;

            if (datesChanged || hotelConfigChanged || !hotelDates || hotelDates.length === 0) {
                hotelDates = generateHotelDates(finalStartDate, finalEndDate, finalDaysBefore, finalDaysAfter);
                hotelDefaultNights = generateDefaultHotelNights(hotelDates, finalStartDate, finalEndDate);
            }

            const finalStatus = fields.status || existingEvent.status;
            if (isActiveStatus(finalStatus) && (finalStatus !== existingEvent.status || !isActiveStatus(existingEvent.status))) {
                await completeOtherActiveEvents(existingEvent.id);
            }

            const updatedEvent = {
                ...existingEvent,
                ...fields,
                id: existingEvent.id,
                createdAt: existingEvent.createdAt,
                hotelDaysBefore: finalDaysBefore,
                hotelDaysAfter: finalDaysAfter,
                hotelDates: hotelDates,
                hotelDefaultNights: hotelDefaultNights,
                updatedAt: new Date().toISOString()
            };

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

            const deletedEvent = isGuid(id) ? await StorageModule.events.getById(id) : null;

            if (!deletedEvent) {
                return {
                    status: 404,
                    jsonBody: { error: 'Event not found' }
                };
            }

            const dependants = await eventDependants(id);
            if (dependants.length > 0) {
                const summary = dependants.map(d => `${d.count} ${d.what}`).join(', ');
                return {
                    status: 409,
                    jsonBody: {
                        error: `Cannot delete this event while it still has ${summary}. Remove them first.`,
                        dependants
                    }
                };
            }

            await deleteEventLooseRows(id);
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
