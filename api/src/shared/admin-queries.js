// Targeted, parameterised queries for the event/badge/email handlers. These replace
// whole-table GenericStorage.getAll() scans while returning rows in exactly the shape
// storage-sql.js produces (camelCase keys, ISO dates, participation hotelNights/roles).
// Nothing here changes the schema; every column used exists in scripts/create-tables.sql
// or tests/e2e/harness/schema-drift.sql.
const { getPool, sql } = require('./sql');
const { upperId } = require('./validate');

const DATE_ONLY_COLUMNS = new Set(['StartDate', 'EndDate', 'HotelDate']);

function rowToJs(row) {
    const obj = {};
    for (const [key, value] of Object.entries(row)) {
        const jsKey = key.charAt(0).toLowerCase() + key.slice(1);
        if (value instanceof Date) {
            obj[jsKey] = DATE_ONLY_COLUMNS.has(key) ? value.toISOString().split('T')[0] : value.toISOString();
        } else {
            obj[jsKey] = value;
        }
    }
    return obj;
}

function eventRowToJs(row) {
    const obj = rowToJs(row);
    if (obj.fileCategories && typeof obj.fileCategories === 'string') {
        try { obj.fileCategories = JSON.parse(obj.fileCategories); } catch (e) { }
    }
    return obj;
}

function participationRowToJs(row) {
    const obj = {};
    for (const [key, value] of Object.entries(row)) {
        if (key.startsWith('HotelNight_')) continue;
        const jsKey = key.charAt(0).toLowerCase() + key.slice(1);
        obj[jsKey] = value instanceof Date ? value.toISOString() : value;
    }
    if (typeof obj.roles === 'string') {
        obj.roles = obj.roles.split(',').map(r => r.trim()).filter(Boolean);
    } else if (!obj.roles) {
        obj.roles = [];
    }
    if (obj.teamId && !obj.teamMemberships) {
        obj.teamMemberships = [{ teamId: obj.teamId, isAdmin: !!obj.isTeamAdmin, isParticipant: obj.roles.includes('participant') }];
    }
    obj.hotelNights = {
        'mon-tue': !!row.HotelNight_MonTue,
        'tue-wed': !!row.HotelNight_TueWed,
        'wed-thu': !!row.HotelNight_WedThu,
        'thu-fri': !!row.HotelNight_ThuFri,
        'fri-sat': !!row.HotelNight_FriSat,
        'sat-sun': !!row.HotelNight_SatSun,
        'sun-mon': !!row.HotelNight_SunMon
    };
    obj.profileVerification = !!row.ProfileVerification;
    return obj;
}

// shared/auth.js compares p.userId === user.userId; SQL rows are upper-case, so the
// token's userId is normalised the same way before any role check.
function asActor(user) {
    return { ...user, userId: upperId(user.userId) };
}

function unique(values) {
    return [...new Set(values.filter(v => v !== null && v !== undefined && v !== ''))];
}

// Binds `ids` as @prefix0..n and returns the SQL list "(@prefix0, @prefix1)".
function bindList(request, prefix, ids, type = null) {
    const names = ids.map((id, i) => {
        const name = `${prefix}${i}`;
        if (type) request.input(name, type, id); else request.input(name, id);
        return `@${name}`;
    });
    return `(${names.join(', ')})`;
}

async function query(text, bind = () => {}) {
    const pool = await getPool();
    const request = pool.request();
    bind(request);
    return (await request.query(text)).recordset;
}

// Runs fn(makeRequest) inside one transaction; rolls back on any throw.
async function withTransaction(fn) {
    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        const result = await fn(() => new sql.Request(transaction));
        await transaction.commit();
        return result;
    } catch (error) {
        try { await transaction.rollback(); } catch (e) { }
        throw error;
    }
}

// ---- participations / users / teams -------------------------------------------------

async function participationsForUser(userId) {
    if (!userId) return [];
    const rows = await query('SELECT * FROM [Participations] WHERE UserId = @userId', r => r.input('userId', sql.UniqueIdentifier, userId));
    return rows.map(participationRowToJs);
}

async function participationsForEvent(eventId) {
    const rows = await query('SELECT * FROM [Participations] WHERE EventId = @eventId', r => r.input('eventId', sql.UniqueIdentifier, eventId));
    return rows.map(participationRowToJs);
}

async function usersByIds(ids) {
    const list = unique(ids);
    if (list.length === 0) return [];
    const rows = await query(`SELECT * FROM [Users] WHERE Id IN (${list.map((_, i) => `@u${i}`).join(', ')})`,
        r => list.forEach((id, i) => r.input(`u${i}`, sql.UniqueIdentifier, id)));
    return rows.map(rowToJs);
}

async function usersByEmails(emails) {
    const list = unique(emails.map(e => String(e).toLowerCase()));
    if (list.length === 0) return [];
    const rows = await query(`SELECT * FROM [Users] WHERE LOWER(Email) IN (${list.map((_, i) => `@e${i}`).join(', ')})`,
        r => list.forEach((email, i) => r.input(`e${i}`, sql.NVarChar(320), email)));
    return rows.map(rowToJs);
}

async function teamsForEvent(eventId) {
    const rows = await query('SELECT * FROM [Teams] WHERE EventId = @eventId', r => r.input('eventId', sql.UniqueIdentifier, eventId));
    return rows.map(rowToJs);
}

async function teamsByIds(ids) {
    const list = unique(ids);
    if (list.length === 0) return [];
    const rows = await query(`SELECT * FROM [Teams] WHERE Id IN (${list.map((_, i) => `@t${i}`).join(', ')})`,
        r => list.forEach((id, i) => r.input(`t${i}`, sql.UniqueIdentifier, id)));
    return rows.map(rowToJs);
}

async function eventExists(eventId) {
    const rows = await query('SELECT Id FROM [Events] WHERE Id = @id', r => r.input('id', sql.UniqueIdentifier, eventId));
    return rows.length > 0;
}

async function eventBySequenceId(sequenceId) {
    const rows = await query('SELECT * FROM [Events] WHERE SequenceId = @sequenceId', r => r.input('sequenceId', sql.UniqueIdentifier, sequenceId));
    return rows.length ? eventRowToJs(rows[0]) : null;
}

// Rows in FK-bearing tables that would block DELETE FROM Events.
async function eventDependants(eventId) {
    const rows = await query(`
        SELECT 'teams' AS What, COUNT(*) AS Cnt FROM [Teams] WHERE EventId = @id
        UNION ALL SELECT 'participations', COUNT(*) FROM [Participations] WHERE EventId = @id
        UNION ALL SELECT 'invitations', COUNT(*) FROM [Invitations] WHERE EventId = @id
        UNION ALL SELECT 'interest leads', COUNT(*) FROM [InterestLeads] WHERE EventId = @id
        UNION ALL SELECT 'badge assignments', COUNT(*) FROM [EventBadges] WHERE EventId = @id
        UNION ALL SELECT 'badge claims', COUNT(*) FROM [BadgeClaims] WHERE EventId = @id`,
        r => r.input('id', sql.UniqueIdentifier, eventId));
    return rows.filter(r => r.Cnt > 0).map(r => ({ what: r.What, count: r.Cnt }));
}

// Only one event may be pre-registration/registration/live at a time.
async function completeOtherActiveEvents(exceptEventId = null) {
    const pool = await getPool();
    const request = pool.request().input('now', sql.DateTime2, new Date());
    if (exceptEventId) request.input('id', sql.UniqueIdentifier, exceptEventId);
    const result = await request.query(`
        UPDATE [Events] SET Status = 'completed', UpdatedAt = @now
        WHERE Status IN ('pre-registration', 'registration', 'live')${exceptEventId ? ' AND Id <> @id' : ''}`);
    return result.rowsAffected[0];
}

// Rows without an FK that would otherwise be orphaned by an event delete.
async function deleteEventLooseRows(eventId) {
    const pool = await getPool();
    for (const table of ['SoloQueue', 'InterestQueue']) {
        await pool.request().input('id', sql.UniqueIdentifier, eventId).query(`DELETE FROM [${table}] WHERE EventId = @id`);
    }
}

// ---- badges -------------------------------------------------------------------------

async function badgesByIds(ids) {
    const list = unique(ids);
    if (list.length === 0) return [];
    const rows = await query(`SELECT * FROM [Badges] WHERE Id IN (${list.map((_, i) => `@b${i}`).join(', ')})`,
        r => list.forEach((id, i) => r.input(`b${i}`, sql.NVarChar(100), id)));
    return rows.map(rowToJs);
}

async function eventBadgesForEvent(eventId) {
    const rows = await query('SELECT * FROM [EventBadges] WHERE EventId = @eventId', r => r.input('eventId', sql.UniqueIdentifier, eventId));
    return rows.map(rowToJs);
}

// Claims matching every given filter (all optional).
async function claims({ eventId, teamId, status, badgeId, eventBadgeId } = {}) {
    const where = [];
    const pool = await getPool();
    const request = pool.request();
    if (eventId) { request.input('eventId', sql.UniqueIdentifier, eventId); where.push('EventId = @eventId'); }
    if (teamId) { request.input('teamId', sql.UniqueIdentifier, teamId); where.push('TeamId = @teamId'); }
    if (status) { request.input('status', sql.NVarChar(20), status); where.push('Status = @status'); }
    if (badgeId) { request.input('badgeId', sql.NVarChar(100), badgeId); where.push('BadgeId = @badgeId'); }
    if (eventBadgeId) { request.input('eventBadgeId', sql.UniqueIdentifier, eventBadgeId); where.push('EventBadgeId = @eventBadgeId'); }
    const result = await request.query(`SELECT * FROM [BadgeClaims]${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`);
    return result.recordset.map(rowToJs);
}

// Deletes claims -> event assignments -> the badge itself, in one transaction.
async function deleteBadgeCascade(badgeId) {
    return withTransaction(async makeRequest => {
        await makeRequest().input('id', sql.NVarChar(100), badgeId).query('DELETE FROM [BadgeClaims] WHERE BadgeId = @id');
        await makeRequest().input('id', sql.NVarChar(100), badgeId).query('DELETE FROM [EventBadges] WHERE BadgeId = @id');
        const result = await makeRequest().input('id', sql.NVarChar(100), badgeId).query('DELETE FROM [Badges] WHERE Id = @id');
        return result.rowsAffected[0] > 0;
    });
}

// Deletes claims then the event-badge assignments, in one transaction.
async function deleteEventBadgesCascade(eventBadgeIds, makeRequest = null) {
    const list = unique(eventBadgeIds);
    if (list.length === 0) return 0;
    const run = async mk => {
        const inList = r => bindList(r, 'eb', list, sql.UniqueIdentifier);
        const claimsReq = mk();
        await claimsReq.query(`DELETE FROM [BadgeClaims] WHERE EventBadgeId IN ${inList(claimsReq)}`);
        const ebReq = mk();
        const result = await ebReq.query(`DELETE FROM [EventBadges] WHERE Id IN ${inList(ebReq)}`);
        return result.rowsAffected[0];
    };
    return makeRequest ? run(makeRequest) : withTransaction(run);
}

// ---- email campaigns / deliveries -----------------------------------------------------

async function campaignsForSequence(sequenceId, { type = null, status = null } = {}) {
    const rows = await query(`
        SELECT * FROM [EmailCampaigns]
        WHERE SequenceId = @sequenceId
          ${type ? 'AND Type = @type' : ''}
          ${status ? 'AND Status = @status' : ''}`,
        r => {
            r.input('sequenceId', sql.UniqueIdentifier, sequenceId);
            if (type) r.input('type', sql.NVarChar(50), type);
            if (status) r.input('status', sql.NVarChar(50), status);
        });
    return rows.map(rowToJs).sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
}

// Live sequence campaigns whose scheduled time has passed.
async function dueCampaigns(now = new Date()) {
    const rows = await query(`
        SELECT * FROM [EmailCampaigns]
        WHERE Status = 'live' AND Type = 'sequence' AND ScheduledSendTime IS NOT NULL AND ScheduledSendTime <= @now`,
        r => r.input('now', sql.DateTime2, now));
    return rows.map(rowToJs);
}

async function nextSequenceOrder(sequenceId) {
    const rows = await query('SELECT MAX(SequenceOrder) AS MaxOrder, COUNT(*) AS Cnt FROM [EmailCampaigns] WHERE SequenceId = @sequenceId',
        r => r.input('sequenceId', sql.UniqueIdentifier, sequenceId));
    const row = rows[0] || {};
    return Math.max(Number(row.MaxOrder) || 0, Number(row.Cnt) || 0) + 1;
}

// EmailDeliveries.CampaignId is NVARCHAR and holds either GUID case.
async function deliveriesForCampaigns(campaignIds) {
    const list = unique(campaignIds.map(id => String(id).toLowerCase()));
    if (list.length === 0) return [];
    const rows = await query(`SELECT * FROM [EmailDeliveries] WHERE LOWER(CampaignId) IN (${list.map((_, i) => `@c${i}`).join(', ')})`,
        r => list.forEach((id, i) => r.input(`c${i}`, sql.NVarChar(900), id)));
    return rows.map(rowToJs);
}

async function deliveriesForEmail(email) {
    const rows = await query('SELECT * FROM [EmailDeliveries] WHERE LOWER(Email) = LOWER(@email)', r => r.input('email', sql.NVarChar(320), String(email)));
    return rows.map(rowToJs);
}

// { [campaignIdLower]: { total, sent, failed, pending } }
async function deliveryStatsForCampaigns(campaignIds) {
    const list = unique(campaignIds.map(id => String(id).toLowerCase()));
    const stats = {};
    for (const id of list) stats[id] = { total: 0, sent: 0, failed: 0, pending: 0 };
    if (list.length === 0) return stats;
    const rows = await query(`
        SELECT LOWER(CampaignId) AS CampaignId, Status, COUNT(*) AS Cnt
        FROM [EmailDeliveries]
        WHERE LOWER(CampaignId) IN (${list.map((_, i) => `@c${i}`).join(', ')})
        GROUP BY LOWER(CampaignId), Status`,
        r => list.forEach((id, i) => r.input(`c${i}`, sql.NVarChar(900), id)));
    for (const row of rows) {
        const s = stats[row.CampaignId];
        if (!s) continue;
        s.total += row.Cnt;
        if (row.Status in s) s[row.Status] += row.Cnt;
    }
    return stats;
}

// Per sequence: number of campaigns and sent/failed delivery totals.
async function sequenceStats() {
    const rows = await query(`
        SELECT c.SequenceId,
               COUNT(DISTINCT c.Id) AS EmailCount,
               SUM(CASE WHEN d.Status = 'sent' THEN 1 ELSE 0 END) AS Sent,
               SUM(CASE WHEN d.Status = 'failed' THEN 1 ELSE 0 END) AS Failed
        FROM [EmailCampaigns] c
        LEFT JOIN [EmailDeliveries] d ON TRY_CONVERT(uniqueidentifier, d.CampaignId) = c.Id
        WHERE c.SequenceId IS NOT NULL
        GROUP BY c.SequenceId`);
    const out = {};
    for (const row of rows) {
        out[String(row.SequenceId).toLowerCase()] = { emailCount: row.EmailCount, sent: Number(row.Sent) || 0, failed: Number(row.Failed) || 0 };
    }
    return out;
}

// Set of "campaignIdLower|emailLower" for deliveries already sent.
async function sentDeliveryKeys(campaignIds) {
    const keys = new Set();
    for (const d of await deliveriesForCampaigns(campaignIds)) {
        if (d.status === 'sent' && d.email) keys.add(`${String(d.campaignId).toLowerCase()}|${d.email.toLowerCase()}`);
    }
    return keys;
}

async function deleteDeliveriesForCampaigns(campaignIds, makeRequest = null) {
    const list = unique(campaignIds.map(id => String(id).toLowerCase()));
    if (list.length === 0) return 0;
    const request = makeRequest ? makeRequest() : (await getPool()).request();
    const result = await request.query(`DELETE FROM [EmailDeliveries] WHERE LOWER(CampaignId) IN ${bindList(request, 'c', list, sql.NVarChar(900))}`);
    return result.rowsAffected[0];
}

async function deleteDeliveriesForEmail(email) {
    const pool = await getPool();
    const result = await pool.request().input('email', sql.NVarChar(320), String(email))
        .query('DELETE FROM [EmailDeliveries] WHERE LOWER(Email) = LOWER(@email)');
    return result.rowsAffected[0];
}

// Deletes deliveries -> campaigns -> sequence and detaches events, in one transaction.
async function deleteSequenceCascade(sequenceId) {
    return withTransaction(async makeRequest => {
        const campaignRows = await makeRequest().input('id', sql.UniqueIdentifier, sequenceId)
            .query('SELECT Id FROM [EmailCampaigns] WHERE SequenceId = @id');
        await deleteDeliveriesForCampaigns(campaignRows.recordset.map(r => r.Id), makeRequest);
        await makeRequest().input('id', sql.UniqueIdentifier, sequenceId).query('DELETE FROM [EmailCampaigns] WHERE SequenceId = @id');
        await makeRequest().input('id', sql.UniqueIdentifier, sequenceId)
            .query('UPDATE [Events] SET SequenceId = NULL, SequenceEnabled = 0 WHERE SequenceId = @id');
        const result = await makeRequest().input('id', sql.UniqueIdentifier, sequenceId).query('DELETE FROM [Sequences] WHERE Id = @id');
        return result.rowsAffected[0] > 0;
    });
}

// ---- interest / queues / invitations ----------------------------------------------------

async function verifiedLeadsForEvent(eventId) {
    const rows = await query('SELECT * FROM [InterestLeads] WHERE EventId = @eventId AND Verified = 1', r => r.input('eventId', sql.UniqueIdentifier, eventId));
    return rows.map(rowToJs);
}

async function soloQueueForEvent(eventId) {
    const rows = await query('SELECT * FROM [SoloQueue] WHERE EventId = @eventId', r => r.input('eventId', sql.UniqueIdentifier, eventId));
    return rows.map(rowToJs);
}

async function pendingInvitationsForEvent(eventId, teamIds = []) {
    const list = unique(teamIds);
    const rows = await query(`
        SELECT * FROM [Invitations]
        WHERE Status = 'pending' AND (EventId = @eventId${list.length ? ` OR TeamId IN (${list.map((_, i) => `@t${i}`).join(', ')})` : ''})`,
        r => {
            r.input('eventId', sql.UniqueIdentifier, eventId);
            list.forEach((id, i) => r.input(`t${i}`, sql.UniqueIdentifier, id));
        });
    return rows.map(rowToJs);
}

module.exports = {
    rowToJs,
    asActor,
    unique,
    withTransaction,
    participationsForUser,
    participationsForEvent,
    usersByIds,
    usersByEmails,
    teamsForEvent,
    teamsByIds,
    eventExists,
    eventBySequenceId,
    eventDependants,
    completeOtherActiveEvents,
    deleteEventLooseRows,
    badgesByIds,
    eventBadgesForEvent,
    claims,
    deleteBadgeCascade,
    deleteEventBadgesCascade,
    campaignsForSequence,
    dueCampaigns,
    nextSequenceOrder,
    deliveriesForCampaigns,
    deliveriesForEmail,
    deliveryStatsForCampaigns,
    sequenceStats,
    sentDeliveryKeys,
    deleteDeliveriesForCampaigns,
    deleteDeliveriesForEmail,
    deleteSequenceCascade,
    verifiedLeadsForEvent,
    soloQueueForEvent,
    pendingInvitationsForEvent
};
