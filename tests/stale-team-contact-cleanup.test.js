const assert = require('node:assert/strict');

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

console.log('PASS: Stale target-team contacts can be cleaned while other-team memberships remain blocked');