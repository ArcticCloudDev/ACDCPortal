// In-memory sample data for the local mock API.
// Shapes mirror what api/src/shared/storage-sql.js returns (camelCase, ISO dates).
// Edit freely: this file never reaches Azure.

const now = new Date();
const iso = (d) => new Date(d).toISOString();
const dateOnly = (d) => new Date(d).toISOString().split('T')[0];
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// ---------- IDs (stable so bookmarks and dev-login keep working) ----------
const ID = {
    adminUser: '11111111-1111-4111-8111-111111111111',
    participantUser: '22222222-2222-4222-8222-222222222222',
    teamAdminUser: '33333333-3333-4333-8333-333333333333',
    judgeUser: '44444444-4444-4444-8444-444444444444',
    memberUser: '55555555-5555-4555-8555-555555555555',

    eventLive: 'aaaaaaaa-0001-4000-8000-000000000001',
    eventPre: 'aaaaaaaa-0002-4000-8000-000000000002',
    eventDone: 'aaaaaaaa-0003-4000-8000-000000000003',

    teamNorthern: 'bbbbbbbb-0001-4000-8000-000000000001',
    teamFjord: 'bbbbbbbb-0002-4000-8000-000000000002',
    teamCommittee: 'bbbbbbbb-0003-4000-8000-000000000003',
    teamJudges: 'bbbbbbbb-0004-4000-8000-000000000004',
};

// ---------- Users ----------
const users = [
    {
        id: ID.adminUser, email: 'admin@acdc.local', firstName: 'Ada', lastName: 'Admin',
        phone: '+47 900 00 001', gamertag: 'ada', allergies: null,
        isPortalAdmin: true, profileComplete: true, teamId: null,
        createdAt: iso(addDays(now, -200)), updatedAt: null
    },
    {
        id: ID.teamAdminUser, email: 'tor@acdc.local', firstName: 'Tor', lastName: 'Teamleder',
        phone: '+47 900 00 002', gamertag: 'torpedo', allergies: 'Nuts',
        isPortalAdmin: false, profileComplete: true, teamId: ID.teamNorthern,
        createdAt: iso(addDays(now, -90)), updatedAt: null
    },
    {
        id: ID.participantUser, email: 'pia@acdc.local', firstName: 'Pia', lastName: 'Participant',
        phone: '+47 900 00 003', gamertag: 'pixelpia', allergies: null,
        isPortalAdmin: false, profileComplete: true, teamId: ID.teamNorthern,
        createdAt: iso(addDays(now, -80)), updatedAt: null
    },
    {
        id: ID.memberUser, email: 'mats@acdc.local', firstName: 'Mats', lastName: 'Medlem',
        phone: null, gamertag: null, allergies: 'Gluten',
        isPortalAdmin: false, profileComplete: false, teamId: ID.teamFjord,
        createdAt: iso(addDays(now, -30)), updatedAt: null
    },
    {
        id: ID.judgeUser, email: 'jon@acdc.local', firstName: 'Jon', lastName: 'Judge',
        phone: '+47 900 00 005', gamertag: 'thegavel', allergies: null,
        isPortalAdmin: false, profileComplete: true, teamId: ID.teamJudges,
        createdAt: iso(addDays(now, -150)), updatedAt: null
    },
];

// ---------- Events ----------
function hotelDates(start, nights) {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const out = [];
    for (let i = 0; i < nights; i++) {
        const d = addDays(start, i);
        out.push({ date: dateOnly(d), dayLabel: labels[d.getDay()], dayLabelFull: full[d.getDay()] });
    }
    return out;
}
function defaultNights(start, nights) {
    const labels = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const out = [];
    for (let i = 0; i < nights; i++) {
        const d = addDays(start, i);
        out.push(`${labels[d.getDay()]}-${labels[addDays(d, 1).getDay()]}`);
    }
    return out;
}

const liveStart = addDays(now, 20);
const preStart = addDays(now, 300);
const doneStart = addDays(now, -340);

const baseEvent = {
    description: null, minTeamSize: 3, maxTeamSize: 5, sequenceId: null, sequenceEnabled: false,
    fileCategories: ['Pitch deck', 'Source code', 'Demo video'],
    sendWelcomeEmail: true, sendInterestAcknowledgment: true, sendJudgeInvitationEmail: true,
    sendCommitteeInvitationEmail: true, sendTeamRegistrationEmail: true, teamWelcomeEmailId: null,
    sharepointUrl: null, currency: 'NOK', costPerParticipant: 4500, hotelRatePerNight: 1450,
    foodRatePerDay: 650, foodDays: 3, teamRegistrationTerms: 'By registering a team you commit to paying for the number of participants you enter.',
    soloQueueTerms: 'Solo participants are matched into teams by the committee.', singleRegistrationTerms: null,
    updatedAt: null
};

const events = [
    {
        ...baseEvent,
        id: ID.eventLive, name: 'ACDC 2027', status: 'registration', registrationType: 'team',
        registrationOpen: true, isActive: true,
        description: 'Arctic Cloud Developer Challenge. Three days of building, badges and bad puns.',
        startDate: dateOnly(liveStart), endDate: dateOnly(addDays(liveStart, 3)), location: 'Quality Hotel Olavsgaard, Skjetten',
        committeeTeamId: ID.teamCommittee, judgesTeamId: ID.teamJudges,
        hotelDates: hotelDates(addDays(liveStart, -1), 4), hotelDefaultNights: defaultNights(liveStart, 3),
        createdAt: iso(addDays(now, -120)),
    },
    {
        ...baseEvent,
        id: ID.eventPre, name: 'ACDC 2028', status: 'pre-registration', registrationType: 'team',
        registrationOpen: false, isActive: false,
        description: 'Register your interest and we will let you know when registration opens.',
        startDate: dateOnly(preStart), endDate: dateOnly(addDays(preStart, 3)), location: 'TBA',
        committeeTeamId: null, judgesTeamId: null,
        hotelDates: [], hotelDefaultNights: [],
        createdAt: iso(addDays(now, -10)),
    },
    {
        ...baseEvent,
        id: ID.eventDone, name: 'ACDC 2026', status: 'completed', registrationType: 'team',
        registrationOpen: false, isActive: false,
        description: 'Last year. Great memories, questionable code.',
        startDate: dateOnly(doneStart), endDate: dateOnly(addDays(doneStart, 3)), location: 'Quality Hotel Olavsgaard, Skjetten',
        committeeTeamId: null, judgesTeamId: null,
        hotelDates: [], hotelDefaultNights: [],
        createdAt: iso(addDays(now, -500)),
    },
];

// ---------- Teams ----------
const teams = [
    { id: ID.teamNorthern, teamName: 'Northern Lights', eventId: ID.eventLive, numberOfParticipants: 4, adminUserId: ID.teamAdminUser, isSpecialTeam: false, specialTeamType: null, createdAt: iso(addDays(now, -60)), updatedAt: null },
    { id: ID.teamFjord, teamName: 'Fjord Fusion', eventId: ID.eventLive, numberOfParticipants: 3, adminUserId: ID.memberUser, isSpecialTeam: false, specialTeamType: null, createdAt: iso(addDays(now, -25)), updatedAt: null },
    { id: ID.teamCommittee, teamName: 'Committee', eventId: ID.eventLive, numberOfParticipants: null, adminUserId: ID.adminUser, isSpecialTeam: true, specialTeamType: 'committee', createdAt: iso(addDays(now, -120)), updatedAt: null },
    { id: ID.teamJudges, teamName: 'Judges', eventId: ID.eventLive, numberOfParticipants: null, adminUserId: ID.adminUser, isSpecialTeam: true, specialTeamType: 'judges', createdAt: iso(addDays(now, -120)), updatedAt: null },
];

// ---------- Participations ----------
const noNights = { 'mon-tue': false, 'tue-wed': false, 'wed-thu': false, 'thu-fri': false, 'fri-sat': false, 'sat-sun': false, 'sun-mon': false };
function participation(p) {
    const roles = p.roles || [];
    return {
        userId: null, email: null, teamId: null, isTeamAdmin: false, hotelPaidBy: null,
        convertedFrom: null, convertedAt: null, convertedVia: null, invitationId: null,
        hotelNights: { ...noNights }, profileVerification: false,
        createdAt: iso(addDays(now, -40)), updatedAt: null,
        ...p,
        roles,
        teamMemberships: p.teamMemberships || (p.teamId ? [{ teamId: p.teamId, isAdmin: !!p.isTeamAdmin, isParticipant: roles.includes('participant') }] : []),
    };
}

const participations = [
    participation({ id: 'cccccccc-0001-4000-8000-000000000001', userId: ID.adminUser, email: 'admin@acdc.local', eventId: ID.eventLive, roles: ['committee'], teamId: ID.teamCommittee, isTeamAdmin: true, profileVerification: true }),
    participation({ id: 'cccccccc-0002-4000-8000-000000000002', userId: ID.teamAdminUser, email: 'tor@acdc.local', eventId: ID.eventLive, roles: ['participant'], teamId: ID.teamNorthern, isTeamAdmin: true, profileVerification: true, hotelNights: { ...noNights, 'mon-tue': true, 'tue-wed': true, 'wed-thu': true } }),
    participation({ id: 'cccccccc-0003-4000-8000-000000000003', userId: ID.participantUser, email: 'pia@acdc.local', eventId: ID.eventLive, roles: ['participant'], teamId: ID.teamNorthern, isTeamAdmin: false, profileVerification: true, hotelNights: { ...noNights, 'tue-wed': true, 'wed-thu': true } }),
    participation({ id: 'cccccccc-0004-4000-8000-000000000004', userId: ID.memberUser, email: 'mats@acdc.local', eventId: ID.eventLive, roles: ['participant'], teamId: ID.teamFjord, isTeamAdmin: true, profileVerification: false }),
    participation({ id: 'cccccccc-0005-4000-8000-000000000005', userId: ID.judgeUser, email: 'jon@acdc.local', eventId: ID.eventLive, roles: ['judge'], teamId: ID.teamJudges, isTeamAdmin: false, profileVerification: true }),
    participation({ id: 'cccccccc-0006-4000-8000-000000000006', userId: ID.participantUser, email: 'pia@acdc.local', eventId: ID.eventDone, roles: ['participant'], teamId: null }),
    participation({ id: 'cccccccc-0007-4000-8000-000000000007', userId: ID.participantUser, email: 'pia@acdc.local', eventId: ID.eventPre, roles: ['interest'], teamId: null }),
];

// ---------- Badges ----------
const badges = [
    { id: 'community-champion', name: 'Community Champion', description: 'Helped another team solve a blocker.', category: 'soft', claimType: 'blog', imageUrl: null, points: 10, createdAt: iso(addDays(now, -300)), updatedAt: null },
    { id: 'blogger', name: 'Blogger', description: 'Published a blog post during the event.', category: 'soft', claimType: 'blog', imageUrl: null, points: 15, createdAt: iso(addDays(now, -300)), updatedAt: null },
    { id: 'power-fx-wizard', name: 'Power Fx Wizard', description: 'Used a non-trivial Power Fx formula.', category: 'low-code', claimType: 'evidence', imageUrl: null, points: 20, createdAt: iso(addDays(now, -300)), updatedAt: null },
    { id: 'dataverse-diver', name: 'Dataverse Diver', description: 'Custom tables with relationships and business rules.', category: 'low-code', claimType: 'evidence', imageUrl: null, points: 25, createdAt: iso(addDays(now, -300)), updatedAt: null },
    { id: 'pcf-pioneer', name: 'PCF Pioneer', description: 'Shipped a custom PCF control.', category: 'pro-code', claimType: 'evidence', imageUrl: null, points: 30, createdAt: iso(addDays(now, -300)), updatedAt: null },
    { id: 'plugin-pro', name: 'Plugin Pro', description: 'Wrote and registered a Dataverse plugin.', category: 'pro-code', claimType: 'evidence', imageUrl: null, points: 30, createdAt: iso(addDays(now, -300)), updatedAt: null },
    { id: 'sponsor-spotlight', name: 'Sponsor Spotlight', description: 'Used the sponsor product in a meaningful way.', category: 'sponsor', claimType: 'evidence', imageUrl: null, points: 40, createdAt: iso(addDays(now, -300)), updatedAt: null },
];

const eventBadges = badges.map((b, i) => ({
    id: `dddddddd-000${i + 1}-4000-8000-00000000000${i + 1}`,
    eventId: ID.eventLive, badgeId: b.id, judgeUserId: ID.judgeUser,
    isActive: i !== 6, // sponsor badge inactive so the "hidden" state shows up
    createdAt: iso(addDays(now, -100)), updatedAt: null,
}));

const badgeClaims = [
    { id: 'eeeeeeee-0001-4000-8000-000000000001', eventBadgeId: eventBadges[1].id, eventId: ID.eventLive, badgeId: 'blogger', teamId: ID.teamNorthern, status: 'approved', blogUrl: 'https://example.com/blog/day-1', evidence: null, assignedToUserId: ID.judgeUser, claimedBy: ID.teamAdminUser, claimedAt: iso(addDays(now, -3)), declineReason: null, reviewedBy: ID.judgeUser, reviewedAt: iso(addDays(now, -2)) },
    { id: 'eeeeeeee-0002-4000-8000-000000000002', eventBadgeId: eventBadges[2].id, eventId: ID.eventLive, badgeId: 'power-fx-wizard', teamId: ID.teamNorthern, status: 'pending', blogUrl: null, evidence: 'See the Formulas screen in our canvas app.', assignedToUserId: ID.judgeUser, claimedBy: ID.participantUser, claimedAt: iso(addDays(now, -1)), declineReason: null, reviewedBy: null, reviewedAt: null },
    { id: 'eeeeeeee-0003-4000-8000-000000000003', eventBadgeId: eventBadges[4].id, eventId: ID.eventLive, badgeId: 'pcf-pioneer', teamId: ID.teamFjord, status: 'declined', blogUrl: null, evidence: 'Repo link', assignedToUserId: ID.judgeUser, claimedBy: ID.memberUser, claimedAt: iso(addDays(now, -2)), declineReason: 'Control was not deployed to an environment.', reviewedBy: ID.judgeUser, reviewedAt: iso(addDays(now, -1)) },
    { id: 'eeeeeeee-0004-4000-8000-000000000004', eventBadgeId: eventBadges[0].id, eventId: ID.eventLive, badgeId: 'community-champion', teamId: ID.teamFjord, status: 'draft', blogUrl: null, evidence: null, assignedToUserId: null, claimedBy: ID.memberUser, claimedAt: iso(now), declineReason: null, reviewedBy: null, reviewedAt: null },
];

// ---------- Invitations ----------
const invitations = [
    { id: 'ffffffff-0001-4000-8000-000000000001', email: 'kari@example.com', inviteeFirstName: 'Kari', inviteeLastName: 'Nordmann', teamId: ID.teamNorthern, teamName: 'Northern Lights', eventId: ID.eventLive, role: 'participant', inviterId: ID.teamAdminUser, inviterName: 'Tor Teamleder', inviterEmail: 'tor@acdc.local', message: 'Join us!', status: 'pending', createdAt: iso(addDays(now, -5)), expiresAt: iso(addDays(now, 9)), acceptedAt: null, acceptedBy: null, cancelledAt: null },
    { id: 'ffffffff-0002-4000-8000-000000000002', email: 'pia@acdc.local', inviteeFirstName: 'Pia', inviteeLastName: 'Participant', teamId: ID.teamNorthern, teamName: 'Northern Lights', eventId: ID.eventLive, role: 'participant', inviterId: ID.teamAdminUser, inviterName: 'Tor Teamleder', inviterEmail: 'tor@acdc.local', message: null, status: 'accepted', createdAt: iso(addDays(now, -50)), expiresAt: iso(addDays(now, -36)), acceptedAt: iso(addDays(now, -49)), acceptedBy: ID.participantUser, cancelledAt: null },
    { id: 'ffffffff-0003-4000-8000-000000000003', email: 'ola@example.com', inviteeFirstName: 'Ola', inviteeLastName: null, teamId: ID.teamFjord, teamName: 'Fjord Fusion', eventId: ID.eventLive, role: 'participant', inviterId: ID.memberUser, inviterName: 'Mats Medlem', inviterEmail: 'mats@acdc.local', message: null, status: 'expired', createdAt: iso(addDays(now, -40)), expiresAt: iso(addDays(now, -26)), acceptedAt: null, acceptedBy: null, cancelledAt: null },
];

// ---------- Solo queue ----------
const soloQueue = [
    { id: '99999999-0001-4000-8000-000000000001', userId: ID.judgeUser, eventId: ID.eventPre, note: 'Happy to join any team, strong on Power Automate.', status: 'waiting', joinedAt: iso(addDays(now, -4)) },
];

module.exports = { ID, users, events, teams, participations, badges, eventBadges, badgeClaims, invitations, soloQueue };
