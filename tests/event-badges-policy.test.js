const assert = require('node:assert/strict');

function participantBadgeView(assignments) {
    return assignments
        .filter(assignment => assignment.isActive)
        .map(({ id, eventId, badgeId, isActive, badge }) => ({
            id,
            eventId,
            badgeId,
            isActive,
            badge
        }));
}

const assignments = [
    {
        id: 'active-badge',
        eventId: 'event-1',
        badgeId: 'badge-1',
        isActive: true,
        judgeUserId: 'staff-user',
        badge: { id: 'badge-1', name: 'Collaboration' }
    },
    {
        id: 'inactive-badge',
        eventId: 'event-1',
        badgeId: 'badge-2',
        isActive: false,
        judgeUserId: 'staff-user',
        badge: { id: 'badge-2', name: 'Hidden Badge' }
    }
];

assert.deepEqual(participantBadgeView(assignments), [{
    id: 'active-badge',
    eventId: 'event-1',
    badgeId: 'badge-1',
    isActive: true,
    badge: { id: 'badge-1', name: 'Collaboration' }
}]);

console.log('PASS: Participant badge view includes active visuals only and hides staff assignment data');