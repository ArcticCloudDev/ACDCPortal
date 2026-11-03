const jwt = require('jsonwebtoken');

// Read lazily at call time: Key Vault populates process.env after modules are require()'d.
function getJwtSecret() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

    throw new Error('ServerAuthConfigError: JWT secret unavailable');
}

const SESSION_EXPIRY = '8h';

// The one place session JWTs are minted: verify-otp, register/complete and
// invitations/accept all issue the same claims so a fresh token can replace a stale one.
function signSessionToken({ email, userId, isPortalAdmin }) {
    return jwt.sign(
        { email: String(email).toLowerCase(), userId: userId ?? null, isPortalAdmin: !!isPortalAdmin },
        getJwtSecret(),
        { expiresIn: SESSION_EXPIRY, issuer: 'acdc-portal' }
    );
}

// The user object the frontend stores next to the token (see verify-otp).
function sessionUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        profileComplete: !!user.profileComplete,
        isPortalAdmin: !!user.isPortalAdmin
    };
}

function issueSession(user) {
    return {
        token: signSessionToken({ email: user.email, userId: user.id, isPortalAdmin: user.isPortalAdmin }),
        user: sessionUser(user)
    };
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

// Portal admin (Users.IsPortalAdmin) is the bootstrap super admin. Committee members are full
// admins on every event and page; only the portal-admin flag itself stays out of their reach (no
// endpoint sets it). Looked up per request so a role change applies at once, not at next sign-in.
let participationsStore = null;
async function holdsCommitteeRole(userId) {
    if (!userId) return false;
    if (!participationsStore) {
        const { Storage } = require('./storage');
        participationsStore = new Storage('participations');
    }
    const rows = await participationsStore.findBy({ userId });
    return rows.some(p => (p.roles || []).includes('committee'));
}

// Resolves to { authorized, user } where user.isAdmin covers portal admins and committee members.
async function requireAuth(request, context, options = {}) {
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
    const user = { ...payload, isAdmin: !!payload.isPortalAdmin || await holdsCommitteeRole(payload.userId) };

    if (options.requireAdmin && !user.isAdmin) {
        context?.warn?.(`Admin access denied for ${payload.email || 'unknown user'}`);
        return {
            authorized: false,
            status: 403,
            jsonBody: { message: 'Admin access required' }
        };
    }

    return {
        authorized: true,
        user
    };
}

// Client address for rate limiting.
//
// In production the Functions app sits behind the Static Web Apps edge, a reverse proxy
// with Azure Front Door semantics: it appends the connecting socket's IP as the LAST
// (right-most) hop of X-Forwarded-For (creating the header if absent). Everything to the
// left of that hop is whatever the client chose to send, so it must never be used as a
// rate-limit key - the old code keyed on the raw header value, which a client could vary
// per request to get a fresh bucket every time. x-client-ip is likewise client-writable
// and is ignored. Requests with no X-Forwarded-For at all (no proxy in front, e.g. the
// local harness) share one 'direct' bucket rather than a client-chosen one.
function getClientIp(request) {
    const headers = request?.headers;
    const raw = headers ? (typeof headers.get === 'function' ? headers.get('x-forwarded-for') : headers['x-forwarded-for']) : null;
    if (!raw) return 'direct';
    const hops = String(raw).split(',').map(h => h.trim()).filter(Boolean);
    if (hops.length === 0) return 'direct';
    let ip = hops[hops.length - 1];
    // Strip a port suffix: "203.0.113.9:51234" or "[2001:db8::1]:51234".
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
    if (bracketed) ip = bracketed[1];
    else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
    return ip.toLowerCase().slice(0, 64);
}

function sameId(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return String(a).toLowerCase() === String(b).toLowerCase();
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

// SQL returns UNIQUEIDENTIFIERs upper-case while generated ids are lower-case, so every
// id comparison below is case-insensitive. The `participations` argument only needs to
// contain the rows of the users involved (caller and, where relevant, target).
function isTeamAuthorized(user, team, participations = []) {
    if (!user || !team) return false;
    if (user.isAdmin) return true;
    if (team.adminUserId && user.userId && sameId(team.adminUserId, user.userId)) return true;

    return participations.some(p => {
        if (!sameId(p.userId, user.userId)) return false;
        return membershipsFor(p).some(m => sameId(m.teamId, team.id) && m.isAdmin);
    });
}

function canManageUser(callerUser, targetUserId, participations = []) {
    if (!callerUser) return false;
    if (callerUser.userId && sameId(callerUser.userId, targetUserId)) return true;
    if (callerUser.isAdmin) return true;

    const adminTeamIds = new Set();
    const targetTeamIds = new Set();
    for (const p of participations) {
        const memberships = membershipsFor(p);
        if (sameId(p.userId, callerUser.userId)) {
            for (const m of memberships) if (m.isAdmin && m.teamId) adminTeamIds.add(String(m.teamId).toLowerCase());
        }
        if (sameId(p.userId, targetUserId)) {
            for (const m of memberships) if (m.teamId) targetTeamIds.add(String(m.teamId).toLowerCase());
        }
    }
    for (const teamId of adminTeamIds) {
        if (targetTeamIds.has(teamId)) return true;
    }
    return false;
}

function isTeamMember(user, teamId, participations = []) {
    if (!user) return false;
    if (user.isAdmin) return true;
    return participations.some(p => {
        if (!sameId(p.userId, user.userId)) return false;
        return membershipsFor(p).some(m => sameId(m.teamId, teamId));
    });
}

function hasEventRole(user, eventId, role, participations = []) {
    if (!user) return false;
    if (user.isAdmin) return true;
    return participations.some(p =>
        sameId(p.userId, user.userId) && sameId(p.eventId, eventId) && (p.roles || []).includes(role)
    );
}

module.exports = {
    getJwtSecret,
    signSessionToken,
    sessionUser,
    issueSession,
    getTokenFromRequest,
    getClientIp,
    verifyToken,
    requireAuth,
    isTeamAuthorized,
    canManageUser,
    isTeamMember,
    hasEventRole
};
