const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, isTeamAuthorized } = require('../shared/auth');
const { isGuid, sameId } = require('../shared/id');
const Storage = require('../shared/storage');
const { Storage: GenericStorage, withTransaction } = require('../shared/storage');
const { readJson } = require('../shared/validate');

const participationsStorage = new GenericStorage('participations');
const invitationsStorage = new GenericStorage('invitations');
const deliveriesStorage = new GenericStorage('email-deliveries');
const interestLeadsStorage = new GenericStorage('interest-leads');
const soloQueueStorage = new GenericStorage('solo-queue');
const teamsStorage = new GenericStorage('teams');

// A person's participations: rows linked by user id plus legacy rows linked by email only.
async function participationsOf(user) {
    const byUser = await participationsStorage.findBy({ userId: user.id });
    const byEmail = user.email ? await participationsStorage.findBy({ email: user.email }) : [];
    const seen = new Set(byUser.map(p => String(p.id).toLowerCase()));
    return [...byUser, ...byEmail.filter(p => !seen.has(String(p.id).toLowerCase()))];
}

function teamIdsOf(participations) {
    const ids = new Set();
    for (const p of participations) {
        if (p.teamId) ids.add(String(p.teamId).toLowerCase());
        for (const m of p.teamMemberships || []) if (m.teamId) ids.add(String(m.teamId).toLowerCase());
    }
    return ids;
}

function isProvisional(user) {
    return !!user.invitationPending && !user.profileComplete;
}

// Self or an admin: the whole account goes, child rows first so no FK can block it.
async function removeAccount(user, participations) {
    const cleaned = { participations: 0, invitations: 0, deliveries: 0, interestLeads: 0, soloQueue: 0, teamsReleased: 0 };

    for (const p of participations) {
        if (await participationsStorage.delete(p.id)) cleaned.participations++;
    }
    for (const inv of await invitationsStorage.findBy({ email: user.email })) {
        if (await invitationsStorage.delete(inv.id)) cleaned.invitations++;
    }
    const deliveries = [
        ...await deliveriesStorage.findBy({ userId: user.id }),
        ...await deliveriesStorage.findBy({ email: user.email })
    ];
    const seenDeliveries = new Set();
    for (const d of deliveries) {
        const key = String(d.id).toLowerCase();
        if (seenDeliveries.has(key)) continue;
        seenDeliveries.add(key);
        if (await deliveriesStorage.delete(d.id)) cleaned.deliveries++;
    }
    for (const lead of await interestLeadsStorage.findBy({ email: user.email })) {
        if (await interestLeadsStorage.delete(lead.id)) cleaned.interestLeads++;
    }
    for (const entry of await soloQueueStorage.findBy({ userId: user.id })) {
        if (await soloQueueStorage.delete(entry.id)) cleaned.soloQueue++;
    }
    for (const team of await teamsStorage.findBy({ adminUserId: user.id })) {
        await Storage.teams.update(team.id, { adminUserId: null, updatedAt: new Date().toISOString() });
        cleaned.teamsReleased++;
    }
    await Storage.allowedEmails.remove(user.email);
    await Storage.users.delete(user.id);

    return { message: 'Member removed successfully', cleaned };
}

// Team administrator: the person leaves the team(s) the caller administers. Their account
// survives unless it is a provisional stub created by the invitation, with nothing else.
async function detachFromTeams(user, participations, teamIds) {
    const cleaned = { participations: 0, invitations: 0, accountRemoved: false };
    const inScope = participations.filter(p => teamIds.some(t => sameId(p.teamId, t)));
    const outOfScope = participations.filter(p => !inScope.includes(p));
    const now = new Date().toISOString();

    const removeStub = isProvisional(user) && outOfScope.length === 0;

    for (const p of inScope) {
        if (removeStub) {
            await participationsStorage.delete(p.id);
        } else {
            await participationsStorage.update(p.id, { teamId: null, isTeamAdmin: false, updatedAt: now });
        }
        cleaned.participations++;
    }
    for (const teamId of teamIds) {
        for (const inv of await invitationsStorage.findBy({ email: user.email, teamId, status: 'pending' })) {
            if (await invitationsStorage.delete(inv.id)) cleaned.invitations++;
        }
    }

    if (removeStub) {
        await Storage.allowedEmails.remove(user.email);
        await Storage.users.delete(user.id);
        cleaned.accountRemoved = true;
    } else {
        const userUpdates = { updatedAt: now };
        if (user.teamId && teamIds.some(t => sameId(user.teamId, t))) userUpdates.teamId = null;
        if (user.invitationPending) userUpdates.invitationPending = false;
        await Storage.users.update(user.id, userUpdates);
    }

    return { message: 'Member removed from team', cleaned };
}

app.http('members-remove', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'members/{id}',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const memberId = request.params.id;
            if (!isGuid(memberId)) {
                return { status: 400, jsonBody: { message: 'Invalid member ID' } };
            }

            const body = (await readJson(request)) || {};
            const teamId = body.teamId ?? null;
            if (teamId !== null && !isGuid(teamId)) {
                return { status: 400, jsonBody: { message: 'Invalid team ID' } };
            }

            const user = await Storage.users.getById(memberId);
            if (!user) {
                return { status: 404, jsonBody: { message: 'Member not found' } };
            }

            const targetParticipations = await participationsOf(user);
            const targetTeamIds = teamIdsOf(targetParticipations);

            if (teamId && !targetTeamIds.has(teamId.toLowerCase())) {
                return { status: 400, jsonBody: { message: 'This user is not a member of that team' } };
            }

            const isSelf = sameId(auth.user.userId, memberId);
            const isAdmin = !!auth.user.isAdmin;
            let scopeTeamIds = teamId ? [teamId] : [...targetTeamIds];

            if (!isSelf && !isAdmin) {
                // Only an administrator of a team the target actually belongs to may act.
                const forbidden = { status: 403, jsonBody: { message: 'You do not have permission to remove this member' } };
                if (scopeTeamIds.length === 0) return forbidden;
                const callerParticipations = await participationsStorage.findBy({ userId: auth.user.userId });
                const teams = await teamsStorage.findBy({ id: scopeTeamIds });
                const authorizedTeams = teams.filter(team => isTeamAuthorized(auth.user, team, callerParticipations));
                if (authorizedTeams.length === 0) return forbidden;
                scopeTeamIds = authorizedTeams.map(team => team.id);
            }

            const result = await withTransaction(async () => {
                if (isSelf || isAdmin) return removeAccount(user, targetParticipations);
                return detachFromTeams(user, targetParticipations, scopeTeamIds);
            });

            context.log(`Member ${memberId} removed by ${auth.user.userId || 'unknown'}: ${JSON.stringify(result.cleaned)}`);
            return { status: 200, jsonBody: result };

        } catch (error) {
            await logError(context, error);
            context.error('Members DELETE error:', error);
            return {
                status: 500,
                jsonBody: { message: 'Internal server error' }
            };
        }
    }
});
