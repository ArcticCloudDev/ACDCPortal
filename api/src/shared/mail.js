// Mail sending helper using Microsoft Graph API
// Sends emails from no-reply@acdc.blog via Graph API

const { ConfidentialClientApplication } = require('@azure/msal-node');

// Configuration for the M365 tenant (not External ID tenant)
// These need to be set in environment variables or local.settings.json
const config = {
    auth: {
        clientId: process.env.MAIL_CLIENT_ID,
        clientSecret: process.env.MAIL_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${process.env.MAIL_TENANT_ID}`
    }
};

const SENDER_EMAIL = process.env.MAIL_SENDER || 'no-reply@acdc.blog';

let msalClient = null;

function getMsalClient() {
    if (!msalClient && config.auth.clientId) {
        msalClient = new ConfidentialClientApplication(config);
    }
    return msalClient;
}

async function getAccessToken() {
    const client = getMsalClient();
    if (!client) {
        throw new Error('Mail client not configured. Set MAIL_CLIENT_ID, MAIL_CLIENT_SECRET, and MAIL_TENANT_ID.');
    }
    
    const result = await client.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default']
    });
    
    return result.accessToken;
}

/**
 * Send an email using Microsoft Graph API
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.subject - Email subject
 * @param {string} options.htmlContent - HTML body content
 * @param {string} [options.textContent] - Plain text fallback (optional)
 * @returns {Promise<Object>} - Result object with success status
 */
async function sendEmail({ to, subject, htmlContent, textContent }) {
    const accessToken = await getAccessToken();
    
    // Normalize to array
    const recipients = Array.isArray(to) ? to : [to];
    
    const message = {
        message: {
            subject: subject,
            body: {
                contentType: 'HTML',
                content: htmlContent
            },
            toRecipients: recipients.map(email => ({
                emailAddress: { address: email }
            }))
        },
        saveToSentItems: true
    };
    
    const response = await fetch(
        `https://graph.microsoft.com/v1.0/users/${SENDER_EMAIL}/sendMail`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(message)
        }
    );
    
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to send email: ${response.status} - ${error}`);
    }
    
    return { success: true, recipients: recipients.length };
}

/**
 * Send emails in batches (for large recipient lists)
 * Graph API recommends max 100 recipients per request
 * @param {Object} options - Email options
 * @param {string[]} options.to - Array of recipient emails
 * @param {string} options.subject - Email subject
 * @param {string} options.htmlContent - HTML body content
 * @returns {Promise<Object>} - Result with success count
 */
async function sendBulkEmail({ to, subject, htmlContent }) {
    const BATCH_SIZE = 100;
    const results = { sent: 0, failed: 0, errors: [] };
    
    for (let i = 0; i < to.length; i += BATCH_SIZE) {
        const batch = to.slice(i, i + BATCH_SIZE);
        try {
            await sendEmail({ to: batch, subject, htmlContent });
            results.sent += batch.length;
        } catch (error) {
            results.failed += batch.length;
            results.errors.push({ batch: i / BATCH_SIZE, error: error.message });
        }
    }
    
    return results;
}

/**
 * Replace template placeholders with actual values
 * @param {string} template - HTML template with {{placeholders}}
 * @param {Object} data - Key-value pairs for replacement
 * @returns {string} - Processed HTML
 */
function processTemplate(template, data) {
    let result = template;
    
    // Replace simple placeholders
    for (const [key, value] of Object.entries(data)) {
        const placeholder = new RegExp(`{{${key}}}`, 'g');
        result = result.replace(placeholder, value || '');
    }
    
    // Handle conditional blocks {{#if key}}...{{/if}}
    result = result.replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (match, key, content) => {
        return data[key] ? content : '';
    });
    
    return result;
}

module.exports = {
    sendEmail,
    sendBulkEmail,
    processTemplate,
    SENDER_EMAIL
};
