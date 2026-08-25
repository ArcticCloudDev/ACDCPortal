'use strict';

const { processTemplate } = require('./mail');

function buildEmailHtml(templateConfig, mergeData, eventOverrides = {}) {
    const features = templateConfig.features || [];

    const headerTitle = processTemplate(eventOverrides.headerTitle || templateConfig.headerTitle || '', mergeData);

    const resolvedButtonText = eventOverrides.buttonText !== undefined
        ? eventOverrides.buttonText
        : templateConfig.buttonText;
    const buttonText = resolvedButtonText
        ? processTemplate(resolvedButtonText, mergeData)
        : null;
    const buttonUrl = templateConfig.buttonUrlField
        ? (mergeData[templateConfig.buttonUrlField] || '#')
        : null;

    const bodyText = processTemplate(mergeData.bodyText || '', mergeData);
    const closingText = processTemplate(mergeData.closingText || '', mergeData);

    const teamBoxHtml = features.includes('teamBox') ? `
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 24px 0;">
                        <tr>
                            <td style="padding: 20px; background-color: #f0f9ff; border-radius: 8px; border-left: 4px solid #1a365d;">
                                <p style="margin: 0 0 8px 0; font-size: 14px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Participation Details</p>
                                <p style="margin: 0 0 4px 0; font-size: 18px; font-weight: 600; color: #1e293b;">${mergeData.teamName || ''}</p>
                                <p style="margin: 0; font-size: 14px; color: #475569;">${mergeData.committedParticipants || ''} committed participants</p>
                            </td>
                        </tr>
                    </table>` : '';

    const buttonHtml = buttonText ? `
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                            <td align="left" style="padding: 20px 0;">
                                <table role="presentation" cellspacing="0" cellpadding="0">
                                    <tr>
                                        <td align="center" bgcolor="#1a365d" style="background-color: #1a365d; border-radius: 8px; padding: 18px 50px;">
                                            <a href="${buttonUrl}" style="display: block; color: #ffffff; text-decoration: none; font-size: 18px; font-weight: 600; line-height: 1.2;">
                                                ${buttonText}
                                            </a>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                    </table>` : '';

    const expiryHtml = features.includes('expiryNotice') ? `
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 16px;">
                        <tr>
                            <td align="center">
                                <div style="display: inline-block; background-color: #fef3c7; padding: 10px 20px; border-radius: 20px;">
                                    <p style="color: #92400e; font-size: 13px; margin: 0; font-weight: 500;">
                                        ⏰ This invitation expires in 7 days
                                    </p>
                                </div>
                            </td>
                        </tr>
                    </table>` : '';

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background-color: #f3f4f6;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f3f4f6;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <tr>
                        <td bgcolor="#1a365d" style="background-color: #1a365d; padding: 28px 40px; text-align: center;">
                            <p style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff; line-height: 1.3;">${headerTitle}</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px;">
                            <div style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #475569;">
                                ${bodyText}
                            </div>
                            ${teamBoxHtml}
                            ${buttonHtml}
                            ${expiryHtml}
                            <div style="margin: 24px 0 0 0; font-size: 16px; line-height: 1.6; color: #475569;">
                                ${closingText}
                            </div>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

module.exports = { buildEmailHtml };
