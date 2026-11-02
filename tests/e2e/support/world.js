// A small, coherent data set most specs start from.
const f = require('./factories');

function buildWorld(overrides = {}) {
    const admin = f.admin({ email: 'ada.admin@e2e.test' });
    const event = f.event({ name: 'ACDC 2027', status: 'registration', ...overrides.event });
    const leader = f.user({ firstName: 'Lena', lastName: 'Leader', email: 'lena.leader@e2e.test' });
    const member = f.user({ firstName: 'Mats', lastName: 'Member', email: 'mats.member@e2e.test' });
    const loner = f.user({ firstName: 'Solo', lastName: 'Sverre', email: 'solo.sverre@e2e.test' });
    const team = f.team(event, leader, { teamName: 'Power Rangers', numberOfParticipants: 4 });
    const participations = {
        leader: f.participation(leader, event, { teamId: team.id, isTeamAdmin: true, roles: ['participant'] }),
        member: f.participation(member, event, { teamId: team.id, roles: ['participant'] }),
        loner: f.participation(loner, event, {})
    };
    return {
        admin, event, leader, member, loner, team, participations,
        seed: () => ({
            events: [event],
            users: [admin, leader, member, loner],
            teams: [team],
            participations: Object.values(participations),
            'system-email-config': [f.systemEmailConfig()]
        })
    };
}

// Concatenates seed collections instead of replacing them.
function mergeSeeds(...seeds) {
    const out = {};
    for (const seed of seeds) {
        for (const [key, items] of Object.entries(seed || {})) out[key] = [...(out[key] || []), ...items];
    }
    return out;
}

module.exports = { buildWorld, mergeSeeds };
