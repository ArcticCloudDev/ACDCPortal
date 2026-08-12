const jwt = require('jsonwebtoken');
const os = require('os');

const JWT_SECRET = process.env.JWT_SECRET || 'acdc-dev-secret-change-in-production-' + os.hostname();

function getTokenFromRequest(request) {
    const headers = request?.headers;
    if (!headers) return null;

    const authorization = typeof headers.get === 'function' ? headers.get('authorization') : headers.authorization;
    if (authorization) {
        const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
        if (match) return match[1];
    }

    return typeof headers.get === 'function' ? headers.get('x-acdc-token') : headers['x-acdc-token'] || null;
}

function verifyToken(token) {
    if (!token) return null;

    try {
        return jwt.verify(token, JWT_SECRET, { issuer: 'acdc-portal' });
    } catch (error) {
        return null;
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

    const payload = verifyToken(token);
    if (!payload) {
        context?.warn?.('Auth required but token verification failed');
        return {
            authorized: false,
            status: 401,
            jsonBody: { message: 'Invalid or expired session' }
        };
    }

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

module.exports = {
    JWT_SECRET,
    getTokenFromRequest,
    verifyToken,
    requireAuth
};
