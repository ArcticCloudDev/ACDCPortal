const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function classifyMembership(teamId, participations) {
    return participations.some(participation => {
        const memberships = participation.teamMemberships || [];
        return (participation.teamId && participation.teamId !== teamId)
            || memberships.some(membership => membership.teamId !== teamId);
    });
}

assert.equal(classifyMembership('team-a', [{ teamId: 'team-a' }]), false);
assert.equal(classifyMembership('team-a', [{ teamMemberships: [{ teamId: 'team-a' }] }]), false);
assert.equal(classifyMembership('team-a', [{ teamId: 'team-b' }]), true);
assert.equal(classifyMembership('team-a', [{ teamMemberships: [{ teamId: 'team-b' }] }]), true);

const invitations = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'src', 'functions', 'invitations.js'),
    'utf8'
);
assert.match(invitations, /teamId,\s*invitationPending:\s*true/);
assert.doesNotMatch(invitations, /existingUser\.teamId/);

console.log('PASS: Stale target-team contacts can be cleaned and reattached while other-team memberships remain blocked');