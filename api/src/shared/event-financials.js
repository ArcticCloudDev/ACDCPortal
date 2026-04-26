// event-financials.js
// Shared helper for reading/writing EventFinancials rows.
// Used by: participations.js (hotel/food auto rows), events.js (sponsor income rows),
//          and the financials API endpoints.

const { getPool, sql } = require('./sql');

const VALID_TYPES = new Set(['income', 'expense']);
const VALID_CATEGORIES = new Set(['hotel', 'food', 'venue', 'sponsorship', 'activity', 'other']);
const VALID_PAID_BY = new Set(['participant', 'event']);

function mapRow(row) {
    return {
        id: row.Id,
        eventId: row.EventId,
        participationId: row.ParticipationId || null,
        sponsorId: row.SponsorId || null,
        type: row.Type,
        category: row.Category,
        description: row.Description,
        unitCost: row.UnitCost == null ? null : Number(row.UnitCost),
        days: row.Days == null ? null : Number(row.Days),
        amount: Number(row.Amount),
        paidBy: row.PaidBy,
        source: row.Source,
        notes: row.Notes || null,
        createdAt: row.CreatedAt instanceof Date ? row.CreatedAt.toISOString() : row.CreatedAt,
        updatedAt: row.UpdatedAt instanceof Date ? row.UpdatedAt.toISOString() : (row.UpdatedAt || null)
    };
}

async function ensureTable(pool) {
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='EventFinancials')
        BEGIN
            CREATE TABLE EventFinancials (
                Id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
                EventId UNIQUEIDENTIFIER NOT NULL,
                ParticipationId UNIQUEIDENTIFIER NULL,
                SponsorId UNIQUEIDENTIFIER NULL,
                Type NVARCHAR(10) NOT NULL,
                Category NVARCHAR(30) NOT NULL,
                Description NVARCHAR(200) NOT NULL,
                UnitCost DECIMAL(12,2) NULL,
                Days INT NULL,
                Amount DECIMAL(12,2) NOT NULL,
                PaidBy NVARCHAR(20) NOT NULL DEFAULT 'event',
                Source NVARCHAR(10) NOT NULL DEFAULT 'manual',
                Notes NVARCHAR(MAX) NULL,
                CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                UpdatedAt DATETIME2 NULL,
                CONSTRAINT FK_EventFinancials_Events FOREIGN KEY (EventId) REFERENCES Events(Id) ON DELETE CASCADE,
                CONSTRAINT CK_EventFinancials_Type CHECK (Type IN ('income','expense')),
                CONSTRAINT CK_EventFinancials_PaidBy CHECK (PaidBy IN ('participant','event')),
                CONSTRAINT CK_EventFinancials_Source CHECK (Source IN ('manual','auto'))
            );
            CREATE INDEX IX_EventFinancials_EventId ON EventFinancials(EventId);
            CREATE INDEX IX_EventFinancials_ParticipationId ON EventFinancials(ParticipationId);
            CREATE INDEX IX_EventFinancials_SponsorId ON EventFinancials(SponsorId);
        END
    `);
}

// List all financials for an event
async function listByEvent(eventId) {
    const pool = await getPool();
    await ensureTable(pool);
    const result = await pool.request()
        .input('eventId', sql.UniqueIdentifier, eventId)
        .query(`
            SELECT f.*, p.Email AS ParticipationEmail, p.Roles AS ParticipationRoles
            FROM EventFinancials f
            LEFT JOIN Participations p ON p.Id = f.ParticipationId
            WHERE f.EventId = @eventId
            ORDER BY f.CreatedAt ASC
        `);
    return result.recordset.map(row => ({
        ...mapRow(row),
        participationEmail: row.ParticipationEmail || null,
        participationRoles: row.ParticipationRoles || null
    }));
}

// Insert a manual row (income or expense)
async function createManual(eventId, { type, category, description, amount, paidBy = 'event', unitCost = null, days = null, notes = null, sponsorId = null }) {
    if (!VALID_TYPES.has(type)) throw new Error(`Invalid type: ${type}`);
    if (!VALID_CATEGORIES.has(category)) throw new Error(`Invalid category: ${category}`);
    if (!VALID_PAID_BY.has(paidBy)) throw new Error(`Invalid paidBy: ${paidBy}`);
    if (amount == null || !Number.isFinite(Number(amount)) || Number(amount) < 0) throw new Error('amount must be a non-negative number');

    const pool = await getPool();
    await ensureTable(pool);
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();

    await pool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('eventId', sql.UniqueIdentifier, eventId)
        .input('sponsorId', sql.UniqueIdentifier, sponsorId)
        .input('type', sql.NVarChar(10), type)
        .input('category', sql.NVarChar(30), category)
        .input('description', sql.NVarChar(200), description)
        .input('unitCost', sql.Decimal(12, 2), unitCost)
        .input('days', sql.Int, days)
        .input('amount', sql.Decimal(12, 2), Number(amount))
        .input('paidBy', sql.NVarChar(20), paidBy)
        .input('notes', sql.NVarChar(sql.MAX), notes)
        .query(`
            INSERT INTO EventFinancials
              (Id, EventId, SponsorId, Type, Category, Description, UnitCost, Days, Amount, PaidBy, Source, Notes)
            VALUES
              (@id, @eventId, @sponsorId, @type, @category, @description, @unitCost, @days, @amount, @paidBy, 'manual', @notes)
        `);

    const created = await pool.request()
        .input('id', sql.UniqueIdentifier, id)
        .query('SELECT * FROM EventFinancials WHERE Id = @id');
    return mapRow(created.recordset[0]);
}

// Upsert an auto-calculated row for a participation (hotel or food)
// Uses participationId + category as the unique key — one row per person per category
async function upsertParticipationRow(eventId, participationId, { category, description, unitCost, days, amount, paidBy }) {
    const pool = await getPool();
    await ensureTable(pool);

    const existing = await pool.request()
        .input('participationId', sql.UniqueIdentifier, participationId)
        .input('category', sql.NVarChar(30), category)
        .query(`SELECT Id FROM EventFinancials WHERE ParticipationId = @participationId AND Category = @category`);

    if (existing.recordset.length > 0) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, existing.recordset[0].Id)
            .input('description', sql.NVarChar(200), description)
            .input('unitCost', sql.Decimal(12, 2), unitCost)
            .input('days', sql.Int, days)
            .input('amount', sql.Decimal(12, 2), amount)
            .input('paidBy', sql.NVarChar(20), paidBy)
            .query(`
                UPDATE EventFinancials
                SET Description = @description, UnitCost = @unitCost, Days = @days,
                    Amount = @amount, PaidBy = @paidBy, UpdatedAt = SYSUTCDATETIME()
                WHERE Id = @id
            `);
    } else {
        const { v4: uuidv4 } = require('uuid');
        const id = uuidv4();
        await pool.request()
            .input('id', sql.UniqueIdentifier, id)
            .input('eventId', sql.UniqueIdentifier, eventId)
            .input('participationId', sql.UniqueIdentifier, participationId)
            .input('category', sql.NVarChar(30), category)
            .input('description', sql.NVarChar(200), description)
            .input('unitCost', sql.Decimal(12, 2), unitCost)
            .input('days', sql.Int, days)
            .input('amount', sql.Decimal(12, 2), amount)
            .input('paidBy', sql.NVarChar(20), paidBy)
            .query(`
                INSERT INTO EventFinancials
                  (Id, EventId, ParticipationId, Type, Category, Description, UnitCost, Days, Amount, PaidBy, Source)
                VALUES
                  (@id, @eventId, @participationId, 'expense', @category, @description, @unitCost, @days, @amount, @paidBy, 'auto')
            `);
    }
}

// Sync hotel + food rows for a single participation given pre-loaded event object.
// Called both from the per-participation hook and the bulk recalculate endpoint.
async function syncParticipationToFinancials(event, participation) {
    const hotelRate = event.hotelRatePerNight != null ? Number(event.hotelRatePerNight) : null;
    const foodRate  = event.foodRatePerDay    != null ? Number(event.foodRatePerDay)    : null;
    const foodDays  = event.foodDays          != null ? Number(event.foodDays)          : null;

    const paidBy = (participation.hotelPaidBy === 'team' || participation.hotelPaidBy === 'committee')
        ? 'event' : 'participant';

    const nights = participation.hotelNights || {};
    const nightCount = Object.values(nights).filter(Boolean).length;

    if (hotelRate != null && nightCount > 0) {
        const nightLabels = Object.entries(nights)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(', ');
        await upsertParticipationRow(participation.eventId, participation.id, {
            category: 'hotel',
            description: `Hotel - ${nightLabels}`,
            unitCost: hotelRate,
            days: nightCount,
            amount: hotelRate * nightCount,
            paidBy
        });
    }

    if (foodRate != null && foodDays != null) {
        await upsertParticipationRow(participation.eventId, participation.id, {
            category: 'food',
            description: `Food - ${foodDays} day${foodDays !== 1 ? 's' : ''}`,
            unitCost: foodRate,
            days: foodDays,
            amount: foodRate * foodDays,
            paidBy
        });
    }
}

// Remove all auto rows for a participation (called on participation delete)
async function deleteParticipationRows(participationId) {
    const pool = await getPool();
    await pool.request()
        .input('participationId', sql.UniqueIdentifier, participationId)
        .query(`DELETE FROM EventFinancials WHERE ParticipationId = @participationId AND Source = 'auto'`);
}

// Upsert sponsor income row (called when sponsor status changes to/from 'confirmed')
async function upsertSponsorRow(eventId, sponsorId, { companyName, amount, active }) {
    const pool = await getPool();
    await ensureTable(pool);

    if (!active) {
        // Sponsor no longer confirmed — remove their income row
        await pool.request()
            .input('sponsorId', sql.UniqueIdentifier, sponsorId)
            .query(`DELETE FROM EventFinancials WHERE SponsorId = @sponsorId AND Source = 'auto'`);
        return;
    }

    const existing = await pool.request()
        .input('sponsorId', sql.UniqueIdentifier, sponsorId)
        .query(`SELECT Id FROM EventFinancials WHERE SponsorId = @sponsorId AND Source = 'auto'`);

    if (existing.recordset.length > 0) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, existing.recordset[0].Id)
            .input('description', sql.NVarChar(200), `Sponsorship - ${companyName}`)
            .input('amount', sql.Decimal(12, 2), amount)
            .query(`
                UPDATE EventFinancials
                SET Description = @description, Amount = @amount, UpdatedAt = SYSUTCDATETIME()
                WHERE Id = @id
            `);
    } else {
        const { v4: uuidv4 } = require('uuid');
        const id = uuidv4();
        await pool.request()
            .input('id', sql.UniqueIdentifier, id)
            .input('eventId', sql.UniqueIdentifier, eventId)
            .input('sponsorId', sql.UniqueIdentifier, sponsorId)
            .input('description', sql.NVarChar(200), `Sponsorship - ${companyName}`)
            .input('amount', sql.Decimal(12, 2), amount)
            .query(`
                INSERT INTO EventFinancials
                  (Id, EventId, SponsorId, Type, Category, Description, Amount, PaidBy, Source)
                VALUES
                  (@id, @eventId, @sponsorId, 'income', 'sponsorship', @description, @amount, 'event', 'auto')
            `);
    }
}

// Update a manual row
async function updateManual(id, eventId, { type, category, description, amount, paidBy, unitCost, days, notes }) {
    if (type !== undefined && !VALID_TYPES.has(type)) throw new Error(`Invalid type: ${type}`);
    if (category !== undefined && !VALID_CATEGORIES.has(category)) throw new Error(`Invalid category: ${category}`);
    if (paidBy !== undefined && !VALID_PAID_BY.has(paidBy)) throw new Error(`Invalid paidBy: ${paidBy}`);

    const pool = await getPool();
    const existing = await pool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('eventId', sql.UniqueIdentifier, eventId)
        .query(`SELECT * FROM EventFinancials WHERE Id = @id AND EventId = @eventId AND Source = 'manual'`);

    if (!existing.recordset.length) throw new Error('Financial row not found or not editable');

    const cur = mapRow(existing.recordset[0]);
    const merged = {
        type: type ?? cur.type,
        category: category ?? cur.category,
        description: description ?? cur.description,
        amount: amount != null ? Number(amount) : cur.amount,
        paidBy: paidBy ?? cur.paidBy,
        unitCost: unitCost !== undefined ? unitCost : cur.unitCost,
        days: days !== undefined ? days : cur.days,
        notes: notes !== undefined ? notes : cur.notes
    };

    await pool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('type', sql.NVarChar(10), merged.type)
        .input('category', sql.NVarChar(30), merged.category)
        .input('description', sql.NVarChar(200), merged.description)
        .input('unitCost', sql.Decimal(12, 2), merged.unitCost)
        .input('days', sql.Int, merged.days)
        .input('amount', sql.Decimal(12, 2), merged.amount)
        .input('paidBy', sql.NVarChar(20), merged.paidBy)
        .input('notes', sql.NVarChar(sql.MAX), merged.notes)
        .query(`
            UPDATE EventFinancials
            SET Type = @type, Category = @category, Description = @description,
                UnitCost = @unitCost, Days = @days, Amount = @amount,
                PaidBy = @paidBy, Notes = @notes, UpdatedAt = SYSUTCDATETIME()
            WHERE Id = @id
        `);

    const updated = await pool.request()
        .input('id', sql.UniqueIdentifier, id)
        .query(`SELECT * FROM EventFinancials WHERE Id = @id`);
    return mapRow(updated.recordset[0]);
}

// Delete a manual row
async function deleteManual(id, eventId) {
    const pool = await getPool();
    const result = await pool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('eventId', sql.UniqueIdentifier, eventId)
        .query(`DELETE FROM EventFinancials WHERE Id = @id AND EventId = @eventId AND Source = 'manual'`);
    return result.rowsAffected[0] > 0;
}

// Build financial summary for an event
async function getSummary(eventId) {
    const pool = await getPool();
    const result = await pool.request()
        .input('eventId', sql.UniqueIdentifier, eventId)
        .query(`
            SELECT
                Type,
                Category,
                PaidBy,
                SUM(Amount) AS Total,
                COUNT(*) AS RowCount
            FROM EventFinancials
            WHERE EventId = @eventId
            GROUP BY Type, Category, PaidBy
        `);

    let totalIncome = 0;
    let totalOrgExpense = 0;
    let totalParticipantExpense = 0;
    const byCategory = {};

    for (const row of result.recordset) {
        const total = Number(row.Total);
        if (row.Type === 'income') {
            totalIncome += total;
        } else {
            if (row.PaidBy === 'event') totalOrgExpense += total;
            else totalParticipantExpense += total;
        }
        const key = `${row.Type}:${row.Category}:${row.PaidBy}`;
        byCategory[key] = { type: row.Type, category: row.Category, paidBy: row.PaidBy, total, rowCount: row.RowCount };
    }

    return {
        totalIncome,
        totalOrgExpense,
        totalParticipantExpense,
        netOrgBalance: totalIncome - totalOrgExpense,
        byCategory: Object.values(byCategory)
    };
}

module.exports = {
    listByEvent,
    createManual,
    updateManual,
    deleteManual,
    upsertParticipationRow,
    deleteParticipationRows,
    syncParticipationToFinancials,
    upsertSponsorRow,
    getSummary
};
