const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'acdc-dev-secret-change-in-production-' + require('os').hostname();

function requireToken(request) {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : null;

    if (!token) {
        console.error('No token provided in Authorization header');
        return unauthorized();
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET, {
            algorithms: ['HS256'],
            issuer: 'acdc-portal',
            //audience: 'acdc-portal-api'
        });

        return { ok: true, user: payload };
    } catch (error) {
        console.error('JWT verification failed:', {
            name: error.name,
            message: error.message
        });
        return unauthorized();
    }
}

function requireSelfOrAdmin(user, userId) {
    const isSelf =
        user.userId?.toLowerCase() === userId?.toLowerCase();

    if (!isSelf && user.isPortalAdmin !== true) {
        return {
            ok: false,
            response: {
                status: 403,
                jsonBody: { message: 'Forbidden' }
            }
        };
    }

    return { ok: true };
}

function unauthorized() {
    return {
        ok: false,
        response: {
            status: 401,
            jsonBody: { message: 'Unauthorized' }
        }
    };
}

module.exports = {
    requireToken,
    requireSelfOrAdmin
};