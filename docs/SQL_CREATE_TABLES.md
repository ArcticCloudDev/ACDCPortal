# SQL CREATE TABLE Statements

Target: `acdc-portal-db.database.windows.net` / `acdc-portal-db`

Execute these statements **in order** (respects foreign key dependencies).

---

## 1. Events

```sql
CREATE TABLE Events (
    Id                          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    Name                        NVARCHAR(200)    NOT NULL,
    Description                 NVARCHAR(MAX)    NULL,
    StartDate                   DATE             NOT NULL,
    EndDate                     DATE             NOT NULL,
    Location                    NVARCHAR(500)    NULL,
    Status                      NVARCHAR(50)     NOT NULL DEFAULT 'draft',
        -- Values: draft, pre-registration, registration, live, completed
    RegistrationType            NVARCHAR(20)     NOT NULL DEFAULT 'team',
        -- Values: team, single, solo
    RegistrationOpen            BIT              NOT NULL DEFAULT 0,
    IsActive                    BIT              NOT NULL DEFAULT 0,
    MinTeamSize                 INT              NULL DEFAULT 3,
    MaxTeamSize                 INT              NULL DEFAULT 5,
    SequenceId                  UNIQUEIDENTIFIER NULL,
    SequenceEnabled             BIT              NOT NULL DEFAULT 0,
    CommitteeTeamId             UNIQUEIDENTIFIER NULL,
    JudgesTeamId                UNIQUEIDENTIFIER NULL,
    FileCategories              NVARCHAR(MAX)    NULL,
        -- Stored as JSON array, e.g. '["Team Presentation","Final Delivery"]'
    SendWelcomeEmail            BIT              NOT NULL DEFAULT 1,
    SendInterestAcknowledgment  BIT              NOT NULL DEFAULT 1,
    SendJudgeInvitationEmail    BIT              NOT NULL DEFAULT 1,
    SendCommitteeInvitationEmail BIT             NOT NULL DEFAULT 1,
    TeamWelcomeEmailId          UNIQUEIDENTIFIER NULL,
    SendTeamRegistrationEmail   BIT              NOT NULL DEFAULT 1,
    SharepointUrl               NVARCHAR(2000)   NULL,
    EventImage                  NVARCHAR(2000)   NULL,
        -- Public URL: /api/events/{id}/image — served from EventImageData
    EventImageData              NVARCHAR(MAX)    NULL,
        -- Base64 data URI of the event banner; stripped from API GET responses
    TeamRegistrationTerms       NVARCHAR(MAX)    NULL,
        -- HTML shown in a confirmation modal before team registration
    SoloQueueTerms              NVARCHAR(MAX)    NULL,
        -- HTML shown in a confirmation modal before joining the solo queue
    SingleRegistrationTerms     NVARCHAR(MAX)    NULL,
        -- HTML shown in a confirmation modal before individual registration
    CreatedAt                   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt                   DATETIME2        NULL,

    CONSTRAINT CK_Events_Status CHECK (Status IN ('draft','pre-registration','registration','live','completed')),
    CONSTRAINT CK_Events_RegType CHECK (RegistrationType IN ('team','single','solo'))
);
```

---

## 2. EventHotelDates

```sql
CREATE TABLE EventHotelDates (
    Id          INT              IDENTITY(1,1) NOT NULL PRIMARY KEY,
    EventId     UNIQUEIDENTIFIER NOT NULL,
    HotelDate   DATE             NOT NULL,
    DayLabel    NVARCHAR(10)     NOT NULL,  -- e.g. 'Wed'
    DayLabelFull NVARCHAR(20)    NOT NULL,  -- e.g. 'Wednesday'

    CONSTRAINT FK_EventHotelDates_Events FOREIGN KEY (EventId) REFERENCES Events(Id) ON DELETE CASCADE,
    CONSTRAINT UQ_EventHotelDates UNIQUE (EventId, HotelDate)
);
```

---

## 3. EventDefaultNights

```sql
CREATE TABLE EventDefaultNights (
    Id          INT              IDENTITY(1,1) NOT NULL PRIMARY KEY,
    EventId     UNIQUEIDENTIFIER NOT NULL,
    NightLabel  NVARCHAR(20)     NOT NULL,  -- e.g. 'thu-fri', 'fri-sat'

    CONSTRAINT FK_EventDefaultNights_Events FOREIGN KEY (EventId) REFERENCES Events(Id) ON DELETE CASCADE,
    CONSTRAINT UQ_EventDefaultNights UNIQUE (EventId, NightLabel)
);
```

---

## 4. Sequences

```sql
CREATE TABLE Sequences (
    Id          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    Name        NVARCHAR(200)    NOT NULL,
    Description NVARCHAR(MAX)    NULL,
    CreatedAt   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt   DATETIME2        NULL
);
```

---

## 5. Users

```sql
CREATE TABLE Users (
    Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    Email           NVARCHAR(320)    NOT NULL,
    FirstName       NVARCHAR(100)    NOT NULL,
    LastName        NVARCHAR(100)    NOT NULL,
    Phone           NVARCHAR(50)     NULL,
    Gamertag        NVARCHAR(100)    NULL,
    Allergies       NVARCHAR(MAX)    NULL,
    IsPortalAdmin   BIT              NOT NULL DEFAULT 0,
    ProfileComplete BIT              NOT NULL DEFAULT 0,
    TeamId          UNIQUEIDENTIFIER NULL,
        -- LEGACY field, being moved to participations. Kept for backward compat.
    CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt       DATETIME2        NULL,

    CONSTRAINT UQ_Users_Email UNIQUE (Email)
);

CREATE INDEX IX_Users_Email ON Users(Email);
```

---

## 6. Teams

```sql
CREATE TABLE Teams (
    Id                  UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    TeamName            NVARCHAR(200)    NOT NULL,
    EventId             UNIQUEIDENTIFIER NOT NULL,
    NumberOfParticipants INT             NULL,
    AdminUserId         UNIQUEIDENTIFIER NULL,
    IsSpecialTeam       BIT              NOT NULL DEFAULT 0,
    SpecialTeamType     NVARCHAR(20)     NULL,
        -- Values: committee, judges, NULL
    CreatedAt           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt           DATETIME2        NULL,

    CONSTRAINT FK_Teams_Events FOREIGN KEY (EventId) REFERENCES Events(Id),
    CONSTRAINT CK_Teams_SpecialType CHECK (SpecialTeamType IS NULL OR SpecialTeamType IN ('committee','judges'))
);

CREATE INDEX IX_Teams_EventId ON Teams(EventId);
```

---

## 7. Badges

```sql
CREATE TABLE Badges (
    Id          NVARCHAR(100)    NOT NULL PRIMARY KEY,
        -- Slug format: 'badge-community-champion' or GUID for custom badges
    Name        NVARCHAR(200)    NOT NULL,
    Description NVARCHAR(MAX)    NULL,
    Category    NVARCHAR(50)     NOT NULL DEFAULT 'soft',
        -- Values: soft, low-code, pro-code, sponsor
    ClaimType   NVARCHAR(50)     NULL,
        -- Values: NULL (normal), 'exclusive'
    ImageUrl    NVARCHAR(2000)   NULL,
    Points      INT              NOT NULL DEFAULT 0,
    CreatedAt   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt   DATETIME2        NULL,

    CONSTRAINT CK_Badges_Category CHECK (Category IN ('soft','low-code','pro-code','sponsor'))
);
```

---

## 8. AllowedEmails

```sql
CREATE TABLE AllowedEmails (
    Email           NVARCHAR(320)    NOT NULL PRIMARY KEY,
    IsActive        BIT              NOT NULL DEFAULT 1,
    AddedAt         DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    AddedByUserId   UNIQUEIDENTIFIER NULL
);
```

---

## 9. PendingRegistrations

```sql
CREATE TABLE PendingRegistrations (
    Id                  NVARCHAR(200)    NOT NULL PRIMARY KEY,
        -- Can be UUID or 'otp_email' format
    FirstName           NVARCHAR(100)    NULL,
    LastName            NVARCHAR(100)    NULL,
    Email               NVARCHAR(320)    NOT NULL,
    Phone               NVARCHAR(50)     NULL,
    TeamName            NVARCHAR(200)    NULL,
    NumberOfParticipants INT             NULL,
    VerificationCode    NVARCHAR(10)     NULL,
    ExpiresAt           DATETIME2        NULL,
    CreatedAt           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE INDEX IX_PendingRegistrations_Email ON PendingRegistrations(Email);
```

---

## 10. Participations

```sql
CREATE TABLE Participations (
    Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    UserId          UNIQUEIDENTIFIER NULL,
    Email           NVARCHAR(320)    NOT NULL,
    EventId         UNIQUEIDENTIFIER NOT NULL,
    Roles           NVARCHAR(200)    NULL,
        -- Comma-separated or JSON array: 'participant,interest' or '["participant","interest"]'
        -- Known values: participant, interest, committee, judge
    TeamId          UNIQUEIDENTIFIER NULL,
    IsTeamAdmin     BIT              NOT NULL DEFAULT 0,
    -- Hotel nights as individual columns (fixed possible set)
    HotelNight_MonTue BIT            NOT NULL DEFAULT 0,
    HotelNight_TueWed BIT            NOT NULL DEFAULT 0,
    HotelNight_WedThu BIT            NOT NULL DEFAULT 0,
    HotelNight_ThuFri BIT            NOT NULL DEFAULT 0,
    HotelNight_FriSat BIT            NOT NULL DEFAULT 0,
    HotelNight_SatSun BIT            NOT NULL DEFAULT 0,
    HotelNight_SunMon BIT            NOT NULL DEFAULT 0,
    HotelPaidBy     NVARCHAR(50)     NULL,
        -- Values: 'committee', NULL
    -- Conversion tracking (when interest lead becomes participant)
    ConvertedFrom   NVARCHAR(50)     NULL,
    ConvertedAt     DATETIME2        NULL,
    ConvertedVia    NVARCHAR(50)     NULL,
    InvitationId    UNIQUEIDENTIFIER NULL,
    CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt       DATETIME2        NULL,

    CONSTRAINT FK_Participations_Users FOREIGN KEY (UserId) REFERENCES Users(Id),
    CONSTRAINT FK_Participations_Events FOREIGN KEY (EventId) REFERENCES Events(Id)
);

CREATE INDEX IX_Participations_UserId ON Participations(UserId);
CREATE INDEX IX_Participations_EventId ON Participations(EventId);
CREATE INDEX IX_Participations_Email ON Participations(Email);
CREATE UNIQUE INDEX IX_Participations_UserEvent ON Participations(UserId, EventId) WHERE UserId IS NOT NULL;
```

---

## 11. Invitations

```sql
CREATE TABLE Invitations (
    Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    Email           NVARCHAR(320)    NOT NULL,
    InviteeFirstName NVARCHAR(100)   NULL,
    InviteeLastName  NVARCHAR(100)   NULL,
    TeamId          UNIQUEIDENTIFIER NULL,
        -- NULL for role-based invitations (judge/committee)
    TeamName        NVARCHAR(200)    NULL,
    EventId         UNIQUEIDENTIFIER NULL,
        -- Present for role-based invitations
    Role            NVARCHAR(50)     NULL,
        -- Values: 'judge', 'committee', NULL (team invitation)
    InviterId       UNIQUEIDENTIFIER NOT NULL,
    InviterName     NVARCHAR(200)    NULL,
    InviterEmail    NVARCHAR(320)    NULL,
    Message         NVARCHAR(MAX)    NULL,
    Status          NVARCHAR(20)     NOT NULL DEFAULT 'pending',
        -- Values: pending, accepted, declined, expired, cancelled
    CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    ExpiresAt       DATETIME2        NULL,
    AcceptedAt      DATETIME2        NULL,
    AcceptedBy      UNIQUEIDENTIFIER NULL,
    CancelledAt     DATETIME2        NULL,

    CONSTRAINT FK_Invitations_Events FOREIGN KEY (EventId) REFERENCES Events(Id),
    CONSTRAINT CK_Invitations_Status CHECK (Status IN ('pending','accepted','declined','expired','cancelled'))
);

CREATE INDEX IX_Invitations_Email ON Invitations(Email);
CREATE INDEX IX_Invitations_EventId ON Invitations(EventId);
CREATE INDEX IX_Invitations_TeamId ON Invitations(TeamId);
```

---

## 13. InterestLeads

```sql
CREATE TABLE InterestLeads (
    Id                UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    EventId           UNIQUEIDENTIFIER NOT NULL,
    Email             NVARCHAR(320)    NOT NULL,
    FirstName         NVARCHAR(100)    NOT NULL,
    LastName          NVARCHAR(100)    NOT NULL,
    VerificationCode  NVARCHAR(10)     NULL,
    CodeExpiresAt     DATETIME2        NULL,
    Verified          BIT              NOT NULL DEFAULT 0,
    VerifiedAt        DATETIME2        NULL,
    CreatedAt         DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt         DATETIME2        NULL,

    CONSTRAINT FK_InterestLeads_Events FOREIGN KEY (EventId) REFERENCES Events(Id)
);

CREATE INDEX IX_InterestLeads_EventId ON InterestLeads(EventId);
CREATE INDEX IX_InterestLeads_Email ON InterestLeads(Email);
```

---

## 14. EventBadges

```sql
CREATE TABLE EventBadges (
    Id          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    EventId     UNIQUEIDENTIFIER NOT NULL,
    BadgeId     NVARCHAR(100)    NOT NULL,
    JudgeUserId UNIQUEIDENTIFIER NULL,
    IsActive    BIT              NOT NULL DEFAULT 1,
    CreatedAt   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt   DATETIME2        NULL,

    CONSTRAINT FK_EventBadges_Events FOREIGN KEY (EventId) REFERENCES Events(Id),
    CONSTRAINT FK_EventBadges_Badges FOREIGN KEY (BadgeId) REFERENCES Badges(Id),
    CONSTRAINT UQ_EventBadges UNIQUE (EventId, BadgeId)
);
```

---

## 15. BadgeClaims

```sql
CREATE TABLE BadgeClaims (
    Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    EventBadgeId    UNIQUEIDENTIFIER NOT NULL,
    EventId         UNIQUEIDENTIFIER NOT NULL,
    BadgeId         NVARCHAR(100)    NOT NULL,
    TeamId          UNIQUEIDENTIFIER NULL,
    Status          NVARCHAR(20)     NOT NULL DEFAULT 'pending',
        -- Values: pending, approved, declined
    BlogUrl         NVARCHAR(2000)   NULL,
    Evidence        NVARCHAR(2000)   NULL,
    AssignedToUserId UNIQUEIDENTIFIER NULL,
    ClaimedBy       UNIQUEIDENTIFIER NULL,
    ClaimedAt       DATETIME2        NULL,
    DeclineReason   NVARCHAR(MAX)    NULL,
    ReviewedBy      UNIQUEIDENTIFIER NULL,
    ReviewedAt      DATETIME2        NULL,

    CONSTRAINT FK_BadgeClaims_EventBadges FOREIGN KEY (EventBadgeId) REFERENCES EventBadges(Id),
    CONSTRAINT FK_BadgeClaims_Events FOREIGN KEY (EventId) REFERENCES Events(Id),
    CONSTRAINT FK_BadgeClaims_Badges FOREIGN KEY (BadgeId) REFERENCES Badges(Id),
    CONSTRAINT CK_BadgeClaims_Status CHECK (Status IN ('pending','approved','declined'))
);

CREATE INDEX IX_BadgeClaims_EventId ON BadgeClaims(EventId);
CREATE INDEX IX_BadgeClaims_TeamId ON BadgeClaims(TeamId);
```

---

## 16. EmailCampaigns

```sql
CREATE TABLE EmailCampaigns (
    Id                UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    SequenceId        UNIQUEIDENTIFIER NULL,
    Subject           NVARCHAR(500)    NOT NULL,
    Content           NVARCHAR(MAX)    NULL,
        -- HTML email content, can be very large (embedded images)
    CtaUrl            NVARCHAR(2000)   NULL,
    CtaText           NVARCHAR(200)    NULL,
    Type              NVARCHAR(50)     NOT NULL DEFAULT 'sequence',
        -- Values: announcement, sequence
    SequenceOrder     INT              NULL,
    Status            NVARCHAR(50)     NOT NULL DEFAULT 'draft',
        -- Values: draft, live, paused
    ScheduledSendTime DATETIME2        NULL,
    CreatedAt         DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CreatedBy         UNIQUEIDENTIFIER NULL,
    UpdatedAt         DATETIME2        NULL,

    CONSTRAINT FK_EmailCampaigns_Sequences FOREIGN KEY (SequenceId) REFERENCES Sequences(Id)
);

CREATE INDEX IX_EmailCampaigns_SequenceId ON EmailCampaigns(SequenceId);
```

---

## 17. EmailDeliveries

```sql
CREATE TABLE EmailDeliveries (
    Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    CampaignId      NVARCHAR(MAX)    NOT NULL,
        -- Can be single GUID or comma-separated GUIDs for digest emails
    Email           NVARCHAR(320)    NOT NULL,
    LeadId          UNIQUEIDENTIFIER NULL,
    UserId          UNIQUEIDENTIFIER NULL,
    Status          NVARCHAR(20)     NOT NULL DEFAULT 'pending',
        -- Values: pending, sent, failed
    SentAt          DATETIME2        NULL,
    ErrorMessage    NVARCHAR(MAX)    NULL,
    DigestId        UNIQUEIDENTIFIER NULL,
        -- References another EmailDeliveries row (the digest parent)
    IsDigest        BIT              NOT NULL DEFAULT 0,
    DigestCount     INT              NULL,
    SentVia         NVARCHAR(50)     NULL,
        -- Values: 'digest', NULL
    ScheduledSend   BIT              NOT NULL DEFAULT 0,
    CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT CK_EmailDeliveries_Status CHECK (Status IN ('pending','sent','failed'))
);

CREATE INDEX IX_EmailDeliveries_Email ON EmailDeliveries(Email);
CREATE INDEX IX_EmailDeliveries_CampaignId ON EmailDeliveries(CampaignId(100));
    -- Note: If CampaignId is always a single GUID, consider UNIQUEIDENTIFIER instead
```

> **Note on EmailDeliveries.CampaignId:** In the current data, digest delivery rows store *multiple* comma-separated campaign IDs (e.g. `"id1,id2,id3"`). This is denormalized. A future improvement could create a `EmailDeliveryCampaigns` junction table. For now, NVARCHAR preserves the existing behavior.

---

## 18. EmailLog

```sql
CREATE TABLE EmailLog (
    Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    TemplateId      NVARCHAR(100)    NULL,
        -- e.g. 'announcement', 'team-welcome', etc.
    Subject         NVARCHAR(500)    NULL,
    RecipientCount  INT              NOT NULL DEFAULT 0,
    SentAt          DATETIME2        NULL,
    ResultsSent     INT              NOT NULL DEFAULT 0,
    ResultsFailed   INT              NOT NULL DEFAULT 0,
    ResultsErrors   NVARCHAR(MAX)    NULL,
        -- JSON array of error objects
    Status          NVARCHAR(50)     NOT NULL DEFAULT 'pending',
        -- Values: pending, completed, failed
    Source          NVARCHAR(50)     NULL,
        -- Values: 'sequence', 'manual', etc.
    CampaignId      UNIQUEIDENTIFIER NULL,
    CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
```

---

## 19. ScheduledRuns

```sql
CREATE TABLE ScheduledRuns (
    Id                  UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    StartTime           DATETIME2        NOT NULL,
    EndTime             DATETIME2        NULL,
    Duration            DECIMAL(10,3)    NULL,
        -- Duration in seconds
    EmailsSent          INT              NOT NULL DEFAULT 0,
    EmailsFailed        INT              NOT NULL DEFAULT 0,
    CampaignsProcessed  INT              NOT NULL DEFAULT 0,
    Error               NVARCHAR(MAX)    NULL,
    Status              NVARCHAR(50)     NOT NULL DEFAULT 'running',
        -- Values: running, success, failed
    CreatedAt           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
```

---

## 20. ScheduledRunCampaigns

```sql
CREATE TABLE ScheduledRunCampaigns (
    Id              INT              IDENTITY(1,1) NOT NULL PRIMARY KEY,
    ScheduledRunId  UNIQUEIDENTIFIER NOT NULL,
    CampaignId      UNIQUEIDENTIFIER NOT NULL,
    Subject         NVARCHAR(500)    NULL,
    Recipients      INT              NOT NULL DEFAULT 0,

    CONSTRAINT FK_ScheduledRunCampaigns_Runs FOREIGN KEY (ScheduledRunId) REFERENCES ScheduledRuns(Id) ON DELETE CASCADE
);
```

---

## 21. SystemEmailConfig

> **Note:** SequenceProgress table was removed — the code never writes to or reads from `sequence-progress.json`. It was a dead remnant from an earlier design.

```sql
CREATE TABLE SystemEmailConfig (
    TemplateKey     NVARCHAR(100)    NOT NULL PRIMARY KEY,
        -- e.g. 'invitation-judge', 'team-welcome', 'interest-acknowledgment'
    Name            NVARCHAR(200)    NOT NULL,
    Subject         NVARCHAR(500)    NOT NULL,
    MergeFields     NVARCHAR(MAX)    NULL,
        -- JSON array, e.g. '["firstName","eventName","acceptUrl"]'
    EditableSections NVARCHAR(MAX)   NULL,
        -- JSON object with HTML sections
    EventThemes     NVARCHAR(MAX)    NULL,
        -- JSON object keyed by eventId with theme-specific overrides
    UpdatedAt       DATETIME2        NULL
);
```

---

## 23. InterestQueue

```sql
CREATE TABLE InterestQueue (
    Id          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    EventId     UNIQUEIDENTIFIER NULL,
    Email       NVARCHAR(320)    NULL,
    Data        NVARCHAR(MAX)    NULL,
        -- Full JSON payload for flexible queue entries
    Status      NVARCHAR(50)     NOT NULL DEFAULT 'pending',
    CreatedAt   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
```

---

## 24. SoloQueue

```sql
CREATE TABLE SoloQueue (
    Id          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    EventId     UNIQUEIDENTIFIER NULL,
    Email       NVARCHAR(320)    NULL,
    Data        NVARCHAR(MAX)    NULL,
        -- Full JSON payload for flexible queue entries
    Status      NVARCHAR(50)     NOT NULL DEFAULT 'pending',
    CreatedAt   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
```

---

## Full Script (All Tables Combined)

To run the entire schema creation as one script, concatenate all CREATE TABLE statements above in the listed order. The script is idempotent-safe if wrapped with `IF NOT EXISTS` checks:

```sql
-- Wrap each table creation like this for safety:
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Events')
BEGIN
    CREATE TABLE Events ( ... );
END
```

---

## Index Summary

| Table | Index | Columns | Type |
|-------|-------|---------|------|
| Users | IX_Users_Email | Email | Nonclustered |
| Teams | IX_Teams_EventId | EventId | Nonclustered |
| Participations | IX_Participations_UserId | UserId | Nonclustered |
| Participations | IX_Participations_EventId | EventId | Nonclustered |
| Participations | IX_Participations_Email | Email | Nonclustered |
| Participations | IX_Participations_UserEvent | UserId, EventId | Unique (filtered) |
| Invitations | IX_Invitations_Email | Email | Nonclustered |
| Invitations | IX_Invitations_EventId | EventId | Nonclustered |
| Invitations | IX_Invitations_TeamId | TeamId | Nonclustered |
| InterestLeads | IX_InterestLeads_EventId | EventId | Nonclustered |
| InterestLeads | IX_InterestLeads_Email | Email | Nonclustered |
| EmailCampaigns | IX_EmailCampaigns_SequenceId | SequenceId | Nonclustered |
| EmailDeliveries | IX_EmailDeliveries_Email | Email | Nonclustered |

| BadgeClaims | IX_BadgeClaims_EventId | EventId | Nonclustered |
| BadgeClaims | IX_BadgeClaims_TeamId | TeamId | Nonclustered |
