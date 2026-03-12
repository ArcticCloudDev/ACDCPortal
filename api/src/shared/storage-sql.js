// Storage Module — SQL-backed (Azure SQL via Entra ID)
// Drop-in replacement for the JSON file storage module.
//
// Exports:
//   module.exports = Storage          (named stores: .users, .teams, .events, etc.)
//   module.exports.Storage = GenericStorage  (class for any table)
//   module.exports.readData = readData
//   module.exports.writeData = writeData

const { getPool, sql } = require('./sql');

// ============================================================
// HELPERS
// ============================================================

const DATE_ONLY_COLUMNS = new Set([
    'StartDate', 'EndDate', 'HotelDate'
]);

function rowToJs(row) {
    const obj = {};
    for (const [key, value] of Object.entries(row)) {
        const jsKey = key.charAt(0).toLowerCase() + key.slice(1);
        if (value instanceof Date) {
            obj[jsKey] = DATE_ONLY_COLUMNS.has(key)
                ? value.toISOString().split('T')[0]
                : value.toISOString();
        } else {
            obj[jsKey] = value;
        }
    }
    return obj;
}

function camelToSql(key) {
    return key.charAt(0).toUpperCase() + key.slice(1);
}

// Build parameterized INSERT from a JS object
// skipKeys: JS properties to skip (handled separately)
// jsonKeys: JS properties to JSON.stringify before inserting
async function insertGeneric(pool, tableName, item, skipKeys = [], jsonKeys = []) {
    const request = pool.request();
    const cols = [];
    const paramNames = [];
    let i = 0;

    for (const [key, val] of Object.entries(item)) {
        if (skipKeys.includes(key)) continue;
        if (val === undefined) continue;

        const sqlCol = camelToSql(key);
        const paramName = `p${i}`;
        let paramVal = val;

        if (jsonKeys.includes(key) && paramVal != null && typeof paramVal !== 'string') {
            paramVal = JSON.stringify(paramVal);
        }

        if (paramVal === null) {
            request.input(paramName, sql.NVarChar, null);
        } else {
            request.input(paramName, paramVal);
        }
        cols.push(`[${sqlCol}]`);
        paramNames.push(`@${paramName}`);
        i++;
    }

    if (cols.length === 0) return;
    await request.query(`INSERT INTO [${tableName}] (${cols.join(', ')}) VALUES (${paramNames.join(', ')})`);
}

// Build parameterized UPDATE from a JS object
async function updateGeneric(pool, tableName, idColumn, idValue, updates, skipKeys = [], jsonKeys = []) {
    const request = pool.request();
    request.input('_id', idValue);
    const setClauses = [];
    let i = 0;

    for (const [key, val] of Object.entries(updates)) {
        if (skipKeys.includes(key)) continue;
        if (key === 'id') continue; // Don't update the ID
        if (val === undefined) continue;

        const sqlCol = camelToSql(key);
        const paramName = `u${i}`;
        let paramVal = val;

        if (jsonKeys.includes(key) && paramVal != null && typeof paramVal !== 'string') {
            paramVal = JSON.stringify(paramVal);
        }

        if (paramVal === null) {
            request.input(paramName, sql.NVarChar, null);
        } else {
            request.input(paramName, paramVal);
        }
        setClauses.push(`[${sqlCol}] = @${paramName}`);
        i++;
    }

    if (setClauses.length === 0) return;
    await request.query(`UPDATE [${tableName}] SET ${setClauses.join(', ')} WHERE [${idColumn}] = @_id`);
}

// ============================================================
// TABLE CONFIGURATION
// ============================================================

const TABLE_MAP = {
    'events':           { table: 'Events',           wrapperKey: null,             idCol: 'Id' },
    'users':            { table: 'Users',            wrapperKey: null,             idCol: 'Id' },
    'teams':            { table: 'Teams',            wrapperKey: null,             idCol: 'Id' },
    'badges':           { table: 'Badges',           wrapperKey: null,             idCol: 'Id' },
    'event-badges':     { table: 'EventBadges',      wrapperKey: null,             idCol: 'Id' },
    'badge-claims':     { table: 'BadgeClaims',      wrapperKey: null,             idCol: 'Id' },
    'participations':   { table: 'Participations',   wrapperKey: 'participations', idCol: 'Id' },
    'email-campaigns':  { table: 'EmailCampaigns',   wrapperKey: 'campaigns',      idCol: 'Id' },
    'email-deliveries': { table: 'EmailDeliveries',  wrapperKey: 'deliveries',     idCol: 'Id' },
    'interest-leads':   { table: 'InterestLeads',    wrapperKey: 'leads',          idCol: 'Id' },
    'invitations':      { table: 'Invitations',      wrapperKey: 'invitations',    idCol: 'Id' },
    'scheduled-runs':   { table: 'ScheduledRuns',    wrapperKey: 'runs',           idCol: 'Id' },
    'email-log':        { table: 'EmailLog',         wrapperKey: 'emails',         idCol: 'Id' },
    'sequences':        { table: 'Sequences',        wrapperKey: 'sequences',      idCol: 'Id' },
    'interest-queue':   { table: 'InterestQueue',    wrapperKey: 'entries',        idCol: 'Id' },
    'solo-queue':       { table: 'SoloQueue',        wrapperKey: null,             idCol: 'Id' },
    'sequence-progress':{ table: null },  // dead code
    'system-email-config': { table: 'SystemEmailConfig', wrapperKey: 'templates',  idCol: 'TemplateKey' },
};

// ============================================================
// SPECIAL ROW CONVERTERS (for complex tables)
// ============================================================

function eventRowToJs(row) {
    const obj = rowToJs(row);
    // Parse FileCategories from JSON string to array
    if (obj.fileCategories && typeof obj.fileCategories === 'string') {
        try { obj.fileCategories = JSON.parse(obj.fileCategories); } catch (e) { /* keep as string */ }
    }
    return obj;
}

function participationRowToJs(row) {
    const obj = {};
    for (const [key, value] of Object.entries(row)) {
        if (key.startsWith('HotelNight_')) continue; // handled below
        const jsKey = key.charAt(0).toLowerCase() + key.slice(1);
        if (value instanceof Date) {
            obj[jsKey] = value.toISOString();
        } else {
            obj[jsKey] = value;
        }
    }
    // Split Roles CSV string back into an array
    if (typeof obj.roles === 'string') {
        obj.roles = obj.roles.split(',').map(r => r.trim()).filter(Boolean);
    } else if (!obj.roles) {
        obj.roles = [];
    }
    // Assemble hotelNights object from BIT columns
    obj.hotelNights = {
        'mon-tue': !!row.HotelNight_MonTue,
        'tue-wed': !!row.HotelNight_TueWed,
        'wed-thu': !!row.HotelNight_WedThu,
        'thu-fri': !!row.HotelNight_ThuFri,
        'fri-sat': !!row.HotelNight_FriSat,
        'sat-sun': !!row.HotelNight_SatSun,
        'sun-mon': !!row.HotelNight_SunMon,
    };
    return obj;
}

function emailLogRowToJs(row) {
    const obj = rowToJs(row);
    // Reconstruct results object from flat columns
    obj.results = {
        sent: obj.resultsSent || 0,
        failed: obj.resultsFailed || 0,
        errors: obj.resultsErrors ? JSON.parse(obj.resultsErrors) : []
    };
    delete obj.resultsSent;
    delete obj.resultsFailed;
    delete obj.resultsErrors;
    return obj;
}

function scheduledRunRowToJs(row) {
    return rowToJs(row);
    // campaigns array is added separately after JOIN with ScheduledRunCampaigns
}

function systemEmailConfigToJs(rows) {
    // Convert rows into the { templates: { key: {...} } } structure
    const templates = {};
    for (const row of rows) {
        templates[row.TemplateKey] = {
            name: row.Name,
            subject: row.Subject,
            mergeFields: row.MergeFields ? JSON.parse(row.MergeFields) : [],
            editableSections: row.EditableSections ? JSON.parse(row.EditableSections) : {},
            eventThemes: row.EventThemes ? JSON.parse(row.EventThemes) : {}
        };
    }
    return { templates };
}

// ============================================================
// EVENTS — with hotelDates + hotelDefaultNights
// ============================================================

async function readAllEvents(pool) {
    const eventsResult = await pool.request().query('SELECT * FROM [Events]');
    const events = eventsResult.recordset.map(eventRowToJs);

    // Load child tables for all events at once
    const hotelDatesResult = await pool.request().query('SELECT * FROM [EventHotelDates] ORDER BY HotelDate');
    const defaultNightsResult = await pool.request().query('SELECT * FROM [EventDefaultNights]');

    // Group by eventId
    const hotelDatesByEvent = {};
    for (const row of hotelDatesResult.recordset) {
        const eid = row.EventId;
        if (!hotelDatesByEvent[eid]) hotelDatesByEvent[eid] = [];
        hotelDatesByEvent[eid].push({
            date: row.HotelDate instanceof Date ? row.HotelDate.toISOString().split('T')[0] : row.HotelDate,
            dayLabel: row.DayLabel,
            dayLabelFull: row.DayLabelFull
        });
    }
    const defaultNightsByEvent = {};
    for (const row of defaultNightsResult.recordset) {
        const eid = row.EventId;
        if (!defaultNightsByEvent[eid]) defaultNightsByEvent[eid] = [];
        defaultNightsByEvent[eid].push(row.NightLabel);
    }

    // Merge into event objects
    for (const event of events) {
        event.hotelDates = hotelDatesByEvent[event.id] || [];
        event.hotelDefaultNights = defaultNightsByEvent[event.id] || [];
    }
    return events;
}

async function saveEvent(pool, event) {
    // Insert/update the event row
    const { hotelDates, hotelDefaultNights, ...eventData } = event;
    await insertGeneric(pool, 'Events', eventData, [], ['fileCategories']);

    // Insert hotel dates
    if (hotelDates && Array.isArray(hotelDates)) {
        for (const hd of hotelDates) {
            await pool.request()
                .input('eventId', event.id)
                .input('hotelDate', hd.date)
                .input('dayLabel', hd.dayLabel || '')
                .input('dayLabelFull', hd.dayLabelFull || '')
                .query(`INSERT INTO [EventHotelDates] (EventId, HotelDate, DayLabel, DayLabelFull)
                        VALUES (@eventId, @hotelDate, @dayLabel, @dayLabelFull)`);
        }
    }
    // Insert default nights
    if (hotelDefaultNights && Array.isArray(hotelDefaultNights)) {
        for (const night of hotelDefaultNights) {
            await pool.request()
                .input('eventId', event.id)
                .input('nightLabel', night)
                .query(`INSERT INTO [EventDefaultNights] (EventId, NightLabel)
                        VALUES (@eventId, @nightLabel)`);
        }
    }
}

// ============================================================
// PARTICIPATIONS — with hotelNights columns
// ============================================================

async function insertParticipation(pool, item) {
    const hotelNights = item.hotelNights || {};
    const { hotelNights: _, ...rest } = item;
    const roles = Array.isArray(rest.roles) ? rest.roles.join(',') : rest.roles;

    const request = pool.request();
    const i = (name, val) => { request.input(name, val === null || val === undefined ? sql.NVarChar : undefined, val ?? null); };

    i('id', rest.id);
    i('userId', rest.userId || null);
    i('email', rest.email);
    i('eventId', rest.eventId);
    i('roles', roles || null);
    i('teamId', rest.teamId || null);
    i('isTeamAdmin', rest.isTeamAdmin ? true : false);
    i('hotelMonTue', !!hotelNights['mon-tue']);
    i('hotelTueWed', !!hotelNights['tue-wed']);
    i('hotelWedThu', !!hotelNights['wed-thu']);
    i('hotelThuFri', !!hotelNights['thu-fri']);
    i('hotelFriSat', !!hotelNights['fri-sat']);
    i('hotelSatSun', !!hotelNights['sat-sun']);
    i('hotelSunMon', !!hotelNights['sun-mon']);
    i('hotelPaidBy', rest.hotelPaidBy || null);
    i('convertedFrom', rest.convertedFrom || null);
    i('convertedAt', rest.convertedAt || null);
    i('convertedVia', rest.convertedVia || null);
    i('invitationId', rest.invitationId || null);
    i('createdAt', rest.createdAt || new Date().toISOString());
    i('updatedAt', rest.updatedAt || null);

    await request.query(`
        INSERT INTO [Participations] (Id, UserId, Email, EventId, Roles, TeamId, IsTeamAdmin,
            HotelNight_MonTue, HotelNight_TueWed, HotelNight_WedThu, HotelNight_ThuFri,
            HotelNight_FriSat, HotelNight_SatSun, HotelNight_SunMon,
            HotelPaidBy, ConvertedFrom, ConvertedAt, ConvertedVia, InvitationId, CreatedAt, UpdatedAt)
        VALUES (@id, @userId, @email, @eventId, @roles, @teamId, @isTeamAdmin,
            @hotelMonTue, @hotelTueWed, @hotelWedThu, @hotelThuFri,
            @hotelFriSat, @hotelSatSun, @hotelSunMon,
            @hotelPaidBy, @convertedFrom, @convertedAt, @convertedVia, @invitationId, @createdAt, @updatedAt)
    `);
}

// ============================================================
// EMAIL LOG — with results object
// ============================================================

async function insertEmailLog(pool, item) {
    const results = item.results || {};
    const flat = {
        id: item.id,
        templateId: item.templateId,
        subject: item.subject,
        recipientCount: item.recipientCount ?? 0,
        sentAt: item.sentAt,
        resultsSent: results.sent ?? 0,
        resultsFailed: results.failed ?? 0,
        resultsErrors: results.errors && results.errors.length > 0 ? JSON.stringify(results.errors) : null,
        status: item.status || 'pending',
        source: item.source,
        campaignId: item.campaignId,
        createdAt: item.createdAt || new Date().toISOString()
    };
    await insertGeneric(pool, 'EmailLog', flat);
}

// ============================================================
// SCHEDULED RUNS — with campaigns child table
// ============================================================

async function readAllScheduledRuns(pool) {
    const runsResult = await pool.request().query('SELECT * FROM [ScheduledRuns]');
    const campaignsResult = await pool.request().query('SELECT * FROM [ScheduledRunCampaigns]');

    const campaignsByRun = {};
    for (const row of campaignsResult.recordset) {
        const rid = row.ScheduledRunId;
        if (!campaignsByRun[rid]) campaignsByRun[rid] = [];
        campaignsByRun[rid].push({
            id: row.CampaignId,
            subject: row.Subject,
            recipients: row.Recipients
        });
    }

    return runsResult.recordset.map(row => {
        const obj = rowToJs(row);
        obj.campaigns = campaignsByRun[obj.id] || [];
        return obj;
    });
}

async function insertScheduledRun(pool, run) {
    const { campaigns, ...runData } = run;
    await insertGeneric(pool, 'ScheduledRuns', runData);

    if (campaigns && Array.isArray(campaigns)) {
        for (const c of campaigns) {
            await pool.request()
                .input('scheduledRunId', run.id)
                .input('campaignId', c.id)
                .input('subject', c.subject || null)
                .input('recipients', c.recipients ?? 0)
                .query(`INSERT INTO [ScheduledRunCampaigns] (ScheduledRunId, CampaignId, Subject, Recipients)
                        VALUES (@scheduledRunId, @campaignId, @subject, @recipients)`);
        }
    }
}

// ============================================================
// SYSTEM EMAIL CONFIG — key-value with JSON columns
// ============================================================

async function readSystemEmailConfig(pool) {
    const result = await pool.request().query('SELECT * FROM [SystemEmailConfig]');
    return systemEmailConfigToJs(result.recordset);
}

async function writeSystemEmailConfig(pool, config) {
    const templates = config.templates || {};
    // Delete and re-insert all
    await pool.request().query('DELETE FROM [SystemEmailConfig]');
    for (const [key, t] of Object.entries(templates)) {
        await pool.request()
            .input('templateKey', key)
            .input('name', t.name)
            .input('subject', t.subject)
            .input('mergeFields', t.mergeFields ? JSON.stringify(t.mergeFields) : null)
            .input('editableSections', t.editableSections ? JSON.stringify(t.editableSections) : null)
            .input('eventThemes', t.eventThemes ? JSON.stringify(t.eventThemes) : null)
            .query(`INSERT INTO [SystemEmailConfig] (TemplateKey, Name, Subject, MergeFields, EditableSections, EventThemes)
                    VALUES (@templateKey, @name, @subject, @mergeFields, @editableSections, @eventThemes)`);
    }
}

// ============================================================
// GENERIC STORAGE CLASS
// ============================================================

class GenericStorage {
    constructor(filename) {
        this.filename = filename.endsWith('.json') ? filename : `${filename}.json`;
        const key = this.filename.replace('.json', '');
        this.config = TABLE_MAP[key] || null;
        this.wrapperKey = this.config?.wrapperKey || key;
    }

    // Get a row converter for this table
    _convertRow(row) {
        if (!this.config) return rowToJs(row);
        switch (this.config.table) {
            case 'Events': return eventRowToJs(row);
            case 'Participations': return participationRowToJs(row);
            case 'EmailLog': return emailLogRowToJs(row);
            default: return rowToJs(row);
        }
    }

    async getRaw() {
        if (!this.config || !this.config.table) return {};
        const pool = await getPool();

        // Special cases
        if (this.config.table === 'Events') {
            const events = await readAllEvents(pool);
            return events; // plain array
        }
        if (this.config.table === 'ScheduledRuns') {
            const runs = await readAllScheduledRuns(pool);
            return { runs };
        }
        if (this.config.table === 'SystemEmailConfig') {
            return await readSystemEmailConfig(pool);
        }

        const result = await pool.request().query(`SELECT * FROM [${this.config.table}]`);
        const items = result.recordset.map(row => this._convertRow(row));

        if (this.config.wrapperKey) {
            return { [this.config.wrapperKey]: items };
        }
        return items;
    }

    async saveRaw(data) {
        if (!this.config || !this.config.table) return false;
        const pool = await getPool();

        // Special cases
        if (this.config.table === 'SystemEmailConfig') {
            await writeSystemEmailConfig(pool, data);
            return true;
        }

        // Extract items from wrapper or use as-is
        let items;
        if (this.config.wrapperKey && data && data[this.config.wrapperKey]) {
            items = data[this.config.wrapperKey];
        } else if (Array.isArray(data)) {
            items = data;
        } else {
            items = [];
        }

        return this._saveItems(pool, items);
    }

    async getAll() {
        if (!this.config || !this.config.table) return [];
        const pool = await getPool();

        if (this.config.table === 'Events') {
            return readAllEvents(pool);
        }
        if (this.config.table === 'ScheduledRuns') {
            return readAllScheduledRuns(pool);
        }

        const result = await pool.request().query(`SELECT * FROM [${this.config.table}]`);
        return result.recordset.map(row => this._convertRow(row));
    }

    async saveAll(items) {
        if (!this.config || !this.config.table) return false;
        const pool = await getPool();
        return this._saveItems(pool, items);
    }

    async _saveItems(pool, items) {
        const table = this.config.table;

        // Delete all rows (and children for parent tables)
        if (table === 'Events') {
            await pool.request().query('DELETE FROM [EventDefaultNights]');
            await pool.request().query('DELETE FROM [EventHotelDates]');
        }
        if (table === 'ScheduledRuns') {
            await pool.request().query('DELETE FROM [ScheduledRunCampaigns]');
        }
        await pool.request().query(`DELETE FROM [${table}]`);

        // Re-insert all
        for (const item of items) {
            await this._insertItem(pool, item);
        }
        return true;
    }

    async _insertItem(pool, item) {
        const table = this.config.table;
        switch (table) {
            case 'Events':
                await saveEvent(pool, item);
                break;
            case 'Participations':
                await insertParticipation(pool, item);
                break;
            case 'EmailLog':
                await insertEmailLog(pool, item);
                break;
            case 'ScheduledRuns':
                await insertScheduledRun(pool, item);
                break;
            default:
                await insertGeneric(pool, table, item);
                break;
        }
    }

    async getById(id) {
        if (!this.config || !this.config.table) return undefined;
        const pool = await getPool();
        const result = await pool.request()
            .input('id', id)
            .query(`SELECT * FROM [${this.config.table}] WHERE [${this.config.idCol}] = @id`);
        if (result.recordset.length === 0) return undefined;
        return this._convertRow(result.recordset[0]);
    }

    async create(item) {
        if (!this.config || !this.config.table) return item;
        const pool = await getPool();
        await this._insertItem(pool, item);
        return item;
    }

    async update(id, updates) {
        if (!this.config || !this.config.table) return null;
        const pool = await getPool();

        // Read current item
        const current = await this.getById(id);
        if (!current) return null;

        const merged = { ...current, ...updates };

        // Delete and re-insert (simpler than building dynamic UPDATE for each table)
        await pool.request()
            .input('id', id)
            .query(`DELETE FROM [${this.config.table}] WHERE [${this.config.idCol}] = @id`);
        await this._insertItem(pool, merged);
        return merged;
    }

    async delete(id) {
        if (!this.config || !this.config.table) return false;
        const pool = await getPool();
        const result = await pool.request()
            .input('id', id)
            .query(`DELETE FROM [${this.config.table}] WHERE [${this.config.idCol}] = @id`);
        return result.rowsAffected[0] > 0;
    }
}

// ============================================================
// NAMED STORAGE OBJECT
// ============================================================

const Storage = {
    // Teams
    teams: {
        async getAll() {
            const pool = await getPool();
            const result = await pool.request().query('SELECT * FROM [Teams]');
            return result.recordset.map(rowToJs);
        },

        async getById(id) {
            const pool = await getPool();
            const result = await pool.request()
                .input('id', id)
                .query('SELECT * FROM [Teams] WHERE Id = @id');
            return result.recordset.length > 0 ? rowToJs(result.recordset[0]) : null;
        },

        async getByName(name) {
            const pool = await getPool();
            const result = await pool.request()
                .input('name', name)
                .query('SELECT * FROM [Teams] WHERE LOWER(TeamName) = LOWER(@name)');
            return result.recordset.length > 0 ? rowToJs(result.recordset[0]) : null;
        },

        async create(team) {
            const pool = await getPool();
            await insertGeneric(pool, 'Teams', team);
            return team;
        },

        async update(id, updates) {
            const pool = await getPool();
            await updateGeneric(pool, 'Teams', 'Id', id, updates);
            // Return the updated record
            const result = await pool.request()
                .input('id', id)
                .query('SELECT * FROM [Teams] WHERE Id = @id');
            return result.recordset.length > 0 ? rowToJs(result.recordset[0]) : null;
        },

        async delete(id) {
            const pool = await getPool();
            const result = await pool.request()
                .input('id', id)
                .query('DELETE FROM [Teams] WHERE Id = @id');
            return result.rowsAffected[0] > 0;
        }
    },

    // Events
    events: {
        async getAll() {
            const pool = await getPool();
            return readAllEvents(pool);
        },

        async getById(id) {
            const pool = await getPool();
            const result = await pool.request()
                .input('id', id)
                .query('SELECT * FROM [Events] WHERE Id = @id');
            if (result.recordset.length === 0) return null;

            const event = eventRowToJs(result.recordset[0]);

            // Load child tables
            const hd = await pool.request()
                .input('eventId', id)
                .query('SELECT * FROM [EventHotelDates] WHERE EventId = @eventId ORDER BY HotelDate');
            event.hotelDates = hd.recordset.map(r => ({
                date: r.HotelDate instanceof Date ? r.HotelDate.toISOString().split('T')[0] : r.HotelDate,
                dayLabel: r.DayLabel,
                dayLabelFull: r.DayLabelFull
            }));

            const dn = await pool.request()
                .input('eventId', id)
                .query('SELECT * FROM [EventDefaultNights] WHERE EventId = @eventId');
            event.hotelDefaultNights = dn.recordset.map(r => r.NightLabel);

            return event;
        }
    },

    // Users
    users: {
        async getAll() {
            const pool = await getPool();
            const result = await pool.request().query('SELECT * FROM [Users]');
            return result.recordset.map(rowToJs);
        },

        async getById(id) {
            const pool = await getPool();
            const result = await pool.request()
                .input('id', id)
                .query('SELECT * FROM [Users] WHERE Id = @id');
            return result.recordset.length > 0 ? rowToJs(result.recordset[0]) : null;
        },

        async getByEmail(email) {
            const pool = await getPool();
            const result = await pool.request()
                .input('email', email)
                .query('SELECT * FROM [Users] WHERE LOWER(Email) = LOWER(@email)');
            return result.recordset.length > 0 ? rowToJs(result.recordset[0]) : null;
        },

        async getByTeamId(teamId) {
            const pool = await getPool();
            const result = await pool.request()
                .input('teamId', teamId)
                .query('SELECT * FROM [Users] WHERE TeamId = @teamId');
            return result.recordset.map(rowToJs);
        },

        async create(user) {
            const pool = await getPool();
            await insertGeneric(pool, 'Users', user);
            return user;
        },

        async update(id, updates) {
            const pool = await getPool();
            await updateGeneric(pool, 'Users', 'Id', id, {
                ...updates,
                updatedAt: updates.updatedAt || new Date().toISOString()
            });
            const result = await pool.request()
                .input('id', id)
                .query('SELECT * FROM [Users] WHERE Id = @id');
            return result.recordset.length > 0 ? rowToJs(result.recordset[0]) : null;
        },

        async delete(id) {
            const pool = await getPool();
            const result = await pool.request()
                .input('id', id)
                .query('DELETE FROM [Users] WHERE Id = @id');
            return result.rowsAffected[0] > 0;
        }
    },

    // Allowed Emails
    allowedEmails: {
        async getAll() {
            const pool = await getPool();
            const result = await pool.request().query('SELECT * FROM [AllowedEmails]');
            return result.recordset.map(rowToJs);
        },

        async getByEmail(email) {
            const pool = await getPool();
            const result = await pool.request()
                .input('email', email)
                .query('SELECT * FROM [AllowedEmails] WHERE LOWER(Email) = LOWER(@email)');
            return result.recordset.length > 0 ? rowToJs(result.recordset[0]) : null;
        },

        async isAllowed(email) {
            const entry = await this.getByEmail(email);
            return entry && entry.isActive;
        },

        async add(email, addedByUserId = null) {
            const pool = await getPool();
            // Check if already exists
            const existing = await this.getByEmail(email);
            if (existing) return existing;

            const newEntry = {
                email: email.toLowerCase().trim(),
                isActive: true,
                addedAt: new Date().toISOString(),
                addedByUserId: addedByUserId
            };
            await insertGeneric(pool, 'AllowedEmails', newEntry);
            return newEntry;
        },

        async remove(email) {
            const pool = await getPool();
            const result = await pool.request()
                .input('email', email)
                .query('DELETE FROM [AllowedEmails] WHERE LOWER(Email) = LOWER(@email)');
            return result.rowsAffected[0] > 0;
        },

        async deactivate(email) {
            const pool = await getPool();
            const result = await pool.request()
                .input('email', email)
                .query('UPDATE [AllowedEmails] SET IsActive = 0 WHERE LOWER(Email) = LOWER(@email)');
            return result.rowsAffected[0] > 0;
        }
    },

    // Pending Registrations
    pendingRegistrations: {
        async getAll() {
            const pool = await getPool();
            const result = await pool.request().query('SELECT * FROM [PendingRegistrations]');
            return result.recordset.map(rowToJs);
        },

        async getById(id) {
            const pool = await getPool();
            const result = await pool.request()
                .input('id', id)
                .query('SELECT * FROM [PendingRegistrations] WHERE Id = @id');
            return result.recordset.length > 0 ? rowToJs(result.recordset[0]) : null;
        },

        async getByEmail(email) {
            const pool = await getPool();
            const result = await pool.request()
                .input('email', email)
                .query('SELECT * FROM [PendingRegistrations] WHERE LOWER(Email) = LOWER(@email)');
            return result.recordset.length > 0 ? rowToJs(result.recordset[0]) : null;
        },

        async create(registration) {
            const pool = await getPool();
            // Remove any existing record with same id, or same email AND same type
            const isOtpRecord = registration.id && registration.id.startsWith('otp_');
            if (isOtpRecord) {
                // Delete existing OTP records for this email
                await pool.request()
                    .input('email', registration.email)
                    .query(`DELETE FROM [PendingRegistrations]
                            WHERE LOWER(Email) = LOWER(@email)
                            AND Id LIKE 'otp_%'`);
            } else {
                // Delete existing non-OTP records for this email
                await pool.request()
                    .input('email', registration.email)
                    .query(`DELETE FROM [PendingRegistrations]
                            WHERE LOWER(Email) = LOWER(@email)
                            AND Id NOT LIKE 'otp_%'`);
            }
            // Also delete exact id match
            await pool.request()
                .input('id', registration.id)
                .query('DELETE FROM [PendingRegistrations] WHERE Id = @id');

            await insertGeneric(pool, 'PendingRegistrations', registration);
            return registration;
        },

        async delete(id) {
            const pool = await getPool();
            const result = await pool.request()
                .input('id', id)
                .query('DELETE FROM [PendingRegistrations] WHERE Id = @id');
            return result.rowsAffected[0] > 0;
        },

        async cleanupExpired() {
            const pool = await getPool();
            const result = await pool.request()
                .query('DELETE FROM [PendingRegistrations] WHERE ExpiresAt < SYSUTCDATETIME()');
            return result.rowsAffected[0];
        }
    },

    // Interest Leads (read-only from named store; write via GenericStorage)
    interestLeads: {
        async getAll() {
            const pool = await getPool();
            const result = await pool.request().query('SELECT * FROM [InterestLeads]');
            return result.recordset.map(rowToJs);
        }
    },

    // Email Campaigns (read-only from named store; write via GenericStorage)
    emailCampaigns: {
        async getAll() {
            const pool = await getPool();
            const result = await pool.request().query('SELECT * FROM [EmailCampaigns]');
            return result.recordset.map(rowToJs);
        }
    }
};

// ============================================================
// readData / writeData — legacy file-shaped compatibility wrappers on top of SQL
// ============================================================

async function readData(filename) {
    const key = filename.replace('.json', '');
    const config = TABLE_MAP[key];

    if (!config || !config.table) {
        return {};
    }

    const pool = await getPool();

    // Special cases
    if (config.table === 'SystemEmailConfig') {
        return readSystemEmailConfig(pool);
    }
    if (config.table === 'Events') {
        return readAllEvents(pool);
    }
    if (config.table === 'ScheduledRuns') {
        const runs = await readAllScheduledRuns(pool);
        return { runs };
    }
    if (config.table === 'EmailLog') {
        const result = await pool.request().query('SELECT * FROM [EmailLog]');
        return { emails: result.recordset.map(emailLogRowToJs) };
    }
    if (config.table === 'Participations') {
        const result = await pool.request().query('SELECT * FROM [Participations]');
        return { participations: result.recordset.map(participationRowToJs) };
    }

    // Generic case
    const result = await pool.request().query(`SELECT * FROM [${config.table}]`);
    const items = result.recordset.map(rowToJs);

    if (config.wrapperKey) {
        return { [config.wrapperKey]: items };
    }
    return items;
}

async function writeData(filename, data) {
    const key = filename.replace('.json', '');
    const config = TABLE_MAP[key];

    if (!config || !config.table) {
        return true;
    }

    const pool = await getPool();

    // Special cases
    if (config.table === 'SystemEmailConfig') {
        await writeSystemEmailConfig(pool, data);
        return true;
    }
    if (config.table === 'EmailLog') {
        const items = data.emails || [];
        await pool.request().query('DELETE FROM [EmailLog]');
        for (const item of items) {
            await insertEmailLog(pool, item);
        }
        return true;
    }
    if (config.table === 'Events') {
        const items = Array.isArray(data) ? data : (data.events || []);
        await pool.request().query('DELETE FROM [EventDefaultNights]');
        await pool.request().query('DELETE FROM [EventHotelDates]');
        await pool.request().query('DELETE FROM [Events]');
        for (const item of items) {
            await saveEvent(pool, item);
        }
        return true;
    }
    if (config.table === 'Participations') {
        const items = data.participations || (Array.isArray(data) ? data : []);
        await pool.request().query('DELETE FROM [Participations]');
        for (const item of items) {
            await insertParticipation(pool, item);
        }
        return true;
    }
    if (config.table === 'ScheduledRuns') {
        const items = data.runs || (Array.isArray(data) ? data : []);
        await pool.request().query('DELETE FROM [ScheduledRunCampaigns]');
        await pool.request().query('DELETE FROM [ScheduledRuns]');
        for (const item of items) {
            await insertScheduledRun(pool, item);
        }
        return true;
    }

    // Generic case: extract items, delete all, re-insert
    let items;
    if (config.wrapperKey && data && data[config.wrapperKey]) {
        items = data[config.wrapperKey];
    } else if (Array.isArray(data)) {
        items = data;
    } else {
        items = [];
    }

    await pool.request().query(`DELETE FROM [${config.table}]`);
    for (const item of items) {
        await insertGeneric(pool, config.table, item);
    }
    return true;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = Storage;
module.exports.Storage = GenericStorage;
module.exports.readData = readData;
module.exports.writeData = writeData;
