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

function processTemplate(template, data = {}) {
    let result = template;

    console.log('[processTemplate] ===== MERGE DATA =====');
    for (const [key, value] of Object.entries(data)) {
        const display = typeof value === 'string' && value.length > 80 ? value.substring(0, 80) + '...' : value;
        console.log(`[processTemplate]   ${key} = "${display}"`);
    }

    const placeholders = template.match(/{{(\w+)}}/g) || [];
    console.log(`[processTemplate] Placeholders in template: ${placeholders.join(', ')}`);

    result = result.replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (match, key, content) => {
        return data[key] ? content : '';
    });

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
