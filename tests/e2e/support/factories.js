// Row builders for seeding. IDs are UPPERCASE GUIDs because that is how SQL Server
// returns UNIQUEIDENTIFIER through tedious, and the API compares IDs with ===.
const crypto = require('node:crypto');

let counter = 0;
const next = () => ++counter;
const id = () => crypto.randomUUID().toUpperCase();

function isoDate(daysFromNow) {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
}

function event(overrides = {}) {
    const n = next();
    return {
        id: id(),
        name: `E2E Event ${n}`,
        description: `Description for event ${n}`,
        startDate: isoDate(60),
        endDate: isoDate(62),
        location: 'Oslo Spektrum',
        status: 'registration',
        registrationType: 'team',
        registrationOpen: true,
        isActive: true,
        minTeamSize: 3,
        maxTeamSize: 5,
        sequenceEnabled: false,
        sendWelcomeEmail: false,
        sendInterestAcknowledgment: false,
        sendJudgeInvitationEmail: true,
        sendCommitteeInvitationEmail: true,
        sendTeamRegistrationEmail: false,
        hotelEnabled: false,
        hotelMandatory: false,
        hotelDaysBefore: 0,
        hotelDaysAfter: 0,
        currency: 'NOK',
        createdAt: new Date().toISOString(),
        hotelDates: [],
        hotelDefaultNights: [],
        ...overrides
    };
}

function user(overrides = {}) {
    const n = next();
    const firstName = overrides.firstName || `First${n}`;
    const lastName = overrides.lastName || `Last${n}`;
    return {
        id: id(),
        email: `user${n}.${crypto.randomBytes(3).toString('hex')}@e2e.test`,
        firstName,
        lastName,
        phone: '+47 900 00 000',
        gamertag: null,
        allergies: null,
        isPortalAdmin: false,
        profileComplete: true,
        createdAt: new Date().toISOString(),
        ...overrides
    };
}

const admin = (overrides = {}) => user({ firstName: 'Ada', lastName: 'Admin', isPortalAdmin: true, ...overrides });

function team(evt, adminUser, overrides = {}) {
    return {
        id: id(),
        teamName: `Team ${next()}`,
        eventId: evt.id,
        numberOfParticipants: 3,
        adminUserId: adminUser ? adminUser.id : null,
        isSpecialTeam: false,
        createdAt: new Date().toISOString(),
        ...overrides
    };
}

function participation(u, evt, overrides = {}) {
    return {
        id: id(),
        userId: u ? u.id : null,
        email: u ? u.email : overrides.email,
        eventId: evt.id,
        roles: [],
        teamId: null,
        isTeamAdmin: false,
        hotelNights: {},
        profileVerification: true,
        createdAt: new Date().toISOString(),
        ...overrides
    };
}

function badge(overrides = {}) {
    const n = next();
    return {
        id: `badge-${n}-${crypto.randomBytes(2).toString('hex')}`,
        name: `Badge ${n}`,
        description: `Badge ${n} description`,
        category: 'soft',
        claimType: 'common',
        points: 10,
        createdAt: new Date().toISOString(),
        ...overrides
    };
}

function eventBadge(evt, b, overrides = {}) {
    return { id: id(), eventId: evt.id, badgeId: b.id, judgeUserId: null, isActive: true, createdAt: new Date().toISOString(), ...overrides };
}

function invitation(evt, inviter, overrides = {}) {
    const expires = new Date(Date.now() + 7 * 24 * 3600e3).toISOString();
    return {
        id: id(),
        email: `invitee${next()}@e2e.test`,
        eventId: evt.id,
        role: 'participant',
        inviterId: inviter.id,
        inviterName: `${inviter.firstName} ${inviter.lastName}`,
        inviterEmail: inviter.email,
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: expires,
        ...overrides
    };
}

// The four system templates the API expects; the shape the admin templates page saves.
function systemEmailConfig() {
    const t = (name, subject, buttonUrlField, buttonText) => ({
        name,
        subject,
        mergeFields: ['firstName', 'eventName', 'teamName', 'portalUrl', 'inviterName'],
        editableSections: { body: `<p>Hi {{firstName}}, ${name} for {{eventName}}.</p>`, closing: '<p>See you there!</p>' },
        eventThemes: {},
        headerTitle: name,
        buttonText,
        buttonUrlField,
        features: []
    });
    return {
        templates: {
            welcome: t('Team Welcome', 'Welcome to {{eventName}}', 'portalUrl', 'Open the portal'),
            'interest-acknowledgment': t('Interest Acknowledgment', 'Thanks for your interest in {{eventName}}', 'portalUrl', 'View event'),
            'invitation-judge': t('Judge Invitation', 'You are invited to judge {{eventName}}', 'acceptUrl', 'Accept invitation'),
            'invitation-committee': t('Committee Invitation', 'Join the {{eventName}} committee', 'acceptUrl', 'Accept invitation')
        }
    };
}

module.exports = { id, isoDate, event, user, admin, team, participation, badge, eventBadge, invitation, systemEmailConfig };
