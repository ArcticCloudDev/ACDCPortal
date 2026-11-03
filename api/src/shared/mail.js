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

function extractInlineImages(html) {
    const attachments = [];
    let processedHtml = html;

    const base64ImageRegex = /<img[^>]+src="data:image\/(png|jpeg|jpg|gif|webp);base64,([^"]+)"[^>]*>/gi;

    let match;
    let imageIndex = 0;

    while ((match = base64ImageRegex.exec(html)) !== null) {
        const fullMatch = match[0];
        const imageType = match[1];
        const base64Data = match[2];

        const contentId = `image${imageIndex}@acdc.blog`;
        imageIndex++;

        const cidImg = fullMatch.replace(
            /src="data:image\/[^;]+;base64,[^"]+"/,
            `src="cid:${contentId}"`
        );

        processedHtml = processedHtml.replace(fullMatch, cidImg);

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

async function sendEmail({ to, subject, htmlContent, textContent }) {
    const accessToken = await getAccessToken();

    const recipients = Array.isArray(to) ? to : [to];

    const { html: processedHtml, attachments } = extractInlineImages(htmlContent);

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

// Merge keys whose values are trusted, already-built HTML fragments. Everything else
// (names, team names, messages, URLs...) is user-supplied text and gets HTML-escaped.
const RAW_HTML_KEYS = ['content', 'bodyText', 'closingText', 'digestContent', 'actionItems', 'teamBoxHtml'];

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// Replaces {{key}} placeholders and {{#if key}}...{{/if}} blocks. Values are HTML-escaped
// unless the key is in RAW_HTML_KEYS; pass { html: false } for plain-text output (subjects).
function processTemplate(template, data = {}, options = {}) {
    const escape = options.html !== false;
    let result = String(template ?? '');

    result = result.replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (match, key, content) => {
        return data[key] ? content : '';
    });

    result = result.replace(/{{(\w+)}}/g, (match, key) => {
        const val = data[key] !== undefined && data[key] !== null ? String(data[key]) : '';
        return escape && !RAW_HTML_KEYS.includes(key) ? escapeHtml(val) : val;
    });

    return result;
}

module.exports = {
    sendEmail,
    processTemplate,
    escapeHtml,
    extractInlineImages,
    RAW_HTML_KEYS,
    get SENDER_EMAIL() { return process.env.MAIL_SENDER || 'no-reply@acdc.blog'; }
};
