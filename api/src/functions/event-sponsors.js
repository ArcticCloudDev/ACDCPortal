const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { logError } = require('../shared/error-log');
const { getPool, sql } = require('../shared/sql');
const { generateId, isGuid } = require('../shared/id');
const { isEmail } = require('../shared/validate');
const { eventExists } = require('../shared/admin-queries');

const VALID_STATUSES = new Set(['reached-out', 'negotiating', 'declined', 'confirmed']);

function badRequest(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
}

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

function trimmedString(value, name, max) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${name} must be a string`);
    const v = String(value).trim();
    if (v.length > max) throw badRequest(`${name} must be at most ${max} characters`);
    return v || null;
}

function normalizeSponsorPayload(body = {}, { isUpdate = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
    const payload = {};
    const has = (k) => !isUpdate || Object.prototype.hasOwnProperty.call(body, k);

    if (has('companyName')) {
        const v = trimmedString(body.companyName, 'companyName', 200);
        if (!v) throw badRequest('companyName is required');
        payload.description = v;
    }
    if (has('contactPerson'))  payload.contactPerson  = trimmedString(body.contactPerson, 'contactPerson', 200);
    if (has('phoneNumber'))    payload.phoneNumber    = trimmedString(body.phoneNumber, 'phoneNumber', 50);
    if (has('email')) {
        const v = trimmedString(body.email, 'email', 320);
        if (v && !isEmail(v)) throw badRequest('email must be a valid email address');
        payload.contactEmail = v ? v.toLowerCase() : null;
    }
    if (has('notes'))          payload.notes          = body.notes === undefined || body.notes === null || body.notes === '' ? null : String(body.notes).trim() || null;
    if (has('amount')) {
        const raw = body.amount;
        if (raw === '' || raw == null) { payload.amount = 0; }
        else {
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0 || n > 9999999999) throw badRequest('amount must be a non-negative number');
            payload.amount = n;
        }
    }
    if (has('sponsorStatus') || has('status')) {
        const raw = body.sponsorStatus ?? body.status;
        const s = (raw === undefined || raw === null || raw === '') ? 'reached-out' : String(raw).trim().toLowerCase();
        if (!VALID_STATUSES.has(s)) throw badRequest('Invalid sponsor status');
        payload.sponsorStatus = s;
    }
    return payload;
}

async function failureResponse(context, error, fallback) {
    if (error && error.status === 400) {
        return { status: 400, jsonBody: { error: error.message } };
    }
    await logError(context, error);
    return { status: 500, jsonBody: { error: fallback } };
}

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
            if (!isGuid(eventId)) return { status: 404, jsonBody: { error: 'Event not found' } };
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
            return { status: 500, jsonBody: { error: 'Failed to list sponsors' } };
        }
    }
});

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
            if (!isGuid(eventId) || !(await eventExists(eventId))) {
                return { status: 404, jsonBody: { error: 'Event not found' } };
            }
            const body = await request.json();
            const payload = normalizeSponsorPayload(body);
            const id = generateId();
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
            return failureResponse(context, error, 'Failed to create sponsor');
        }
    }
});

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
            if (!isGuid(eventId) || !isGuid(sponsorId)) return { status: 404, jsonBody: { error: 'Sponsor not found' } };
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
            return failureResponse(context, error, 'Failed to update sponsor');
        }
    }
});

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
            if (!isGuid(eventId) || !isGuid(sponsorId)) return { status: 404, jsonBody: { error: 'Sponsor not found' } };
            const pool = await getPool();
            const result = await pool.request()
                .input('id',      sql.UniqueIdentifier, sponsorId)
                .input('eventId', sql.UniqueIdentifier, eventId)
                .query(`DELETE FROM EventFinancials WHERE Id = @id AND EventId = @eventId AND Category = 'sponsorship'`);

            if (!result.rowsAffected[0]) return { status: 404, jsonBody: { error: 'Sponsor not found' } };
            return { status: 200, jsonBody: { success: true } };
        } catch (error) {
            await logError(context, error);
            return { status: 500, jsonBody: { error: 'Failed to delete sponsor' } };
        }
    }
});
