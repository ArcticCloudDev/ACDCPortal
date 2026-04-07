-- Migration: remove signatureText from StructuralConfig, fold into EditableSections.closing

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"You''re Invited to Judge","buttonText":"Accept Judge Invitation","buttonUrlField":"acceptUrl","features":["expiryNotice"]}',
    EditableSections = N'{"body":"<p>Hi {{firstName}},</p><p>You''ve been selected to serve as a <strong>judge</strong> for {{eventName}}. We''d be honored to have your expertise help evaluate the competing teams.</p><p>Please click the button below to accept the invitation and complete your registration.</p>","closing":"<p>We look forward to having you on the judging panel!</p><p>The {{eventName}} Team</p>"}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'invitation-judge';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"You''re Invited to Join the Committee","buttonText":"Accept Committee Invitation","buttonUrlField":"acceptUrl","features":["expiryNotice"]}',
    EditableSections = N'{"body":"<p>Hi {{firstName}},</p><p>You''ve been invited to join the <strong>organizing committee</strong> for {{eventName}}. Your help in making this event a success would be greatly appreciated.</p><p>Please click the button below to accept the invitation and complete your registration.</p>","closing":"<p>We look forward to working with you!</p><p>The {{eventName}} Team</p>"}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'invitation-committee';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"You''re on the List!","buttonText":"View Event","buttonUrlField":"portalUrl","features":[]}',
    EditableSections = N'{"body":"<p>Hi {{fullName}},</p><p>Your interest in {{eventName}} has been confirmed. We''ll be in touch as registration opens.</p><p>In the meantime, check out the event details below!</p>","closing":"<p>We look forward to seeing you at the event!</p><p>The ACDC Team</p>"}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'interest-acknowledgment';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"Welcome to {{eventName}}!","buttonText":"View Team Dashboard","buttonUrlField":"portalUrl","features":[]}',
    EditableSections = N'{"body":"<p>Hi {{fullName}},</p><p>We''re excited to have you participate in {{eventName}}.</p><p>Your team admin {{teamAdminName}} has added you to {{teamName}}.</p><p>Please complete your profile!</p>","closing":"<p>Good luck in the competition!</p><p>Best regards,<br>The {{eventName}} Team</p>"}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'team-welcome';

UPDATE SystemEmailConfig SET
    StructuralConfig = N'{"headerTitle":"Team Registration Confirmed!","buttonText":"Manage Your Team","buttonUrlField":"portalUrl","features":["teamBox"]}',
    EditableSections = N'{"body":"<p>Hi {{fullName}},</p><p>Your team <strong>{{teamName}}</strong> has been successfully registered for <strong>{{eventName}}</strong>!</p><p>You can now invite team members and manage your team from the portal.</p>","closing":"<p>Good luck in the competition!</p><p>Best regards,<br>The {{eventName}} Team</p>"}',
    UpdatedAt = SYSUTCDATETIME()
WHERE TemplateKey = 'team-registration';

SELECT TemplateKey, LEN(StructuralConfig) AS StructuralConfigLen, UpdatedAt
FROM SystemEmailConfig
ORDER BY TemplateKey;
