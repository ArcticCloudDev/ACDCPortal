// ACDC Portal - File Upload API (SharePoint)
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { requireAuth, isTeamMember } = require('../shared/auth');
const SharePointStorage = require('../shared/sharepoint');
const { Storage } = require('../shared/storage');
const participationsStorage = new Storage('participations');
const multipart = require('parse-multipart-data');

// Extract {eventId, teamId} from a SharePoint folder/file path like "Events/{eventId}/{teamId}/..."
function parseTeamPathSegments(filePath) {
    const match = /Events\/([^/]+)\/([^/]+)/i.exec(filePath || '');
    return match ? { eventId: match[1], teamId: match[2] } : null;
}

// POST /api/files/upload - Upload a file
app.http('files-upload', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'files/upload',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            // Check if SharePoint is configured
            if (!SharePointStorage.isConfigured()) {
                return { 
                    status: 503, 
                    jsonBody: { error: 'File storage not configured' } 
                };
            }
            
            // Get metadata from query params
            const eventId = request.query.get('eventId');
            const teamId = request.query.get('teamId');
            const category = request.query.get('category') || 'General';
            
            if (!eventId || !teamId) {
                return { 
                    status: 400, 
                    jsonBody: { error: 'eventId and teamId are required' } 
                };
            }
            
            const uploadParticipations = await participationsStorage.getAll();
            if (!isTeamMember(auth.user, teamId, uploadParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to upload files for this team' } };
            }
            
            // Parse multipart form data
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
            const parts = multipart.parse(bodyBuffer, boundary);
            
            if (!parts || parts.length === 0) {
                return { 
                    status: 400, 
                    jsonBody: { error: 'No file found in request' } 
                };
            }
            
            const file = parts[0];
            const fileName = file.filename || 'unnamed-file';
            
            // Validate file size (max 10MB for now)
            const maxSize = 10 * 1024 * 1024;
            if (file.data.length > maxSize) {
                return { 
                    status: 400, 
                    jsonBody: { error: 'File too large. Maximum size is 10MB.' } 
                };
            }
            
            // Build folder path: Events/{eventId}/{teamId}
            const folderPath = `Events/${eventId}/${teamId}`;
            
            // Upload to SharePoint
            const result = await SharePointStorage.uploadFile(file.data, fileName, folderPath);
            
            // Set FileCategory metadata on the uploaded file (column must already exist via admin setup)
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
            await logError(context, error);
            context.error('File upload error:', error);
            return { 
                status: 500, 
                jsonBody: { error: 'Failed to upload file' } 
            };
        }
    }
});

// GET /api/files/list - List files for a team
app.http('files-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'files/list',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
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
            const category = request.query.get('category');
            
            if (!eventId || !teamId) {
                return { 
                    status: 400, 
                    jsonBody: { error: 'eventId and teamId are required' } 
                };
            }
            
            const listParticipations = await participationsStorage.getAll();
            if (!isTeamMember(auth.user, teamId, listParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to view files for this team' } };
            }
            
            // Build folder path
            const folderPath = `Events/${eventId}/${teamId}`;
            
            const files = await SharePointStorage.listFiles(folderPath);
            
            return { status: 200, jsonBody: files };
            
        } catch (error) {
            await logError(context, error);
            // If folder doesn't exist, return empty list
            if (error.message.includes('404')) {
                return { status: 200, jsonBody: [] };
            }
            
            context.error('File list error:', error);
            return { 
                status: 500, 
                jsonBody: { error: 'Failed to list files' } 
            };
        }
    }
});

// GET /api/files/download - Get download URL for a file
app.http('files-download', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'files/download',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
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
            
            const downloadSegments = parseTeamPathSegments(filePath);
            if (!downloadSegments) {
                return { status: 400, jsonBody: { error: 'Invalid file path' } };
            }
            const downloadParticipations = await participationsStorage.getAll();
            if (!isTeamMember(auth.user, downloadSegments.teamId, downloadParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to access this file' } };
            }
            
            const file = await SharePointStorage.getFile(filePath);
            
            return { 
                status: 200, 
                jsonBody: {
                    name: file.name,
                    downloadUrl: file.downloadUrl,
                    webUrl: file.webUrl
                }
            };
            
        } catch (error) {
            await logError(context, error);
            context.error('File download error:', error);
            return { 
                status: 500, 
                jsonBody: { error: 'Failed to get file' } 
            };
        }
    }
});

// DELETE /api/files/delete - Delete a file
app.http('files-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'files/delete',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context);
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
            
            const deleteSegments = parseTeamPathSegments(filePath);
            if (!deleteSegments) {
                return { status: 400, jsonBody: { error: 'Invalid file path' } };
            }
            const deleteParticipations = await participationsStorage.getAll();
            if (!isTeamMember(auth.user, deleteSegments.teamId, deleteParticipations)) {
                return { status: 403, jsonBody: { error: 'You do not have permission to delete this file' } };
            }
            
            await SharePointStorage.deleteFile(filePath);
            
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

// POST /api/files/setup-columns - Admin: ensure FileCategory choice column exists on the document library
app.http('files-setup-columns', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'files/setup-columns',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
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
            const categories = body.categories; // array of strings

            if (!Array.isArray(categories) || categories.length === 0) {
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

console.log('Files API loaded');
