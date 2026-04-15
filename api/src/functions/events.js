// ACDC Portal - Events API
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const StorageModule = require('../shared/storage');
const { Storage } = StorageModule;

const eventsStorage = new Storage('events');
const teamsStorage = new Storage('teams');

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

// POST /api/events - Create new event
app.http('events-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'events',
    handler: async (request, context) => {
        try {
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
    authLevel: 'anonymous',
    route: 'events/{id}',
    handler: async (request, context) => {
        try {
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
    authLevel: 'anonymous',
    route: 'events/{id}',
    handler: async (request, context) => {
        try {
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
