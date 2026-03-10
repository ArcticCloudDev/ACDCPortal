// ACDC Portal - File Upload API (SharePoint)
const { app } = require('@azure/functions');
const SharePointStorage = require('../shared/sharepoint');
const multipart = require('parse-multipart-data');

// POST /api/files/upload - Upload a file
app.http('files-upload', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'files/upload',
    handler: async (request, context) => {
        try {
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
            context.error('File upload error:', error);
            return { 
                status: 500, 
                jsonBody: { error: 'Failed to upload file', details: error.message } 
            };
        }
    }
});

// GET /api/files/list - List files for a team
app.http('files-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'files/list',
    handler: async (request, context) => {
        try {
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
            
            // Build folder path
            const folderPath = `Events/${eventId}/${teamId}`;
            
            const files = await SharePointStorage.listFiles(folderPath);
            
            return { status: 200, jsonBody: files };
            
        } catch (error) {
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
    authLevel: 'anonymous',
    route: 'files/download',
    handler: async (request, context) => {
        try {
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
    authLevel: 'anonymous',
    route: 'files/delete',
    handler: async (request, context) => {
        try {
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
            
            await SharePointStorage.deleteFile(filePath);
            
            context.log(`File deleted: ${filePath}`);
            
            return { 
                status: 200, 
                jsonBody: { message: 'File deleted successfully' } 
            };
            
        } catch (error) {
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
    authLevel: 'anonymous',
    route: 'files/setup-columns',
    handler: async (request, context) => {
        try {
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
            context.error('Setup columns error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to set up columns', details: error.message }
            };
        }
    }
});

console.log('Files API loaded');
