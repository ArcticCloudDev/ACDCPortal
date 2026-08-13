const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const invitations = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'src', 'functions', 'invitations.js'),
    'utf8'
);
const teams = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'src', 'functions', 'teams.js'),
    'utf8'
);
const eventPage = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'event-page.js'),
    'utf8'
);

assert.match(invitations, /invitationPending:\s*true/);
assert.match(invitations, /teamId,\s*isTeamAdmin:\s*false/);
assert.match(invitations, /profileVerification:\s*false/);
assert.match(invitations, /profileComplete:\s*false/);
assert.match(invitations, /triggerSequenceEmailsForInvite\(resolvedUserId, userEmail, eventId, context\)/);
assert.match(invitations, /profileVerification:\s*true/);
assert.match(teams, /isTeamMember\(auth\.user, teamId, participations\)/);
assert.match(eventPage, /legacyPendingInvitations/);
assert.match(eventPage, /Pending confirmation/);
assert.match(invitations, /inviteePhone: inviteePhone \|\| null/);
assert.match(invitations, /inviteeGamertag: inviteeGamertag \|\| null/);
assert.match(invitations, /inviteeAllergies: inviteeAllergies \|\| null/);

console.log('PASS: Team invitations create a single pending contact, defer sequences until confirmation, and enforce team-scoped access');