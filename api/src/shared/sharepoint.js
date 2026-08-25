const { ConfidentialClientApplication } = require('@azure/msal-node');
const fetch = require('node-fetch');

let msalClient = null;

function getConfig() {
    return {
        tenantId: process.env.MAIL_TENANT_ID,
        clientId: process.env.MAIL_CLIENT_ID,
        clientSecret: process.env.MAIL_CLIENT_SECRET,
        siteUrl: process.env.SHAREPOINT_SITE_URL,
        documentLibrary: process.env.SHAREPOINT_DOC_LIBRARY || 'Team Files'
    };
}
let siteId = null;
let driveId = null;

function getMsalClient() {
    const config = getConfig();
    if (!msalClient && config.clientId && config.clientSecret) {
        msalClient = new ConfidentialClientApplication({
            auth: {
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                authority: `https://login.microsoftonline.com/${config.tenantId}`
            }
        });
    }
    return msalClient;
}

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

    if (response.status === 204) {
        return null;
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        return response.json();
    }

    return response;
}

async function getSiteId() {
    if (siteId) return siteId;

    let siteRef = getConfig().siteUrl;

    if (siteRef.startsWith('https://')) {
        const url = new URL(siteRef);
        siteRef = `${url.hostname}:${url.pathname}`;
    }

    const site = await graphRequest(`/sites/${siteRef}`);
    siteId = site.id;

    console.log(`SharePoint Site ID: ${siteId}`);
    return siteId;
}

async function getDriveId() {
    if (driveId) return driveId;

    const siteIdValue = await getSiteId();
    const drives = await graphRequest(`/sites/${siteIdValue}/drives`);

    const drive = drives.value.find(d => d.name === getConfig().documentLibrary) || drives.value[0];

    if (!drive) {
        throw new Error(`Document library "${getConfig().documentLibrary}" not found`);
    }

    driveId = drive.id;
    console.log(`Document Library Drive ID: ${driveId} (${drive.name})`);
    return driveId;
}

async function ensureFolder(folderPath) {
    const drive = await getDriveId();
    const site = await getSiteId();

    const folders = folderPath.split('/').filter(f => f);
    let currentPath = '';

    for (const folder of folders) {
        const parentPath = currentPath || 'root';
        currentPath = currentPath ? `${currentPath}/${folder}` : folder;

        try {
            await graphRequest(`/sites/${site}/drives/${drive}/root:/${currentPath}`);
        } catch (error) {
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

const SharePointStorage = {
    isConfigured() {
        const config = getConfig();
        return !!(config.clientId && config.clientSecret && config.siteUrl && config.tenantId);
    },

    async uploadFile(content, fileName, folderPath) {
        const drive = await getDriveId();
        const site = await getSiteId();

        await ensureFolder(folderPath);

        const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_');
        const fullPath = `${folderPath}/${safeName}`;

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

    async listFiles(folderPath) {
        const drive = await getDriveId();
        const site = await getSiteId();

        const base = folderPath
            ? `/sites/${site}/drives/${drive}/root:/${folderPath}:/children`
            : `/sites/${site}/drives/${drive}/root/children`;

        const endpoint = `${base}?$expand=listItem($expand=fields)`;

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
            downloadUrl: item['@microsoft.graph.downloadUrl'],
            category: item.listItem?.fields?.FileCategory || null
        }));
    },

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

    async deleteFile(filePath) {
        const drive = await getDriveId();
        const site = await getSiteId();

        await graphRequest(`/sites/${site}/drives/${drive}/root:/${filePath}`, {
            method: 'DELETE'
        });

        return true;
    },

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
    },

    async ensureChoiceColumn(columnName, choices) {
        const site = await getSiteId();
        const drive = await getDriveId();

        const list = await graphRequest(`/sites/${site}/drives/${drive}/list`);
        const listId = list.id;

        try {
            const cols = await graphRequest(`/sites/${site}/lists/${listId}/columns`);
            const existing = cols.value.find(
                c => c.name === columnName || c.displayName === columnName
            );

            if (existing) {
                const currentChoices = existing.choice?.choices || [];
                const merged = [...new Set([...currentChoices, ...choices])];
                if (merged.length > currentChoices.length) {
                    await graphRequest(
                        `/sites/${site}/lists/${listId}/columns/${existing.id}`,
                        {
                            method: 'PATCH',
                            body: JSON.stringify({ choice: { choices: merged } })
                        }
                    );
                }
                return existing;
            }
        } catch (err) {
            console.warn('Could not list columns, attempting to create:', err.message);
        }

        const columnDef = {
            name: columnName,
            displayName: columnName,
            choice: {
                allowTextEntry: false,
                choices: choices
            }
        };

        return await graphRequest(`/sites/${site}/lists/${listId}/columns`, {
            method: 'POST',
            body: JSON.stringify(columnDef)
        });
    },

    async setFileMetadata(itemId, fields) {
        const site = await getSiteId();
        const drive = await getDriveId();

        return await graphRequest(
            `/sites/${site}/drives/${drive}/items/${itemId}/listItem/fields`,
            {
                method: 'PATCH',
                body: JSON.stringify(fields)
            }
        );
    }
};

module.exports = SharePointStorage;
