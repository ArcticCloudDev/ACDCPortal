// Regenerate EventDefaultNights for all events using corrected logic:
//   - Default nights are those from startDate (inclusive) up to but NOT including endDate
//   - Extra nights added via hotelDaysBefore/hotelDaysAfter are visible in the calendar
//     but are NOT pre-selected defaults
//
// Usage: cd api && node ../scripts/regenerate-hotel-defaults.js

const sql = require('../api/node_modules/mssql');
const { DefaultAzureCredential } = require('../api/node_modules/@azure/identity');

async function getAccessToken() {
    const credential = new DefaultAzureCredential();
    const token = await credential.getToken('https://database.windows.net/.default');
    return token.token;
}

function generateHotelDates(startDate, endDate, daysBefore = 0, daysAfter = 0) {
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dates = [];

    const start = new Date(startDate + 'T12:00:00');
    start.setDate(start.getDate() - Math.max(0, daysBefore));

    const end = new Date(endDate + 'T12:00:00');
    end.setDate(end.getDate() + Math.max(0, daysAfter));

    const current = new Date(start);
    while (current <= end) {
        const y = current.getFullYear();
        const m = String(current.getMonth() + 1).padStart(2, '0');
        const d = String(current.getDate()).padStart(2, '0');
        dates.push({
            date: `${y}-${m}-${d}`,
            dayLabel: dayLabels[current.getDay()]
        });
        current.setDate(current.getDate() + 1);
    }
    return dates;
}

// Default nights = event-start night through night BEFORE end date (not including end-day checkout)
function generateDefaultHotelNights(hotelDates, eventStartDate, eventEndDate) {
    const defaults = [];
    const dayLabels = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    const eventStart = new Date(eventStartDate + 'T12:00:00');
    const eventEnd   = new Date(eventEndDate   + 'T12:00:00');

    for (let i = 0; i < hotelDates.length - 1; i++) {
        const currentDate = new Date(hotelDates[i].date + 'T12:00:00');
        const nextDate    = new Date(hotelDates[i + 1].date + 'T12:00:00');

        // Include nights that start on or after the event start, and strictly before the event end.
        // This means: thu-fri, fri-sat, sat-sun (when event is Thu-Sun) — but NOT sun-mon.
        if (currentDate >= eventStart && currentDate < eventEnd) {
            const fromDay = dayLabels[currentDate.getDay()];
            const toDay   = dayLabels[nextDate.getDay()];
            defaults.push(`${fromDay}-${toDay}`);
        }
    }
    return defaults;
}

async function main() {
    console.log('[RegenHotelDefaults] Acquiring Entra ID token...');
    const accessToken = await getAccessToken();

    const config = {
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        connectionTimeout: 60000,
        requestTimeout: 60000,
        options: { encrypt: true, trustServerCertificate: false },
        authentication: { type: 'azure-active-directory-access-token', options: { token: accessToken } }
    };

    console.log('[RegenHotelDefaults] Connecting to Azure SQL...');
    const pool = await sql.connect(config);
    console.log('[RegenHotelDefaults] Connected.\n');

    // Load all events
    const eventsResult = await pool.request().query('SELECT * FROM [Events]');
    const events = eventsResult.recordset;
    console.log(`Found ${events.length} event(s).\n`);

    for (const row of events) {
        const id         = row.Id;
        const name       = row.Name;
        const startDate  = row.StartDate instanceof Date ? row.StartDate.toISOString().split('T')[0] : row.StartDate;
        const endDate    = row.EndDate   instanceof Date ? row.EndDate.toISOString().split('T')[0]   : row.EndDate;
        const daysBefore = row.HotelDaysBefore ?? 0;
        const daysAfter  = row.HotelDaysAfter  ?? 0;

        if (!startDate || !endDate) {
            console.log(`  ⏭ Skipping "${name}" — no start/end date.`);
            continue;
        }

        const hotelDates        = generateHotelDates(startDate, endDate, daysBefore, daysAfter);
        const defaultNights     = generateDefaultHotelNights(hotelDates, startDate, endDate);

        console.log(`  Event: "${name}" (${startDate} → ${endDate}), daysBefore=${daysBefore}, daysAfter=${daysAfter}`);
        console.log(`    Hotel dates  : ${hotelDates.map(d => d.dayLabel).join(', ')}`);
        console.log(`    Default nights (new): ${defaultNights.join(', ') || '(none)'}`);

        // Delete and re-insert EventHotelDates
        await pool.request().input('eid', id).query('DELETE FROM [EventHotelDates] WHERE EventId = @eid');
        for (const hd of hotelDates) {
            await pool.request()
                .input('eventId', id)
                .input('hotelDate', hd.date)
                .input('dayLabel', hd.dayLabel)
                .input('dayLabelFull', hd.dayLabel) // full label not critical here
                .query(`INSERT INTO [EventHotelDates] (EventId, HotelDate, DayLabel, DayLabelFull)
                        VALUES (@eventId, @hotelDate, @dayLabel, @dayLabelFull)`);
        }

        // Delete and re-insert EventDefaultNights
        await pool.request().input('eid', id).query('DELETE FROM [EventDefaultNights] WHERE EventId = @eid');
        for (const night of defaultNights) {
            await pool.request()
                .input('eventId', id)
                .input('nightLabel', night)
                .query(`INSERT INTO [EventDefaultNights] (EventId, NightLabel) VALUES (@eventId, @nightLabel)`);
        }

        console.log(`    ✓ Updated.\n`);
    }

    await pool.close();
    console.log('[RegenHotelDefaults] Done.');
}

main().catch(err => {
    console.error('[RegenHotelDefaults] ERROR:', err.message);
    process.exit(1);
});
