const jwt = require('jsonwebtoken');

// Read lazily at call time: Key Vault populates process.env after modules are require()'d.
function getJwtSecret() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

    throw new Error('ServerAuthConfigError: JWT secret unavailable');
}

function getTokenFromRequest(request) {
    const headers = request?.headers;
    if (!headers) return null;

    // Custom header on purpose: the SWA proxy rewrites Authorization in transit.
    const token = typeof headers.get === 'function' ? headers.get('x-acdc-token') : headers['x-acdc-token'];
    if (token && token.trim()) return token.trim();

    return null;
}

function verifyToken(token) {
    if (!token) return { valid: false, reason: 'no-token' };

    try {
        const payload = jwt.verify(token, getJwtSecret(), { issuer: 'acdc-portal' });
        return { valid: true, payload };
    } catch (error) {
        return { valid: false, reason: error.name + ': ' + error.message };
    }
}

function requireAuth(request, context, options = {}) {
    const token = getTokenFromRequest(request);
    if (!token) {
        context?.warn?.('Auth required but no bearer token provided');
        return {
            authorized: false,
            status: 401,
            jsonBody: { message: 'Authentication required' }
        };
    }

    const result = verifyToken(token);
    if (!result.valid && String(result.reason || '').includes('ServerAuthConfigError: JWT secret unavailable')) {
        context?.warn?.('Auth temporarily unavailable: JWT secret not loaded yet');
        return {
            authorized: false,
            status: 503,
            jsonBody: { message: 'Authentication temporarily unavailable. Please retry in a moment.' }
        };
    }
    if (!result.valid) {
        context?.warn?.(`Auth required but token verification failed: ${result.reason}`);
        return {
            authorized: false,
            status: 401,
            jsonBody: { message: 'Invalid or expired session' }
        };
    }
    const payload = result.payload;

    if (options.requireAdmin && !payload.isPortalAdmin) {
        context?.warn?.(`Admin access denied for ${payload.email || 'unknown user'}`);
        return {
            authorized: false,
            status: 403,
            jsonBody: { message: 'Admin access required' }
        };
    }

    return {
        authorized: true,
        user: payload
    };
}

function membershipsFor(participation) {
    if (participation.teamMemberships && participation.teamMemberships.length > 0) {
        return participation.teamMemberships;
    }
    if (participation.teamId) {
        return [{ teamId: participation.teamId, isAdmin: participation.isTeamAdmin || false }];
    }
    return [];
}

function isTeamAuthorized(user, team, participations = []) {
    if (!user || !team) return false;
    if (user.isPortalAdmin) return true;
    if (team.adminUserId && user.userId && team.adminUserId === user.userId) return true;

    return participations.some(p => {
        if (p.userId !== user.userId) return false;
        return membershipsFor(p).some(m => m.teamId === team.id && m.isAdmin);
    });
}

function canManageUser(callerUser, targetUserId, participations = []) {
    if (!callerUser) return false;
    if (callerUser.userId && callerUser.userId === targetUserId) return true;
    if (callerUser.isPortalAdmin) return true;

    const adminTeamIds = new Set();
    const targetTeamIds = new Set();
    for (const p of participations) {
        const memberships = membershipsFor(p);
        if (p.userId === callerUser.userId) {
            for (const m of memberships) if (m.isAdmin) adminTeamIds.add(m.teamId);
        }
        if (p.userId === targetUserId) {
            for (const m of memberships) targetTeamIds.add(m.teamId);
        }
    }
    for (const teamId of adminTeamIds) {
        if (targetTeamIds.has(teamId)) return true;
    }
    return false;
}

function isTeamMember(user, teamId, participations = []) {
    if (!user) return false;
    if (user.isPortalAdmin) return true;
    return participations.some(p => {
        if (p.userId !== user.userId) return false;
        return membershipsFor(p).some(m => m.teamId === teamId);
    });
}

function hasEventRole(user, eventId, role, participations = []) {
    if (!user) return false;
    if (user.isPortalAdmin) return true;
    return participations.some(p =>
        p.userId === user.userId && p.eventId === eventId && (p.roles || []).includes(role)
    );
}

module.exports = {
    getJwtSecret,
    getTokenFromRequest,
    verifyToken,
    requireAuth,
    isTeamAuthorized,
    canManageUser,
    isTeamMember,
    hasEventRole
};
