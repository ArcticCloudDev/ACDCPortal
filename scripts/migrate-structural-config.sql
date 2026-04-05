-- Migration: populate StructuralConfig column for SystemEmailConfig rows
-- Run once after adding the StructuralConfig column to the live database.

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"You''re Invited to Judge","buttonText":"Accept Judge Invitation","buttonUrlField":"acceptUrl","signaturePrefix":"","signatureName":"The {{eventName}} Team","footer":"You received this email because {{inviterName}} invited you to judge {{eventName}}.","features":["expiryNotice"]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'invitation-judge';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"You''re Invited to Join the Committee","buttonText":"Accept Committee Invitation","buttonUrlField":"acceptUrl","signaturePrefix":"","signatureName":"The {{eventName}} Team","footer":"You received this email because {{inviterName}} invited you to the {{eventName}} committee.","features":["expiryNotice"]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'invitation-committee';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"Thanks for Your Interest!","buttonText":null,"buttonUrlField":null,"signaturePrefix":"","signatureName":"The ACDC Team","footer":"You''re receiving this email because you expressed interest in {{eventName}}.","features":[]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'interest-acknowledgment';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"Welcome to {{eventName}}!","buttonText":"View Team Dashboard","buttonUrlField":"portalUrl","signaturePrefix":"Best regards,","signatureName":"The {{eventName}} Team","footer":"This is an automated email from {{eventName}}. Please do not reply to this email.","features":[]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'team-welcome';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"Team Registration Confirmed!","buttonText":"Manage Your Team","buttonUrlField":"portalUrl","signaturePrefix":"Best regards,","signatureName":"The {{eventName}} Team","footer":"This is an automated email from {{eventName}}. Please do not reply to this email.","features":["teamBox"]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'team-registration';

SELECT TemplateKey, LEN(StructuralConfig) AS StructuralConfigLen, UpdatedAt
FROM SystemEmailConfig
ORDER BY TemplateKey;
