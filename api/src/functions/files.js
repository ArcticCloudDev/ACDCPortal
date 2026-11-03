const path = require('path');
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, isTeamMember } = require('../shared/auth');
const SharePointStorage = require('../shared/sharepoint');
const StorageModule = require('../shared/storage');
const { isGuid, sameId } = require('../shared/id');
const { upperId } = require('../shared/validate');
const { asActor, participationsForUser } = require('../shared/admin-queries');
const multipart = require('parse-multipart-data');

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
// Exactly Events/<eventId>/<teamId>/<fileName>: anchored, GUIDs only, single file segment.
const TEAM_FILE_PATH = new RegExp(`^Events/(${GUID})/(${GUID})/([^/\\\\]+)$`);

function parseTeamPathSegments(filePath) {
    if (typeof filePath !== 'string' || filePath.length > 1200) return null;
    const match = TEAM_FILE_PATH.exec(filePath);
    if (!match) return null;
    const fileName = match[3];
    if (fileName === '.' || fileName === '..' || /[\u0000-\u001f]/.test(fileName)) return null;
    return { eventId: match[1], teamId: match[2], fileName };
}

// Strips any directory part and control characters from an uploaded file name.
function safeFileName(name) {
    const base = path.posix.basename(String(name || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
    if (!base || base === '.' || base === '..') return null;
    return base.length > 200 ? base.slice(-200) : base;
}

// Caller must be on the team (or an admin) and the team must belong to the event.
async function authorizeTeamPath(user, eventId, teamId, action) {
    if (!isGuid(eventId) || !isGuid(teamId)) {
        return { status: 400, jsonBody: { error: 'eventId and teamId must be GUIDs' } };
    }
    const actor = asActor(user);
    const participations = await participationsForUser(actor.userId);
    if (!isTeamMember(actor, upperId(teamId), participations)) {
        return { status: 403, jsonBody: { error: `You do not have permission to ${action}` } };
    }
    const team = await StorageModule.teams.getById(teamId);
    if (!team) {
        return { status: 404, jsonBody: { error: 'Team not found' } };
    }
    if (!sameId(team.eventId, eventId)) {
        return { status: 400, jsonBody: { error: 'Team does not belong to this event' } };
    }
    return null;
}

function isNotFound(error) {
    return /\(404\)|404/.test(error?.message || '');
}

app.http('files-upload', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'files/upload',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            if (!SharePointStorage.isConfigured()) {
                return {
                    status: 503,
                    jsonBody: { error: 'File storage not configured' }
                };
            }

            const eventId = request.query.get('eventId');
            const teamId = request.query.get('teamId');
            const category = (request.query.get('category') || 'General').slice(0, 100);

            if (!eventId || !teamId) {
                return {
                    status: 400,
                    jsonBody: { error: 'eventId and teamId are required' }
                };
            }

            const denied = await authorizeTeamPath(auth.user, eventId, teamId, 'upload files for this team');
            if (denied) return denied;

            const contentType = request.headers.get('content-type') || '';
            if (!contentType.includes('multipart/form-data')) {
                return {
                    status: 400,
                    jsonBody: { error: 'Content-Type must be multipart/form-data' }
                };
            }

            const boundary = contentType.split('boundary=')[1];
            if (!boundary) {
                return {
                    status: 400,
                    jsonBody: { error: 'No boundary found in Content-Type' }
                };
            }

            const bodyBuffer = Buffer.from(await request.arrayBuffer());
            if (bodyBuffer.length > MAX_FILE_SIZE + 64 * 1024) {
                return { status: 400, jsonBody: { error: 'File too large. Maximum size is 10MB.' } };
            }
            const parts = multipart.parse(bodyBuffer, boundary.replace(/^"|"$/g, ''));

            const file = (parts || []).find(p => p.name === 'file' && p.filename) || null;
            if (!file) {
                return {
                    status: 400,
                    jsonBody: { error: 'No file found in request (expected a multipart part named "file")' }
                };
            }

            const fileName = safeFileName(file.filename);
            if (!fileName) {
                return { status: 400, jsonBody: { error: 'Invalid file name' } };
            }

            if (file.data.length > MAX_FILE_SIZE) {
                return {
                    status: 400,
                    jsonBody: { error: 'File too large. Maximum size is 10MB.' }
                };
            }

            const folderPath = `Events/${upperId(eventId)}/${upperId(teamId)}`;

            const result = await SharePointStorage.uploadFile(file.data, fileName, folderPath);

            try {
                await SharePointStorage.setFileMetadata(result.id, { FileCategory: category });
                result.category = category;
            } catch (metaErr) {
                context.warn('Could not set file metadata:', metaErr.message);
                result.category = category;
                result.metadataWarning = 'File uploaded but category could not be set';
            }

            context.log(`File uploaded: ${fileName} to ${folderPath} [${category}]`);

            return {
                status: 200,
                jsonBody: {
                    message: 'File uploaded successfully',
                    file: result
                }
            };

        } catch (error) {
            if (/too large/i.test(error.message || '')) {
                return { status: 400, jsonBody: { error: 'File too large. Maximum size is 10MB.' } };
            }
            await logError(context, error);
            context.error('File upload error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to upload file' }
            };
        }
    }
});

app.http('files-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'files/list',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            if (!SharePointStorage.isConfigured()) {
                return {
                    status: 503,
                    jsonBody: { error: 'File storage not configured' }
                };
            }

            const eventId = request.query.get('eventId');
            const teamId = request.query.get('teamId');

            if (!eventId || !teamId) {
                return {
                    status: 400,
                    jsonBody: { error: 'eventId and teamId are required' }
                };
            }

            const denied = await authorizeTeamPath(auth.user, eventId, teamId, 'view files for this team');
            if (denied) return denied;

            const folderPath = `Events/${upperId(eventId)}/${upperId(teamId)}`;

            let files;
            try {
                files = await SharePointStorage.listFiles(folderPath);
            } catch (error) {
                if (isNotFound(error)) return { status: 200, jsonBody: [] };
                throw error;
            }

            return { status: 200, jsonBody: files.filter(f => !f.isFolder) };

        } catch (error) {
            await logError(context, error);
            context.error('File list error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to list files' }
            };
        }
    }
});

app.http('files-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'files/delete',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            if (!SharePointStorage.isConfigured()) {
                return {
                    status: 503,
                    jsonBody: { error: 'File storage not configured' }
                };
            }

            const filePath = request.query.get('path');

            if (!filePath) {
                return {
                    status: 400,
                    jsonBody: { error: 'File path is required' }
                };
            }

            const segments = parseTeamPathSegments(filePath);
            if (!segments) {
                return { status: 400, jsonBody: { error: 'Invalid file path' } };
            }
            const denied = await authorizeTeamPath(auth.user, segments.eventId, segments.teamId, 'delete this file');
            if (denied) return denied;

            try {
                await SharePointStorage.deleteFile(filePath);
            } catch (error) {
                if (isNotFound(error)) return { status: 404, jsonBody: { error: 'File not found' } };
                throw error;
            }

            context.log(`File deleted: ${filePath}`);

            return {
                status: 200,
                jsonBody: { message: 'File deleted successfully' }
            };

        } catch (error) {
            await logError(context, error);
            context.error('File delete error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to delete file' }
            };
        }
    }
});

app.http('files-setup-columns', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'files/setup-columns',
    handler: async (request, context) => {
        try {
            const auth = await requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            if (!SharePointStorage.isConfigured()) {
                return {
                    status: 503,
                    jsonBody: { error: 'SharePoint not configured' }
                };
            }

            const body = await request.json();
            const categories = body?.categories;

            if (!Array.isArray(categories) || categories.length === 0 || !categories.every(c => typeof c === 'string' && c.trim() && c.length <= 100)) {
                return {
                    status: 400,
                    jsonBody: { error: 'categories array is required' }
                };
            }

            const column = await SharePointStorage.ensureChoiceColumn('FileCategory', categories);
            context.log(`FileCategory column ensured with choices: ${categories.join(', ')}`);

            return {
                status: 200,
                jsonBody: {
                    message: 'FileCategory column ready',
                    column: column?.displayName || 'FileCategory'
                }
            };

        } catch (error) {
            await logError(context, error);
            context.error('Setup columns error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to set up columns' }
            };
        }
    }
});
