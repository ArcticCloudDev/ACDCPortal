-- Migration: populate StructuralConfig column for SystemEmailConfig rows
-- Run once after adding the StructuralConfig column to the live database.
-- Updated: merge signaturePrefix + signatureName + footer into single signatureText field.

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"You''re Invited to Judge","buttonText":"Accept Judge Invitation","buttonUrlField":"acceptUrl","signatureText":"The {{eventName}} Team","features":["expiryNotice"]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'invitation-judge';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"You''re Invited to Join the Committee","buttonText":"Accept Committee Invitation","buttonUrlField":"acceptUrl","signatureText":"The {{eventName}} Team","features":["expiryNotice"]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'invitation-committee';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"Thanks for Your Interest!","buttonText":null,"buttonUrlField":null,"signatureText":"The ACDC Team","features":[]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'interest-acknowledgment';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"Welcome to {{eventName}}!","buttonText":"View Team Dashboard","buttonUrlField":"portalUrl","signatureText":"Best regards,\nThe {{eventName}} Team","features":[]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'team-welcome';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"Team Registration Confirmed!","buttonText":"Manage Your Team","buttonUrlField":"portalUrl","signatureText":"Best regards,\nThe {{eventName}} Team","features":["teamBox"]}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'team-registration';

SELECT TemplateKey, LEN(StructuralConfig) AS StructuralConfigLen, UpdatedAt
FROM SystemEmailConfig
ORDER BY TemplateKey;
