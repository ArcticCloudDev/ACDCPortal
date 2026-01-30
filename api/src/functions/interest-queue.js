const { app } = require('@azure/functions');
const { readData, writeData } = require('../shared/storage');
const { v4: uuidv4 } = require('uuid');

// Get all interest queue entries (admin)
app.http('interest-queue-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'interest-queue',
    handler: async (request, context) => {
        try {
            const data = await readData('interest-queue.json');
            const entries = data.entries || [];
            
            // Sort by created date (newest first)
            entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            
            return { status: 200, jsonBody: entries };
        } catch (error) {
            context.error('Error listing interest queue:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Add to interest queue (public)
app.http('interest-queue-add', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'interest-queue',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { email, firstName, lastName, phone, company, source } = body;

            if (!email) {
                return { status: 400, jsonBody: { error: 'Email is required' } };
            }

            const data = await readData('interest-queue.json');
            
            // Check if email already exists
            const existing = data.entries.find(e => 
                e.email.toLowerCase() === email.toLowerCase() && !e.registeredEventId
            );
            
            if (existing) {
                return { status: 409, jsonBody: { 
                    error: 'You are already on the interest list!',
                    entry: existing
                }};
            }

            const newEntry = {
                id: uuidv4(),
                email: email.toLowerCase().trim(),
                firstName: firstName?.trim() || '',
                lastName: lastName?.trim() || '',
                phone: phone?.trim() || '',
                company: company?.trim() || '',
                source: source || 'website',
                createdAt: new Date().toISOString(),
                notified: false,
                registeredEventId: null
            };

            data.entries.push(newEntry);
            await writeData('interest-queue.json', data);

            return { status: 201, jsonBody: newEntry };
        } catch (error) {
            context.error('Error adding to interest queue:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Check if email is in interest queue (public)
app.http('interest-queue-check', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'interest-queue/check/{email}',
    handler: async (request, context) => {
        try {
            const email = decodeURIComponent(request.params.email);
            const data = await readData('interest-queue.json');
            
            const entry = data.entries.find(e => 
                e.email.toLowerCase() === email.toLowerCase() && !e.registeredEventId
            );
            
            return { 
                status: 200, 
                jsonBody: { 
                    inQueue: !!entry,
                    entry: entry || null
                }
            };
        } catch (error) {
            context.error('Error checking interest queue:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Remove from interest queue (by email or id)
app.http('interest-queue-remove', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'interest-queue/{identifier}',
    handler: async (request, context) => {
        try {
            const identifier = decodeURIComponent(request.params.identifier);
            const data = await readData('interest-queue.json');
            
            const index = data.entries.findIndex(e => 
                e.id === identifier || e.email.toLowerCase() === identifier.toLowerCase()
            );
            
            if (index === -1) {
                return { status: 404, jsonBody: { error: 'Entry not found' } };
            }

            const removed = data.entries.splice(index, 1)[0];
            await writeData('interest-queue.json', data);

            return { status: 200, jsonBody: { removed } };
        } catch (error) {
            context.error('Error removing from interest queue:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Mark as registered (called when someone registers for an event)
app.http('interest-queue-mark-registered', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'interest-queue/mark-registered',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { email, eventId } = body;

            if (!email || !eventId) {
                return { status: 400, jsonBody: { error: 'email and eventId are required' } };
            }

            const data = await readData('interest-queue.json');
            
            // Find all entries for this email that haven't registered yet
            const entries = data.entries.filter(e => 
                e.email.toLowerCase() === email.toLowerCase() && !e.registeredEventId
            );
            
            if (entries.length === 0) {
                return { status: 200, jsonBody: { message: 'No pending entries found', updated: 0 } };
            }

            // Mark them as registered
            entries.forEach(entry => {
                entry.registeredEventId = eventId;
                entry.registeredAt = new Date().toISOString();
            });

            await writeData('interest-queue.json', data);

            return { status: 200, jsonBody: { 
                message: 'Entries marked as registered',
                updated: entries.length
            }};
        } catch (error) {
            context.error('Error marking as registered:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Get stats for interest queue (admin)
app.http('interest-queue-stats', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'interest-queue/stats',
    handler: async (request, context) => {
        try {
            const data = await readData('interest-queue.json');
            const entries = data.entries || [];
            
            const stats = {
                total: entries.length,
                pending: entries.filter(e => !e.registeredEventId).length,
                registered: entries.filter(e => e.registeredEventId).length,
                notified: entries.filter(e => e.notified && !e.registeredEventId).length,
                notNotified: entries.filter(e => !e.notified && !e.registeredEventId).length
            };
            
            return { status: 200, jsonBody: stats };
        } catch (error) {
            context.error('Error getting interest queue stats:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});

// Mark entries as notified (admin - after sending registration open email)
app.http('interest-queue-mark-notified', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'interest-queue/mark-notified',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { entryIds } = body; // optional - if not provided, mark all

            const data = await readData('interest-queue.json');
            let count = 0;
            
            data.entries.forEach(entry => {
                if (!entry.registeredEventId && !entry.notified) {
                    if (!entryIds || entryIds.includes(entry.id)) {
                        entry.notified = true;
                        entry.notifiedAt = new Date().toISOString();
                        count++;
                    }
                }
            });

            await writeData('interest-queue.json', data);

            return { status: 200, jsonBody: { 
                message: 'Entries marked as notified',
                updated: count
            }};
        } catch (error) {
            context.error('Error marking as notified:', error);
            return { status: 500, jsonBody: { error: error.message } };
        }
    }
});
