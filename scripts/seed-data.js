// Seed Script — Migrate JSON data to Azure SQL
// Usage: cd api && node ../scripts/seed-data.js
//
// Prerequisites:
//   - `az login` (Entra ID auth)
//   - Tables already created (run-create-tables.js)
//   - npm packages: mssql, @azure/identity

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { DefaultAzureCredential } = require('@azure/identity');

const DATA_DIR = path.join(__dirname, '..', 'data');

function readJson(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function getAccessToken() {
    const credential = new DefaultAzureCredential();
    const token = await credential.getToken('https://database.windows.net/.default');
    return token.token;
}

async function main() {
    console.log('[Seed] Acquiring Entra ID token...');
    const accessToken = await getAccessToken();

    const config = {
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        connectionTimeout: 60000,
        requestTimeout: 60000,
        options: {
            encrypt: true,
            trustServerCertificate: false
        },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: { token: accessToken }
        }
    };

    console.log('[Seed] Connecting to Azure SQL...');
    const pool = await sql.connect(config);
    console.log('[Seed] Connected.\n');

    try {
        // Seed in FK-respecting order
        await seedEvents(pool);
        await seedEventHotelDates(pool);
        await seedEventDefaultNights(pool);
        await seedSequences(pool);
        await seedUsers(pool);
        await seedTeams(pool);
        await seedBadges(pool);
        await seedAllowedEmails(pool);
        await seedParticipations(pool);
        await seedTeamMemberships(pool);
        await seedInvitations(pool);
        await seedInterestLeads(pool);
        await seedEventBadges(pool);
        await seedBadgeClaims(pool);
        await seedEmailCampaigns(pool);
        await seedEmailDeliveries(pool);
        await seedEmailLog(pool);
        await seedScheduledRuns(pool);
        await seedSystemEmailConfig(pool);

        console.log('\n[Seed] === Verification ===');
        const result = await pool.request().query(`
            SELECT 'Events' AS T, COUNT(*) AS C FROM Events UNION ALL
            SELECT 'EventHotelDates', COUNT(*) FROM EventHotelDates UNION ALL
            SELECT 'EventDefaultNights', COUNT(*) FROM EventDefaultNights UNION ALL
            SELECT 'Sequences', COUNT(*) FROM Sequences UNION ALL
            SELECT 'Users', COUNT(*) FROM Users UNION ALL
            SELECT 'Teams', COUNT(*) FROM Teams UNION ALL
            SELECT 'Badges', COUNT(*) FROM Badges UNION ALL
            SELECT 'AllowedEmails', COUNT(*) FROM AllowedEmails UNION ALL
            SELECT 'Participations', COUNT(*) FROM Participations UNION ALL
            SELECT 'TeamMemberships', COUNT(*) FROM TeamMemberships UNION ALL
            SELECT 'Invitations', COUNT(*) FROM Invitations UNION ALL
            SELECT 'InterestLeads', COUNT(*) FROM InterestLeads UNION ALL
            SELECT 'EventBadges', COUNT(*) FROM EventBadges UNION ALL
            SELECT 'BadgeClaims', COUNT(*) FROM BadgeClaims UNION ALL
            SELECT 'EmailCampaigns', COUNT(*) FROM EmailCampaigns UNION ALL
            SELECT 'EmailDeliveries', COUNT(*) FROM EmailDeliveries UNION ALL
            SELECT 'EmailLog', COUNT(*) FROM EmailLog UNION ALL
            SELECT 'ScheduledRuns', COUNT(*) FROM ScheduledRuns UNION ALL
            SELECT 'ScheduledRunCampaigns', COUNT(*) FROM ScheduledRunCampaigns UNION ALL
            SELECT 'SystemEmailConfig', COUNT(*) FROM SystemEmailConfig
            ORDER BY T
        `);
        console.table(result.recordset);
        console.log('\n[Seed] Done!');
    } finally {
        await pool.close();
    }
}

// ---- Seed Functions ----

async function seedEvents(pool) {
    const data = readJson('events.json');
    if (!data) return;
    const events = Array.isArray(data) ? data : (data.events || []);
    console.log(`[Seed] Events: ${events.length} rows`);

    for (const e of events) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, e.id)
            .input('name', sql.NVarChar, e.name)
            .input('description', sql.NVarChar, e.description || null)
            .input('startDate', sql.Date, e.startDate)
            .input('endDate', sql.Date, e.endDate)
            .input('location', sql.NVarChar, e.location || null)
            .input('status', sql.NVarChar, e.status || 'draft')
            .input('registrationType', sql.NVarChar, e.registrationType || 'team')
            .input('registrationOpen', sql.Bit, e.registrationOpen ? 1 : 0)
            .input('isActive', sql.Bit, e.isActive ? 1 : 0)
            .input('minTeamSize', sql.Int, e.minTeamSize ?? null)
            .input('maxTeamSize', sql.Int, e.maxTeamSize ?? null)
            .input('sequenceId', sql.UniqueIdentifier, e.sequenceId || null)
            .input('sequenceEnabled', sql.Bit, e.sequenceEnabled ? 1 : 0)
            .input('committeeTeamId', sql.UniqueIdentifier, e.committeeTeamId || null)
            .input('judgesTeamId', sql.UniqueIdentifier, e.judgesTeamId || null)
            .input('fileCategories', sql.NVarChar, e.fileCategories ? JSON.stringify(e.fileCategories) : null)
            .input('sendWelcomeEmail', sql.Bit, e.sendWelcomeEmail ? 1 : 0)
            .input('sendInterestAcknowledgment', sql.Bit, e.sendInterestAcknowledgment ? 1 : 0)
            .input('sendJudgeInvitationEmail', sql.Bit, e.sendJudgeInvitationEmail ? 1 : 0)
            .input('sendCommitteeInvitationEmail', sql.Bit, e.sendCommitteeInvitationEmail ? 1 : 0)
            .input('teamWelcomeEmailId', sql.UniqueIdentifier, e.teamWelcomeEmailId || null)
            .input('sharepointUrl', sql.NVarChar, e.sharepointUrl || null)
            .input('createdAt', sql.DateTime2, e.createdAt)
            .input('updatedAt', sql.DateTime2, e.updatedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM Events WHERE Id = @id)
                INSERT INTO Events (Id, Name, Description, StartDate, EndDate, Location, Status, RegistrationType, RegistrationOpen, IsActive, MinTeamSize, MaxTeamSize, SequenceId, SequenceEnabled, CommitteeTeamId, JudgesTeamId, FileCategories, SendWelcomeEmail, SendInterestAcknowledgment, SendJudgeInvitationEmail, SendCommitteeInvitationEmail, TeamWelcomeEmailId, SharepointUrl, CreatedAt, UpdatedAt)
                VALUES (@id, @name, @description, @startDate, @endDate, @location, @status, @registrationType, @registrationOpen, @isActive, @minTeamSize, @maxTeamSize, @sequenceId, @sequenceEnabled, @committeeTeamId, @judgesTeamId, @fileCategories, @sendWelcomeEmail, @sendInterestAcknowledgment, @sendJudgeInvitationEmail, @sendCommitteeInvitationEmail, @teamWelcomeEmailId, @sharepointUrl, @createdAt, @updatedAt)
            `);
    }
}

async function seedEventHotelDates(pool) {
    const data = readJson('events.json');
    if (!data) return;
    const events = Array.isArray(data) ? data : (data.events || []);
    let count = 0;

    for (const e of events) {
        if (!e.hotelDates || !Array.isArray(e.hotelDates)) continue;
        for (const hd of e.hotelDates) {
            await pool.request()
                .input('eventId', sql.UniqueIdentifier, e.id)
                .input('hotelDate', sql.Date, hd.date)
                .input('dayLabel', sql.NVarChar, hd.dayLabel || '')
                .input('dayLabelFull', sql.NVarChar, hd.dayLabelFull || '')
                .query(`
                    IF NOT EXISTS (SELECT 1 FROM EventHotelDates WHERE EventId = @eventId AND HotelDate = @hotelDate)
                    INSERT INTO EventHotelDates (EventId, HotelDate, DayLabel, DayLabelFull)
                    VALUES (@eventId, @hotelDate, @dayLabel, @dayLabelFull)
                `);
            count++;
        }
    }
    console.log(`[Seed] EventHotelDates: ${count} rows`);
}

async function seedEventDefaultNights(pool) {
    const data = readJson('events.json');
    if (!data) return;
    const events = Array.isArray(data) ? data : (data.events || []);
    let count = 0;

    for (const e of events) {
        if (!e.hotelDefaultNights || !Array.isArray(e.hotelDefaultNights)) continue;
        for (const night of e.hotelDefaultNights) {
            await pool.request()
                .input('eventId', sql.UniqueIdentifier, e.id)
                .input('nightLabel', sql.NVarChar, night)
                .query(`
                    IF NOT EXISTS (SELECT 1 FROM EventDefaultNights WHERE EventId = @eventId AND NightLabel = @nightLabel)
                    INSERT INTO EventDefaultNights (EventId, NightLabel)
                    VALUES (@eventId, @nightLabel)
                `);
            count++;
        }
    }
    console.log(`[Seed] EventDefaultNights: ${count} rows`);
}

async function seedSequences(pool) {
    const data = readJson('sequences.json');
    if (!data) return;
    const sequences = data.sequences || (Array.isArray(data) ? data : []);
    console.log(`[Seed] Sequences: ${sequences.length} rows`);

    for (const s of sequences) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, s.id)
            .input('name', sql.NVarChar, s.name)
            .input('description', sql.NVarChar, s.description || null)
            .input('createdAt', sql.DateTime2, s.createdAt)
            .input('updatedAt', sql.DateTime2, s.updatedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM Sequences WHERE Id = @id)
                INSERT INTO Sequences (Id, Name, Description, CreatedAt, UpdatedAt)
                VALUES (@id, @name, @description, @createdAt, @updatedAt)
            `);
    }
}

async function seedUsers(pool) {
    const data = readJson('users.json');
    if (!data) return;
    const users = Array.isArray(data) ? data : (data.users || []);
    console.log(`[Seed] Users: ${users.length} rows`);

    for (const u of users) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, u.id)
            .input('email', sql.NVarChar, u.email)
            .input('firstName', sql.NVarChar, u.firstName)
            .input('lastName', sql.NVarChar, u.lastName)
            .input('phone', sql.NVarChar, u.phone || null)
            .input('gamertag', sql.NVarChar, u.gamertag || null)
            .input('allergies', sql.NVarChar, u.allergies || null)
            .input('isPortalAdmin', sql.Bit, u.isPortalAdmin ? 1 : 0)
            .input('profileComplete', sql.Bit, u.profileComplete ? 1 : 0)
            .input('teamId', sql.UniqueIdentifier, u.teamId || null)
            .input('createdAt', sql.DateTime2, u.createdAt)
            .input('updatedAt', sql.DateTime2, u.updatedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM Users WHERE Id = @id)
                INSERT INTO Users (Id, Email, FirstName, LastName, Phone, Gamertag, Allergies, IsPortalAdmin, ProfileComplete, TeamId, CreatedAt, UpdatedAt)
                VALUES (@id, @email, @firstName, @lastName, @phone, @gamertag, @allergies, @isPortalAdmin, @profileComplete, @teamId, @createdAt, @updatedAt)
            `);
    }
}

async function seedTeams(pool) {
    const data = readJson('teams.json');
    if (!data) return;
    const teams = Array.isArray(data) ? data : (data.teams || []);
    console.log(`[Seed] Teams: ${teams.length} rows`);

    for (const t of teams) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, t.id)
            .input('teamName', sql.NVarChar, t.teamName)
            .input('eventId', sql.UniqueIdentifier, t.eventId)
            .input('numberOfParticipants', sql.Int, t.numberOfParticipants ?? null)
            .input('adminUserId', sql.UniqueIdentifier, t.adminUserId || null)
            .input('isSpecialTeam', sql.Bit, t.isSpecialTeam ? 1 : 0)
            .input('specialTeamType', sql.NVarChar, t.specialTeamType || null)
            .input('createdAt', sql.DateTime2, t.createdAt)
            .input('updatedAt', sql.DateTime2, t.updatedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM Teams WHERE Id = @id)
                INSERT INTO Teams (Id, TeamName, EventId, NumberOfParticipants, AdminUserId, IsSpecialTeam, SpecialTeamType, CreatedAt, UpdatedAt)
                VALUES (@id, @teamName, @eventId, @numberOfParticipants, @adminUserId, @isSpecialTeam, @specialTeamType, @createdAt, @updatedAt)
            `);
    }
}

async function seedBadges(pool) {
    const data = readJson('badges.json');
    if (!data) return;
    const badges = Array.isArray(data) ? data : (data.badges || []);
    console.log(`[Seed] Badges: ${badges.length} rows`);

    for (const b of badges) {
        await pool.request()
            .input('id', sql.NVarChar, b.id)
            .input('name', sql.NVarChar, b.name)
            .input('description', sql.NVarChar, b.description || null)
            .input('category', sql.NVarChar, b.category || 'soft')
            .input('claimType', sql.NVarChar, b.claimType || null)
            .input('imageUrl', sql.NVarChar, b.imageUrl || null)
            .input('points', sql.Int, b.points ?? 0)
            .input('createdAt', sql.DateTime2, b.createdAt)
            .input('updatedAt', sql.DateTime2, b.updatedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM Badges WHERE Id = @id)
                INSERT INTO Badges (Id, Name, Description, Category, ClaimType, ImageUrl, Points, CreatedAt, UpdatedAt)
                VALUES (@id, @name, @description, @category, @claimType, @imageUrl, @points, @createdAt, @updatedAt)
            `);
    }
}

async function seedAllowedEmails(pool) {
    const data = readJson('allowed-emails.json');
    if (!data) return;
    const emails = Array.isArray(data) ? data : (data.emails || []);
    console.log(`[Seed] AllowedEmails: ${emails.length} rows`);

    for (const e of emails) {
        await pool.request()
            .input('email', sql.NVarChar, e.email)
            .input('isActive', sql.Bit, e.isActive ? 1 : 0)
            .input('addedAt', sql.DateTime2, e.addedAt)
            .input('addedByUserId', sql.UniqueIdentifier, e.addedByUserId || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM AllowedEmails WHERE Email = @email)
                INSERT INTO AllowedEmails (Email, IsActive, AddedAt, AddedByUserId)
                VALUES (@email, @isActive, @addedAt, @addedByUserId)
            `);
    }
}

async function seedParticipations(pool) {
    const data = readJson('participations.json');
    if (!data) return;
    const participations = Array.isArray(data) ? data : (data.participations || []);
    console.log(`[Seed] Participations: ${participations.length} rows`);

    for (const p of participations) {
        // Map hotel nights from the JSON structure to BIT columns
        const hotelNights = p.hotelNights || {};
        await pool.request()
            .input('id', sql.UniqueIdentifier, p.id)
            .input('userId', sql.UniqueIdentifier, p.userId || null)
            .input('email', sql.NVarChar, p.email)
            .input('eventId', sql.UniqueIdentifier, p.eventId)
            .input('roles', sql.NVarChar, Array.isArray(p.roles) ? p.roles.join(',') : (p.roles || null))
            .input('teamId', sql.UniqueIdentifier, p.teamId || null)
            .input('isTeamAdmin', sql.Bit, p.isTeamAdmin ? 1 : 0)
            .input('hotelMonTue', sql.Bit, hotelNights['mon-tue'] ? 1 : 0)
            .input('hotelTueWed', sql.Bit, hotelNights['tue-wed'] ? 1 : 0)
            .input('hotelWedThu', sql.Bit, hotelNights['wed-thu'] ? 1 : 0)
            .input('hotelThuFri', sql.Bit, hotelNights['thu-fri'] ? 1 : 0)
            .input('hotelFriSat', sql.Bit, hotelNights['fri-sat'] ? 1 : 0)
            .input('hotelSatSun', sql.Bit, hotelNights['sat-sun'] ? 1 : 0)
            .input('hotelSunMon', sql.Bit, hotelNights['sun-mon'] ? 1 : 0)
            .input('hotelPaidBy', sql.NVarChar, p.hotelPaidBy || null)
            .input('convertedFrom', sql.NVarChar, p.convertedFrom || null)
            .input('convertedAt', sql.DateTime2, p.convertedAt || null)
            .input('convertedVia', sql.NVarChar, p.convertedVia || null)
            .input('invitationId', sql.UniqueIdentifier, p.invitationId || null)
            .input('createdAt', sql.DateTime2, p.createdAt)
            .input('updatedAt', sql.DateTime2, p.updatedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM Participations WHERE Id = @id)
                INSERT INTO Participations (Id, UserId, Email, EventId, Roles, TeamId, IsTeamAdmin, HotelNight_MonTue, HotelNight_TueWed, HotelNight_WedThu, HotelNight_ThuFri, HotelNight_FriSat, HotelNight_SatSun, HotelNight_SunMon, HotelPaidBy, ConvertedFrom, ConvertedAt, ConvertedVia, InvitationId, CreatedAt, UpdatedAt)
                VALUES (@id, @userId, @email, @eventId, @roles, @teamId, @isTeamAdmin, @hotelMonTue, @hotelTueWed, @hotelWedThu, @hotelThuFri, @hotelFriSat, @hotelSatSun, @hotelSunMon, @hotelPaidBy, @convertedFrom, @convertedAt, @convertedVia, @invitationId, @createdAt, @updatedAt)
            `);
    }
}

async function seedTeamMemberships(pool) {
    const data = readJson('participations.json');
    if (!data) return;
    const participations = Array.isArray(data) ? data : (data.participations || []);
    let count = 0;

    for (const p of participations) {
        // TeamMemberships come from participations that have a teamId
        if (!p.teamId) continue;
        await pool.request()
            .input('participationId', sql.UniqueIdentifier, p.id)
            .input('teamId', sql.UniqueIdentifier, p.teamId)
            .input('isAdmin', sql.Bit, p.isTeamAdmin ? 1 : 0)
            .input('isParticipant', sql.Bit, 1)
            .input('joinedAt', sql.DateTime2, p.convertedAt || p.createdAt)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM TeamMemberships WHERE ParticipationId = @participationId AND TeamId = @teamId)
                INSERT INTO TeamMemberships (ParticipationId, TeamId, IsAdmin, IsParticipant, JoinedAt)
                VALUES (@participationId, @teamId, @isAdmin, @isParticipant, @joinedAt)
            `);
        count++;
    }
    console.log(`[Seed] TeamMemberships: ${count} rows`);
}

async function seedInvitations(pool) {
    const data = readJson('invitations.json');
    if (!data) return;
    const invitations = Array.isArray(data) ? data : (data.invitations || []);
    console.log(`[Seed] Invitations: ${invitations.length} rows`);

    for (const inv of invitations) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, inv.id)
            .input('email', sql.NVarChar, inv.email)
            .input('inviteeFirstName', sql.NVarChar, inv.inviteeFirstName || null)
            .input('inviteeLastName', sql.NVarChar, inv.inviteeLastName || null)
            .input('teamId', sql.UniqueIdentifier, inv.teamId || null)
            .input('teamName', sql.NVarChar, inv.teamName || null)
            .input('eventId', sql.UniqueIdentifier, inv.eventId || null)
            .input('role', sql.NVarChar, inv.role || null)
            .input('inviterId', sql.UniqueIdentifier, inv.inviterId)
            .input('inviterName', sql.NVarChar, inv.inviterName || null)
            .input('inviterEmail', sql.NVarChar, inv.inviterEmail || null)
            .input('message', sql.NVarChar, inv.message || null)
            .input('status', sql.NVarChar, inv.status || 'pending')
            .input('createdAt', sql.DateTime2, inv.createdAt)
            .input('expiresAt', sql.DateTime2, inv.expiresAt || null)
            .input('acceptedAt', sql.DateTime2, inv.acceptedAt || null)
            .input('acceptedBy', sql.UniqueIdentifier, inv.acceptedBy || null)
            .input('cancelledAt', sql.DateTime2, inv.cancelledAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM Invitations WHERE Id = @id)
                INSERT INTO Invitations (Id, Email, InviteeFirstName, InviteeLastName, TeamId, TeamName, EventId, Role, InviterId, InviterName, InviterEmail, Message, Status, CreatedAt, ExpiresAt, AcceptedAt, AcceptedBy, CancelledAt)
                VALUES (@id, @email, @inviteeFirstName, @inviteeLastName, @teamId, @teamName, @eventId, @role, @inviterId, @inviterName, @inviterEmail, @message, @status, @createdAt, @expiresAt, @acceptedAt, @acceptedBy, @cancelledAt)
            `);
    }
}

async function seedInterestLeads(pool) {
    const data = readJson('interest-leads.json');
    if (!data) return;
    const leads = data.leads || (Array.isArray(data) ? data : []);
    console.log(`[Seed] InterestLeads: ${leads.length} rows`);

    for (const l of leads) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, l.id)
            .input('eventId', sql.UniqueIdentifier, l.eventId)
            .input('email', sql.NVarChar, l.email)
            .input('firstName', sql.NVarChar, l.firstName)
            .input('lastName', sql.NVarChar, l.lastName)
            .input('verificationCode', sql.NVarChar, l.verificationCode || null)
            .input('codeExpiresAt', sql.DateTime2, l.codeExpiresAt || null)
            .input('verified', sql.Bit, l.verified ? 1 : 0)
            .input('verifiedAt', sql.DateTime2, l.verifiedAt || null)
            .input('createdAt', sql.DateTime2, l.createdAt)
            .input('updatedAt', sql.DateTime2, l.updatedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM InterestLeads WHERE Id = @id)
                INSERT INTO InterestLeads (Id, EventId, Email, FirstName, LastName, VerificationCode, CodeExpiresAt, Verified, VerifiedAt, CreatedAt, UpdatedAt)
                VALUES (@id, @eventId, @email, @firstName, @lastName, @verificationCode, @codeExpiresAt, @verified, @verifiedAt, @createdAt, @updatedAt)
            `);
    }
}

async function seedEventBadges(pool) {
    const data = readJson('event-badges.json');
    if (!data) return;
    const eventBadges = Array.isArray(data) ? data : (data.eventBadges || []);
    console.log(`[Seed] EventBadges: ${eventBadges.length} rows`);

    for (const eb of eventBadges) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, eb.id)
            .input('eventId', sql.UniqueIdentifier, eb.eventId)
            .input('badgeId', sql.NVarChar, eb.badgeId)
            .input('judgeUserId', sql.UniqueIdentifier, eb.judgeUserId || null)
            .input('isActive', sql.Bit, eb.isActive ? 1 : 0)
            .input('createdAt', sql.DateTime2, eb.createdAt)
            .input('updatedAt', sql.DateTime2, eb.updatedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM EventBadges WHERE Id = @id)
                INSERT INTO EventBadges (Id, EventId, BadgeId, JudgeUserId, IsActive, CreatedAt, UpdatedAt)
                VALUES (@id, @eventId, @badgeId, @judgeUserId, @isActive, @createdAt, @updatedAt)
            `);
    }
}

async function seedBadgeClaims(pool) {
    const data = readJson('badge-claims.json');
    if (!data) return;
    const claims = Array.isArray(data) ? data : (data.claims || []);
    console.log(`[Seed] BadgeClaims: ${claims.length} rows`);

    for (const c of claims) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, c.id)
            .input('eventBadgeId', sql.UniqueIdentifier, c.eventBadgeId)
            .input('eventId', sql.UniqueIdentifier, c.eventId)
            .input('badgeId', sql.NVarChar, c.badgeId)
            .input('teamId', sql.UniqueIdentifier, c.teamId || null)
            .input('status', sql.NVarChar, c.status || 'pending')
            .input('blogUrl', sql.NVarChar, c.blogUrl || null)
            .input('evidence', sql.NVarChar, c.evidence || null)
            .input('assignedToUserId', sql.UniqueIdentifier, c.assignedToUserId || null)
            .input('claimedBy', sql.UniqueIdentifier, c.claimedBy || null)
            .input('claimedAt', sql.DateTime2, c.claimedAt || null)
            .input('declineReason', sql.NVarChar, c.declineReason || null)
            .input('reviewedBy', sql.UniqueIdentifier, c.reviewedBy || null)
            .input('reviewedAt', sql.DateTime2, c.reviewedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM BadgeClaims WHERE Id = @id)
                INSERT INTO BadgeClaims (Id, EventBadgeId, EventId, BadgeId, TeamId, Status, BlogUrl, Evidence, AssignedToUserId, ClaimedBy, ClaimedAt, DeclineReason, ReviewedBy, ReviewedAt)
                VALUES (@id, @eventBadgeId, @eventId, @badgeId, @teamId, @status, @blogUrl, @evidence, @assignedToUserId, @claimedBy, @claimedAt, @declineReason, @reviewedBy, @reviewedAt)
            `);
    }
}

async function seedEmailCampaigns(pool) {
    const data = readJson('email-campaigns.json');
    if (!data) return;
    const campaigns = data.campaigns || (Array.isArray(data) ? data : []);
    console.log(`[Seed] EmailCampaigns: ${campaigns.length} rows`);

    for (const c of campaigns) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, c.id)
            .input('sequenceId', sql.UniqueIdentifier, c.sequenceId || null)
            .input('subject', sql.NVarChar, c.subject)
            .input('content', sql.NVarChar, c.content || null)
            .input('ctaUrl', sql.NVarChar, c.ctaUrl || null)
            .input('ctaText', sql.NVarChar, c.ctaText || null)
            .input('type', sql.NVarChar, c.type || 'sequence')
            .input('sequenceOrder', sql.Int, c.sequenceOrder ?? null)
            .input('status', sql.NVarChar, c.status || 'draft')
            .input('scheduledSendTime', sql.DateTime2, c.scheduledSendTime || null)
            .input('createdAt', sql.DateTime2, c.createdAt)
            .input('createdBy', sql.UniqueIdentifier, c.createdBy || null)
            .input('updatedAt', sql.DateTime2, c.updatedAt || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM EmailCampaigns WHERE Id = @id)
                INSERT INTO EmailCampaigns (Id, SequenceId, Subject, Content, CtaUrl, CtaText, Type, SequenceOrder, Status, ScheduledSendTime, CreatedAt, CreatedBy, UpdatedAt)
                VALUES (@id, @sequenceId, @subject, @content, @ctaUrl, @ctaText, @type, @sequenceOrder, @status, @scheduledSendTime, @createdAt, @createdBy, @updatedAt)
            `);
    }
}

async function seedEmailDeliveries(pool) {
    const data = readJson('email-deliveries.json');
    if (!data) return;
    const deliveries = data.deliveries || (Array.isArray(data) ? data : []);
    console.log(`[Seed] EmailDeliveries: ${deliveries.length} rows`);

    for (const d of deliveries) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, d.id)
            .input('campaignId', sql.NVarChar, d.campaignId)
            .input('email', sql.NVarChar, d.email)
            .input('leadId', sql.UniqueIdentifier, d.leadId || null)
            .input('userId', sql.UniqueIdentifier, d.userId || null)
            .input('status', sql.NVarChar, d.status || 'pending')
            .input('sentAt', sql.DateTime2, d.sentAt || null)
            .input('digestId', sql.UniqueIdentifier, d.digestId || null)
            .input('isDigest', sql.Bit, d.isDigest ? 1 : 0)
            .input('digestCount', sql.Int, d.digestCount ?? null)
            .input('sentVia', sql.NVarChar, d.sentVia || null)
            .input('scheduledSend', sql.Bit, d.scheduledSend ? 1 : 0)
            .input('createdAt', sql.DateTime2, d.createdAt)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM EmailDeliveries WHERE Id = @id)
                INSERT INTO EmailDeliveries (Id, CampaignId, Email, LeadId, UserId, Status, SentAt, DigestId, IsDigest, DigestCount, SentVia, ScheduledSend, CreatedAt)
                VALUES (@id, @campaignId, @email, @leadId, @userId, @status, @sentAt, @digestId, @isDigest, @digestCount, @sentVia, @scheduledSend, @createdAt)
            `);
    }
}

async function seedEmailLog(pool) {
    const data = readJson('email-log.json');
    if (!data) return;
    const emails = data.emails || (Array.isArray(data) ? data : []);
    console.log(`[Seed] EmailLog: ${emails.length} rows`);

    for (const e of emails) {
        const results = e.results || {};
        await pool.request()
            .input('id', sql.UniqueIdentifier, e.id)
            .input('templateId', sql.NVarChar, e.templateId || null)
            .input('subject', sql.NVarChar, e.subject || null)
            .input('recipientCount', sql.Int, e.recipientCount ?? 0)
            .input('sentAt', sql.DateTime2, e.sentAt || null)
            .input('resultsSent', sql.Int, results.sent ?? 0)
            .input('resultsFailed', sql.Int, results.failed ?? 0)
            .input('resultsErrors', sql.NVarChar, results.errors && results.errors.length > 0 ? JSON.stringify(results.errors) : null)
            .input('status', sql.NVarChar, e.status || 'pending')
            .input('source', sql.NVarChar, e.source || null)
            .input('campaignId', sql.UniqueIdentifier, e.campaignId || null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM EmailLog WHERE Id = @id)
                INSERT INTO EmailLog (Id, TemplateId, Subject, RecipientCount, SentAt, ResultsSent, ResultsFailed, ResultsErrors, Status, Source, CampaignId)
                VALUES (@id, @templateId, @subject, @recipientCount, @sentAt, @resultsSent, @resultsFailed, @resultsErrors, @status, @source, @campaignId)
            `);
    }
}

async function seedScheduledRuns(pool) {
    const data = readJson('scheduled-runs.json');
    if (!data) return;
    const runs = data.runs || (Array.isArray(data) ? data : []);
    console.log(`[Seed] ScheduledRuns: ${runs.length} rows`);

    for (const r of runs) {
        await pool.request()
            .input('id', sql.UniqueIdentifier, r.id)
            .input('startTime', sql.DateTime2, r.startTime)
            .input('endTime', sql.DateTime2, r.endTime || null)
            .input('duration', sql.Decimal(10, 3), r.duration ?? null)
            .input('emailsSent', sql.Int, r.emailsSent ?? 0)
            .input('emailsFailed', sql.Int, r.emailsFailed ?? 0)
            .input('campaignsProcessed', sql.Int, r.campaignsProcessed ?? 0)
            .input('error', sql.NVarChar, r.error || null)
            .input('status', sql.NVarChar, r.status || 'running')
            .query(`
                IF NOT EXISTS (SELECT 1 FROM ScheduledRuns WHERE Id = @id)
                INSERT INTO ScheduledRuns (Id, StartTime, EndTime, Duration, EmailsSent, EmailsFailed, CampaignsProcessed, Error, Status)
                VALUES (@id, @startTime, @endTime, @duration, @emailsSent, @emailsFailed, @campaignsProcessed, @error, @status)
            `);

        // Seed the campaign details for this run
        if (r.campaigns && Array.isArray(r.campaigns)) {
            for (const c of r.campaigns) {
                await pool.request()
                    .input('scheduledRunId', sql.UniqueIdentifier, r.id)
                    .input('campaignId', sql.UniqueIdentifier, c.id)
                    .input('subject', sql.NVarChar, c.subject || null)
                    .input('recipients', sql.Int, c.recipients ?? 0)
                    .query(`
                        IF NOT EXISTS (SELECT 1 FROM ScheduledRunCampaigns WHERE ScheduledRunId = @scheduledRunId AND CampaignId = @campaignId)
                        INSERT INTO ScheduledRunCampaigns (ScheduledRunId, CampaignId, Subject, Recipients)
                        VALUES (@scheduledRunId, @campaignId, @subject, @recipients)
                    `);
            }
        }
    }
}

async function seedSystemEmailConfig(pool) {
    const data = readJson('system-email-config.json');
    if (!data || !data.templates) return;
    const templates = data.templates;
    const keys = Object.keys(templates);
    console.log(`[Seed] SystemEmailConfig: ${keys.length} rows`);

    for (const key of keys) {
        const t = templates[key];
        await pool.request()
            .input('templateKey', sql.NVarChar, key)
            .input('name', sql.NVarChar, t.name)
            .input('subject', sql.NVarChar, t.subject)
            .input('mergeFields', sql.NVarChar, t.mergeFields ? JSON.stringify(t.mergeFields) : null)
            .input('editableSections', sql.NVarChar, t.editableSections ? JSON.stringify(t.editableSections) : null)
            .input('eventThemes', sql.NVarChar, t.eventThemes ? JSON.stringify(t.eventThemes) : null)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM SystemEmailConfig WHERE TemplateKey = @templateKey)
                INSERT INTO SystemEmailConfig (TemplateKey, Name, Subject, MergeFields, EditableSections, EventThemes)
                VALUES (@templateKey, @name, @subject, @mergeFields, @editableSections, @eventThemes)
            `);
    }
}

main().catch(err => {
    console.error('[Seed] Fatal error:', err.message);
    process.exit(1);
});
