// SharePoint Storage Module - File upload/download via Microsoft Graph API
// Reuses the same app registration as mail (MAIL_CLIENT_ID) since both need Graph API access
// The app needs Sites.ReadWrite.All application permission with admin consent

const { ConfidentialClientApplication } = require('@azure/msal-node');
const fetch = require('node-fetch');

// Reuse MAIL credentials - same app registration, same tenant
const config = {
    tenantId: process.env.MAIL_TENANT_ID,
    clientId: process.env.MAIL_CLIENT_ID,
    clientSecret: process.env.MAIL_CLIENT_SECRET,
    siteUrl: process.env.SHAREPOINT_SITE_URL,  // e.g., "acdc.sharepoint.com:/sites/ACDC"
    documentLibrary: process.env.SHAREPOINT_DOC_LIBRARY || 'Team Files'
};

// MSAL configuration for app-only auth
const msalConfig = {
    auth: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        authority: `https://login.microsoftonline.com/${config.tenantId}`
    }
};

let msalClient = null;
let siteId = null;
let driveId = null;

// Initialize MSAL client
function getMsalClient() {
    if (!msalClient && config.clientId && config.clientSecret) {
        msalClient = new ConfidentialClientApplication(msalConfig);
    }
    return msalClient;
}

// Get access token using client credentials
async function getAccessToken() {
    const client = getMsalClient();
    if (!client) {
        throw new Error('SharePoint not configured - missing credentials');
    }
    
    const result = await client.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default']
    });
    
    return result.accessToken;
}

// Make authenticated Graph API request
async function graphRequest(endpoint, options = {}) {
    const token = await getAccessToken();
    
    const url = endpoint.startsWith('https://') 
        ? endpoint 
        : `https://graph.microsoft.com/v1.0${endpoint}`;
    
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers
        }
    });
    
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Graph API error (${response.status}): ${error}`);
    }
    
    // Handle no-content responses
    if (response.status === 204) {
        return null;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        return response.json();
    }
    
    return response;
}

// Get SharePoint Site ID from URL
async function getSiteId() {
    if (siteId) return siteId;
    
    // Parse site URL to get hostname and site path
    // Expected format: "yourtenant.sharepoint.com:/sites/ACDC" or full URL
    let siteRef = config.siteUrl;
    
    if (siteRef.startsWith('https://')) {
        const url = new URL(siteRef);
        siteRef = `${url.hostname}:${url.pathname}`;
    }
    
    const site = await graphRequest(`/sites/${siteRef}`);
    siteId = site.id;
    
    console.log(`SharePoint Site ID: ${siteId}`);
    return siteId;
}

// Get Document Library Drive ID
async function getDriveId() {
    if (driveId) return driveId;
    
    const siteIdValue = await getSiteId();
    const drives = await graphRequest(`/sites/${siteIdValue}/drives`);
    
    // Find the specified document library or default to first one
    const drive = drives.value.find(d => d.name === config.documentLibrary) || drives.value[0];
    
    if (!drive) {
        throw new Error(`Document library "${config.documentLibrary}" not found`);
    }
    
    driveId = drive.id;
    console.log(`Document Library Drive ID: ${driveId} (${drive.name})`);
    return driveId;
}

// Ensure folder exists (creates if not)
async function ensureFolder(folderPath) {
    const drive = await getDriveId();
    const site = await getSiteId();
    
    // Split path and create each folder level
    const folders = folderPath.split('/').filter(f => f);
    let currentPath = '';
    
    for (const folder of folders) {
        const parentPath = currentPath || 'root';
        currentPath = currentPath ? `${currentPath}/${folder}` : folder;
        
        try {
            // Check if folder exists
            await graphRequest(`/sites/${site}/drives/${drive}/root:/${currentPath}`);
        } catch (error) {
            // Folder doesn't exist, create it
            await graphRequest(`/sites/${site}/drives/${drive}/${parentPath === 'root' ? 'root' : `root:/${parentPath}:`}/children`, {
                method: 'POST',
                body: JSON.stringify({
                    name: folder,
                    folder: {},
                    '@microsoft.graph.conflictBehavior': 'fail'
                })
            });
            console.log(`Created folder: ${currentPath}`);
        }
    }
    
    return currentPath;
}

// SharePoint Storage API
const SharePointStorage = {
    /**
     * Check if SharePoint is configured
     */
    isConfigured() {
        return !!(config.clientId && config.clientSecret && config.siteUrl && config.tenantId);
    },
    
    /**
     * Upload a file to SharePoint
     * @param {Buffer|string} content - File content
     * @param {string} fileName - Name of the file
     * @param {string} folderPath - Folder path within document library (e.g., "Events/ACDC2027/TeamFiles")
     * @returns {object} - File metadata including webUrl
     */
    async uploadFile(content, fileName, folderPath) {
        const drive = await getDriveId();
        const site = await getSiteId();
        
        // Ensure folder exists
        await ensureFolder(folderPath);
        
        // Sanitize filename
        const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_');
        const fullPath = `${folderPath}/${safeName}`;
        
        // For files < 4MB, use simple upload
        // For larger files, would need to use upload session
        const fileBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        
        if (fileBuffer.length > 4 * 1024 * 1024) {
            throw new Error('File too large. Files over 4MB require chunked upload (not yet implemented)');
        }
        
        const token = await getAccessToken();
        const url = `https://graph.microsoft.com/v1.0/sites/${site}/drives/${drive}/root:/${fullPath}:/content`;
        
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/octet-stream'
            },
            body: fileBuffer
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Upload failed (${response.status}): ${error}`);
        }
        
        const result = await response.json();
        
        return {
            id: result.id,
            name: result.name,
            size: result.size,
            webUrl: result.webUrl,
            createdDateTime: result.createdDateTime,
            lastModifiedDateTime: result.lastModifiedDateTime
        };
    },
    
    /**
     * List files in a folder
     * @param {string} folderPath - Folder path within document library
     * @returns {array} - List of files
     */
    async listFiles(folderPath) {
        const drive = await getDriveId();
        const site = await getSiteId();
        
        const endpoint = folderPath 
            ? `/sites/${site}/drives/${drive}/root:/${folderPath}:/children`
            : `/sites/${site}/drives/${drive}/root/children`;
        
        const result = await graphRequest(endpoint);
        
        return result.value.map(item => ({
            id: item.id,
            name: item.name,
            size: item.size,
            isFolder: !!item.folder,
            webUrl: item.webUrl,
            createdDateTime: item.createdDateTime,
            lastModifiedDateTime: item.lastModifiedDateTime,
            createdBy: item.createdBy?.user?.displayName,
            downloadUrl: item['@microsoft.graph.downloadUrl']
        }));
    },
    
    /**
     * Get file metadata
     * @param {string} filePath - Full path to file
     * @returns {object} - File metadata
     */
    async getFile(filePath) {
        const drive = await getDriveId();
        const site = await getSiteId();
        
        const result = await graphRequest(`/sites/${site}/drives/${drive}/root:/${filePath}`);
        
        return {
            id: result.id,
            name: result.name,
            size: result.size,
            webUrl: result.webUrl,
            createdDateTime: result.createdDateTime,
            lastModifiedDateTime: result.lastModifiedDateTime,
            downloadUrl: result['@microsoft.graph.downloadUrl']
        };
    },
    
    /**
     * Download file content
     * @param {string} filePath - Full path to file
     * @returns {Buffer} - File content
     */
    async downloadFile(filePath) {
        const drive = await getDriveId();
        const site = await getSiteId();
        
        const token = await getAccessToken();
        const url = `https://graph.microsoft.com/v1.0/sites/${site}/drives/${drive}/root:/${filePath}:/content`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`Download failed (${response.status})`);
        }
        
        return response.buffer();
    },
    
    /**
     * Delete a file
     * @param {string} filePath - Full path to file
     */
    async deleteFile(filePath) {
        const drive = await getDriveId();
        const site = await getSiteId();
        
        await graphRequest(`/sites/${site}/drives/${drive}/root:/${filePath}`, {
            method: 'DELETE'
        });
        
        return true;
    },
    
    /**
     * Get a sharing link for a file
     * @param {string} filePath - Full path to file
     * @param {string} type - 'view' or 'edit'
     * @param {string} scope - 'anonymous', 'organization', or 'users'
     * @returns {object} - Sharing link info
     */
    async createSharingLink(filePath, type = 'view', scope = 'organization') {
        const drive = await getDriveId();
        const site = await getSiteId();
        
        const result = await graphRequest(`/sites/${site}/drives/${drive}/root:/${filePath}:/createLink`, {
            method: 'POST',
            body: JSON.stringify({
                type: type,
                scope: scope
            })
        });
        
        return {
            webUrl: result.link.webUrl,
            type: result.link.type,
            scope: result.link.scope
        };
    }
};

module.exports = SharePointStorage;
