const jwt = require('jsonwebtoken');

// IMPORTANT: do NOT cache this in a module-level constant. Key Vault secrets are
// loaded asynchronously via a preInvocation hook (see functions/startup.js), which
// runs AFTER all function files are `require`'d at cold start. A top-level
// `const JWT_SECRET = process.env.JWT_SECRET || fallback` would freeze at the
// insecure per-instance hostname fallback for that worker's entire lifetime, even
// though the real secret gets loaded moments later — causing tokens signed/verified
// on different scaled-out instances to silently use different secrets (intermittent
// 401s). Always read it lazily, at call time, after the hook has populated it.
function getJwtSecret() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

    // If Key Vault is configured but the secret isn't loaded yet, fail closed.
    // Returning a per-instance fallback here causes cross-instance signature
    // mismatches (one instance signs, another verifies) and intermittent 401s.
    if (process.env.KEY_VAULT_URL) {
        throw new Error('ServerAuthConfigError: JWT secret unavailable');
    }

    // Local/dev fallback when Key Vault is not configured.
    return 'acdc-dev-secret-change-in-production-local-only';
}

function getTokenFromRequest(request) {
    const headers = request?.headers;
    if (!headers) return null;

    // Authorization is the canonical bearer header. Some Azure Static Web Apps /
    // Function proxy setups can forward the app token via x-acdc-token instead,
    // so we accept that only as a compatibility path when it is present. The
    // browser still sends exactly one token in the standard Authorization header,
    // which avoids duplicate token leakage in devtools.
    const authorization = typeof headers.get === 'function' ? headers.get('authorization') : headers.authorization;
    if (authorization) {
        const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
        if (match) return match[1];
    }

    const legacyToken = typeof headers.get === 'function' ? headers.get('x-acdc-token') : headers['x-acdc-token'];
    if (legacyToken && legacyToken.trim()) return legacyToken.trim();

    return null;
}

function verifyToken(token) {
    if (!token) return { valid: false, reason: 'no-token' };

    try {
        const payload = jwt.verify(token, getJwtSecret(), { issuer: 'acdc-portal' });
        return { valid: true, payload };
    } catch (error) {
        // error.name is one of: TokenExpiredError, JsonWebTokenError (bad
        // signature / malformed / wrong issuer), NotBeforeError.
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

// Resolve the set of teamIds a participation row grants (accounting for the legacy
// single-team fields vs. the newer teamMemberships[] array). Membership items use
// the `isAdmin` field name (not `isTeamAdmin` — that's only the legacy row-level field).
function membershipsFor(participation) {
    if (participation.teamMemberships && participation.teamMemberships.length > 0) {
        return participation.teamMemberships;
    }
    if (participation.teamId) {
        return [{ teamId: participation.teamId, isAdmin: participation.isTeamAdmin || false }];
    }
    return [];
}

// Object-level authorization check: is this caller allowed to manage a given team?
// True if they are a portal admin, the team's recorded adminUserId, or hold an
// isAdmin membership for this team in the participations dataset.
function isTeamAuthorized(user, team, participations = []) {
    if (!user || !team) return false;
    if (user.isPortalAdmin) return true;
    if (team.adminUserId && user.userId && team.adminUserId === user.userId) return true;

    return participations.some(p => {
        if (p.userId !== user.userId) return false;
        return membershipsFor(p).some(m => m.teamId === team.id && m.isAdmin);
    });
}

// Object-level authorization check: is this caller allowed to view/manage another
// user's profile? True for the user themselves, portal admins, or a team admin who
// shares a team with the target user.
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

// True if the caller is a member (any role) of the given team, a portal admin, or
// that team's admin. Used for actions any team member may perform (e.g. claiming a
// badge for their own team), as opposed to isTeamAuthorized which is admin-only.
function isTeamMember(user, teamId, participations = []) {
    if (!user) return false;
    if (user.isPortalAdmin) return true;
    return participations.some(p => {
        if (p.userId !== user.userId) return false;
        return membershipsFor(p).some(m => m.teamId === teamId);
    });
}

// True if the caller is a portal admin or holds the given role (e.g. 'judge',
// 'committee') on their participation record for the given event.
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
