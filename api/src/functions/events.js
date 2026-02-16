// ACDC Portal - Events API
const { app } = require('@azure/functions');
const { Storage } = require('../shared/storage');

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
function generateHotelDates(startDate, endDate) {
    const dates = [];
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayLabelsFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    // Start from 1 day before event
    const start = new Date(startDate);
    start.setDate(start.getDate() - 1);
    
    // End 1 day after event
    const end = new Date(endDate);
    end.setDate(end.getDate() + 1);
    
    // Generate dates
    const current = new Date(start);
    while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];
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
    
    const eventStart = new Date(eventStartDate);
    const eventEnd = new Date(eventEndDate);
    
    // For each date except the last one (since it's check-in date, next day is checkout)
    for (let i = 0; i < hotelDates.length - 1; i++) {
        const currentDate = new Date(hotelDates[i].date);
        const nextDate = new Date(hotelDates[i + 1].date);
        
        // Skip the night before the event starts (day before -> first day)
        if (currentDate < eventStart) {
            continue;
        }
        
        // Include nights from event start through event end
        if (currentDate >= eventStart && currentDate <= eventEnd) {
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
            context.error('Error listing events:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to list events' }
            };
        }
    }
});

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
            
            return {
                status: 200,
                jsonBody: activeEvent
            };
        } catch (error) {
            context.error('Error getting active event:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get active event' }
            };
        }
    }
});

// GET /api/events/:id - Get event by ID
app.http('events-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'events/{id}',
    handler: async (request, context) => {
        try {
            const id = request.params.id;
            const events = await eventsStorage.getAll();
            const event = events.find(e => e.id === id);
            
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
                events.forEach(e => {
                    if (isActiveStatus(e.status)) {
                        e.status = 'completed';
                    }
                });
            }
            
            // Generate hotel dates from event dates
            const hotelDates = generateHotelDates(body.startDate, body.endDate);
            const hotelDefaultNights = generateDefaultHotelNights(hotelDates, body.startDate, body.endDate);
            
            const newEvent = {
                id: generateGuid(),
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
                teamWelcomeEmailId: body.teamWelcomeEmailId || null,
                hotelDates: hotelDates,
                hotelDefaultNights: hotelDefaultNights,
                createdAt: new Date().toISOString()
            };

            // For team-based events, automatically create Committee and Judges teams
            if (newEvent.registrationType === 'team') {
                const teams = await teamsStorage.getAll();
                
                // Create Committee team
                const committeeTeam = {
                    id: generateGuid(),
                    teamName: `Committee - ${newEvent.name}`,
                    eventId: newEvent.id,
                    isSpecialTeam: true,
                    specialTeamType: 'committee',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                teams.push(committeeTeam);
                
                // Create Judges team
                const judgesTeam = {
                    id: generateGuid(),
                    teamName: `Judges - ${newEvent.name}`,
                    eventId: newEvent.id,
                    isSpecialTeam: true,
                    specialTeamType: 'judges',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                teams.push(judgesTeam);
                
                await teamsStorage.saveAll(teams);
                
                // Add team IDs to event
                newEvent.committeeTeamId = committeeTeam.id;
                newEvent.judgesTeamId = judgesTeam.id;
            }
            
            events.push(newEvent);
            await eventsStorage.saveAll(events);
            
            context.log(`Event created: ${newEvent.id}`);
            
            return {
                status: 201,
                jsonBody: newEvent
            };
        } catch (error) {
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
            const index = events.findIndex(e => e.id === id);
            
            if (index < 0) {
                return {
                    status: 404,
                    jsonBody: { error: 'Event not found' }
                };
            }
            
            const existingEvent = events[index];
            
            // If this event is being set to active status, deactivate others
            const newStatus = body.status || existingEvent.status;
            if (isActiveStatus(newStatus) && !isActiveStatus(existingEvent.status)) {
                events.forEach(e => {
                    if (e.id !== id && isActiveStatus(e.status)) {
                        e.status = 'completed';
                    }
                });
            }
            
            // Remove legacy fields if present in body
            delete body.isActive;
            delete body.registrationOpen;
            
            // Check if event dates changed - if so, regenerate hotel dates
            const datesChanged = (body.startDate && body.startDate !== existingEvent.startDate) ||
                                 (body.endDate && body.endDate !== existingEvent.endDate);
            
            // Determine final start/end dates
            const finalStartDate = body.startDate || existingEvent.startDate;
            const finalEndDate = body.endDate || existingEvent.endDate;
            
            // Regenerate hotel dates if event dates changed
            let hotelDates = existingEvent.hotelDates;
            let hotelDefaultNights = existingEvent.hotelDefaultNights;
            
            if (datesChanged || !hotelDates || hotelDates.length === 0) {
                hotelDates = generateHotelDates(finalStartDate, finalEndDate);
                hotelDefaultNights = generateDefaultHotelNights(hotelDates, finalStartDate, finalEndDate);
            }
            
            // Update fields
            const updatedEvent = {
                ...existingEvent,
                ...body,
                id: existingEvent.id, // Preserve ID
                createdAt: existingEvent.createdAt, // Preserve creation date
                sequenceId: body.sequenceId !== undefined ? body.sequenceId : existingEvent.sequenceId,
                teamWelcomeEmailId: body.teamWelcomeEmailId !== undefined ? body.teamWelcomeEmailId : existingEvent.teamWelcomeEmailId,
                hotelDates: hotelDates,
                hotelDefaultNights: hotelDefaultNights,
                updatedAt: new Date().toISOString()
            };

            // If event is team-based and doesn't have special teams yet, create them
            if (updatedEvent.registrationType === 'team' && 
                (!updatedEvent.committeeTeamId || !updatedEvent.judgesTeamId)) {
                
                const teams = await teamsStorage.getAll();
                
                // Create Committee team if not exists
                if (!updatedEvent.committeeTeamId) {
                    const committeeTeam = {
                        id: generateGuid(),
                        teamName: `Committee - ${updatedEvent.name}`,
                        eventId: updatedEvent.id,
                        isSpecialTeam: true,
                        specialTeamType: 'committee',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                    teams.push(committeeTeam);
                    updatedEvent.committeeTeamId = committeeTeam.id;
                }
                
                // Create Judges team if not exists
                if (!updatedEvent.judgesTeamId) {
                    const judgesTeam = {
                        id: generateGuid(),
                        teamName: `Judges - ${updatedEvent.name}`,
                        eventId: updatedEvent.id,
                        isSpecialTeam: true,
                        specialTeamType: 'judges',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                    teams.push(judgesTeam);
                    updatedEvent.judgesTeamId = judgesTeam.id;
                }
                
                await teamsStorage.saveAll(teams);
            }
            
            events[index] = updatedEvent;
            await eventsStorage.saveAll(events);
            
            context.log(`Event updated: ${id}`);
            
            return {
                status: 200,
                jsonBody: updatedEvent
            };
        } catch (error) {
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
            events.splice(index, 1);
            await eventsStorage.saveAll(events);
            
            context.log(`Event deleted: ${id}`);
            
            return {
                status: 200,
                jsonBody: { message: 'Event deleted', event: deletedEvent }
            };
        } catch (error) {
            context.error('Error deleting event:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to delete event' }
            };
        }
    }
});

console.log('Events API loaded');
