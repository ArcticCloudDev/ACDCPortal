// ACDC Portal - Events API
const { app } = require('@azure/functions');
const { Storage } = require('../shared/storage');

const eventsStorage = new Storage('events');
const teamsStorage = new Storage('teams');

// Helper to generate ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
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
            const activeEvent = events.find(e => e.isActive);
            
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
            
            // If this event is set as active, deactivate others
            if (body.isActive) {
                events.forEach(e => e.isActive = false);
            }
            
            // Generate ID from name
            const id = body.name.toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
            
            const newEvent = {
                id: id + '-' + Date.now().toString(36),
                name: body.name,
                description: body.description || '',
                startDate: body.startDate,
                endDate: body.endDate,
                location: body.location || '',
                status: body.status || 'draft',
                registrationOpen: body.registrationOpen !== false || body.status === 'registration',
                isActive: body.isActive || false,
                registrationType: body.registrationType || 'team',
                minTeamSize: body.minTeamSize || 3,
                maxTeamSize: body.maxTeamSize || 5,
                hotelDates: body.hotelDates || [],
                hotelDefaultNights: body.hotelDefaultNights || [],
                createdAt: new Date().toISOString()
            };

            // For team-based events, automatically create Committee and Judges teams
            if (newEvent.registrationType === 'team') {
                const teams = await teamsStorage.getAll();
                
                // Create Committee team
                const committeeTeam = {
                    id: generateId(),
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
                    id: generateId(),
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
            
            // If this event is being set as active, deactivate others
            if (body.isActive && !existingEvent.isActive) {
                events.forEach(e => e.isActive = false);
            }
            
            // Update fields
            const updatedEvent = {
                ...existingEvent,
                ...body,
                id: existingEvent.id, // Preserve ID
                createdAt: existingEvent.createdAt, // Preserve creation date
                updatedAt: new Date().toISOString()
            };

            // If event is team-based and doesn't have special teams yet, create them
            if (updatedEvent.registrationType === 'team' && 
                (!updatedEvent.committeeTeamId || !updatedEvent.judgesTeamId)) {
                
                const teams = await teamsStorage.getAll();
                
                // Create Committee team if not exists
                if (!updatedEvent.committeeTeamId) {
                    const committeeTeam = {
                        id: generateId(),
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
                        id: generateId(),
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
