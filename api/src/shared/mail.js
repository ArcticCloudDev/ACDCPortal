// Mail sending helper using Microsoft Graph API
// Sends emails from no-reply@acdc.blog via Graph API

const { ConfidentialClientApplication } = require('@azure/msal-node');

let msalClient = null;

function getMsalClient() {
    if (!msalClient && process.env.MAIL_CLIENT_ID) {
        msalClient = new ConfidentialClientApplication({
            auth: {
                clientId: process.env.MAIL_CLIENT_ID,
                clientSecret: process.env.MAIL_CLIENT_SECRET,
                authority: `https://login.microsoftonline.com/${process.env.MAIL_TENANT_ID}`
            }
        });
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
 * Extract base64 images from HTML and convert to inline attachments
 * @param {string} html - HTML content with potential base64 images
 * @returns {Object} - { html: processed HTML, attachments: array of attachment objects }
 */
function extractInlineImages(html) {
    const attachments = [];
    let processedHtml = html;
    
    // Match base64 images: <img src="data:image/...;base64,..." />
    const base64ImageRegex = /<img[^>]+src="data:image\/(png|jpeg|jpg|gif|webp);base64,([^"]+)"[^>]*>/gi;
    
    let match;
    let imageIndex = 0;
    
    while ((match = base64ImageRegex.exec(html)) !== null) {
        const fullMatch = match[0];
        const imageType = match[1];
        const base64Data = match[2];
        
        // Generate unique Content-ID
        const contentId = `image${imageIndex}@acdc.blog`;
        imageIndex++;
        
        // Replace base64 src with cid reference
        const cidImg = fullMatch.replace(
            /src="data:image\/[^;]+;base64,[^"]+"/,
            `src="cid:${contentId}"`
        );
        
        processedHtml = processedHtml.replace(fullMatch, cidImg);
        
        // Add to attachments array
        attachments.push({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: `image${imageIndex}.${imageType}`,
            contentType: `image/${imageType}`,
            contentBytes: base64Data,
            contentId: contentId,
            isInline: true
        });
    }
    
    return { html: processedHtml, attachments };
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
    
    // Extract and convert base64 images to inline attachments
    const { html: processedHtml, attachments } = extractInlineImages(htmlContent);
    
    // DEBUG: Save the actual HTML being sent to a file for inspection
    try {
        const debugFs = require('fs');
        const debugPath = require('path');
        const debugFile = debugPath.join(__dirname, '../../data/debug-last-email.html');
        debugFs.writeFileSync(debugFile, processedHtml, 'utf-8');
        console.log(`[DEBUG] Email HTML saved to ${debugFile}`);
        console.log(`[DEBUG] Subject: ${subject}`);
        console.log(`[DEBUG] To: ${recipients.join(', ')}`);
        // Check for href values in the HTML
        const hrefMatches = processedHtml.match(/href="([^"]+)"/g);
        console.log(`[DEBUG] Links found:`, hrefMatches);
    } catch (e) { console.log('[DEBUG] Could not save debug email:', e.message); }
    
    const message = {
        message: {
            subject: subject,
            body: {
                contentType: 'HTML',
                content: processedHtml
            },
            toRecipients: recipients.map(email => ({
                emailAddress: { address: email }
            }))
        },
        saveToSentItems: true
    };
    
    // Add inline attachments if any base64 images were found
    if (attachments.length > 0) {
        message.message.attachments = attachments;
    }
    
    const response = await fetch(
        `https://graph.microsoft.com/v1.0/users/${process.env.MAIL_SENDER || 'no-reply@acdc.blog'}/sendMail`,
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
function processTemplate(template, data = {}) {
    let result = template;
    
    // DEBUG: Log all merge data keys and values
    console.log('[processTemplate] ===== MERGE DATA =====');
    for (const [key, value] of Object.entries(data)) {
        const display = typeof value === 'string' && value.length > 80 ? value.substring(0, 80) + '...' : value;
        console.log(`[processTemplate]   ${key} = "${display}"`);
    }
    
    // Find all placeholders in the template BEFORE replacement
    const placeholders = template.match(/{{(\w+)}}/g) || [];
    console.log(`[processTemplate] Placeholders in template: ${placeholders.join(', ')}`);
    
    // Handle conditional blocks FIRST (before replacing placeholders)
    // {{#if key}}...{{/if}}
    result = result.replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (match, key, content) => {
        return data[key] ? content : '';
    });
    
    // Replace simple placeholders
    // Match {{placeholder}} and replace with value or empty string
    result = result.replace(/{{(\w+)}}/g, (match, key) => {
        const val = data[key] !== undefined && data[key] !== null ? String(data[key]) : '';
        if (key === 'acceptUrl' || key === 'inviteId') {
            console.log(`[processTemplate] REPLACING {{${key}}} => "${val}"`);
        }
        return val;
    });
    
    return result;
}

module.exports = {
    sendEmail,
    sendBulkEmail,
    processTemplate,
    get SENDER_EMAIL() { return process.env.MAIL_SENDER || 'no-reply@acdc.blog'; }
};
