-- ACDC Portal - Create All Tables
-- Target: acdc-portal-db.database.windows.net / acdc-portal-db
-- Execute in dependency order (parent tables first)

-- 1. Events
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Events')
CREATE TABLE Events (
    Id                          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    Name                        NVARCHAR(200)    NOT NULL,
    Description                 NVARCHAR(MAX)    NULL,
    StartDate                   DATE             NOT NULL,
    EndDate                     DATE             NOT NULL,
    Location                    NVARCHAR(500)    NULL,
    Status                      NVARCHAR(50)     NOT NULL DEFAULT 'draft',
    RegistrationType            NVARCHAR(20)     NOT NULL DEFAULT 'team',
    RegistrationOpen            BIT              NOT NULL DEFAULT 0,
    IsActive                    BIT              NOT NULL DEFAULT 0,
    MinTeamSize                 INT              NULL DEFAULT 3,
    MaxTeamSize                 INT              NULL DEFAULT 5,
    SequenceId                  UNIQUEIDENTIFIER NULL,
    SequenceEnabled             BIT              NOT NULL DEFAULT 0,
    CommitteeTeamId             UNIQUEIDENTIFIER NULL,
    JudgesTeamId                UNIQUEIDENTIFIER NULL,
    FileCategories              NVARCHAR(MAX)    NULL,
    SendWelcomeEmail            BIT              NOT NULL DEFAULT 1,
    SendInterestAcknowledgment  BIT              NOT NULL DEFAULT 1,
    SendJudgeInvitationEmail    BIT              NOT NULL DEFAULT 1,
    SendCommitteeInvitationEmail BIT             NOT NULL DEFAULT 1,
    SendTeamRegistrationEmail   BIT              NOT NULL DEFAULT 1,
    TeamWelcomeEmailId          UNIQUEIDENTIFIER NULL,
    SharepointUrl               NVARCHAR(2000)   NULL,
    CostPerParticipant          DECIMAL(10,2)    NULL,
    Currency                    NVARCHAR(10)     NULL DEFAULT 'NOK',
    HotelRatePerNight           DECIMAL(12,2)    NULL,
    FoodRatePerDay              DECIMAL(12,2)    NULL,
    FoodDays                    INT              NULL,
    TeamRegistrationTerms       NVARCHAR(MAX)    NULL,
    SoloQueueTerms              NVARCHAR(MAX)    NULL,
    SingleRegistrationTerms     NVARCHAR(MAX)    NULL,
    CreatedAt                   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt                   DATETIME2        NULL,
    CONSTRAINT CK_Events_Status CHECK (Status IN ('draft','pre-registration','registration','live','completed')),
    CONSTRAINT CK_Events_RegType CHECK (RegistrationType IN ('team','single','solo'))
);
GO

-- 2. EventHotelDates
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'EventHotelDates')
CREATE TABLE EventHotelDates (
    Id          INT              IDENTITY(1,1) NOT NULL PRIMARY KEY,
    EventId     UNIQUEIDENTIFIER NOT NULL,
    HotelDate   DATE             NOT NULL,
    DayLabel    NVARCHAR(10)     NOT NULL,
    DayLabelFull NVARCHAR(20)    NOT NULL,
    CONSTRAINT FK_EventHotelDates_Events FOREIGN KEY (EventId) REFERENCES Events(Id) ON DELETE CASCADE,
    CONSTRAINT UQ_EventHotelDates UNIQUE (EventId, HotelDate)
);
GO

-- 3. EventDefaultNights
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'EventDefaultNights')
CREATE TABLE EventDefaultNights (
    Id          INT              IDENTITY(1,1) NOT NULL PRIMARY KEY,
    EventId     UNIQUEIDENTIFIER NOT NULL,
    NightLabel  NVARCHAR(20)     NOT NULL,
    CONSTRAINT FK_EventDefaultNights_Events FOREIGN KEY (EventId) REFERENCES Events(Id) ON DELETE CASCADE,
    CONSTRAINT UQ_EventDefaultNights UNIQUE (EventId, NightLabel)
);
GO

-- 4. Sequences
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Sequences')
CREATE TABLE Sequences (
    Id          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    Name        NVARCHAR(200)    NOT NULL,
    Description NVARCHAR(MAX)    NULL,
    CreatedAt   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt   DATETIME2        NULL
);
GO

-- 5. Users
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Users')
BEGIN
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
        CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt       DATETIME2        NULL,
        CONSTRAINT UQ_Users_Email UNIQUE (Email)
    );
    CREATE INDEX IX_Users_Email ON Users(Email);
END
GO

-- 6. Teams
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Teams')
BEGIN
    CREATE TABLE Teams (
        Id                  UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        TeamName            NVARCHAR(200)    NOT NULL,
        EventId             UNIQUEIDENTIFIER NOT NULL,
        NumberOfParticipants INT             NULL,
        AdminUserId         UNIQUEIDENTIFIER NULL,
        IsSpecialTeam       BIT              NOT NULL DEFAULT 0,
        SpecialTeamType     NVARCHAR(20)     NULL,
        CreatedAt           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt           DATETIME2        NULL,
        CONSTRAINT FK_Teams_Events FOREIGN KEY (EventId) REFERENCES Events(Id),
        CONSTRAINT CK_Teams_SpecialType CHECK (SpecialTeamType IS NULL OR SpecialTeamType IN ('committee','judges'))
    );
    CREATE INDEX IX_Teams_EventId ON Teams(EventId);
END
GO

-- 7. Badges
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Badges')
CREATE TABLE Badges (
    Id          NVARCHAR(100)    NOT NULL PRIMARY KEY,
    Name        NVARCHAR(200)    NOT NULL,
    Description NVARCHAR(MAX)    NULL,
    Category    NVARCHAR(50)     NOT NULL DEFAULT 'soft',
    ClaimType   NVARCHAR(50)     NULL,
    ImageUrl    NVARCHAR(2000)   NULL,
    Points      INT              NOT NULL DEFAULT 0,
    CreatedAt   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt   DATETIME2        NULL,
    CONSTRAINT CK_Badges_Category CHECK (Category IN ('soft','low-code','pro-code','sponsor'))
);
GO

-- 8. AllowedEmails
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'AllowedEmails')
CREATE TABLE AllowedEmails (
    Email           NVARCHAR(320)    NOT NULL PRIMARY KEY,
    IsActive        BIT              NOT NULL DEFAULT 1,
    AddedAt         DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    AddedByUserId   UNIQUEIDENTIFIER NULL
);
GO

-- 9. PendingRegistrations
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'PendingRegistrations')
BEGIN
    CREATE TABLE PendingRegistrations (
        Id                  NVARCHAR(200)    NOT NULL PRIMARY KEY,
        FirstName           NVARCHAR(100)    NULL,
        LastName            NVARCHAR(100)    NULL,
        Email               NVARCHAR(320)    NOT NULL,
        Phone               NVARCHAR(50)     NULL,
        TeamName            NVARCHAR(200)    NULL,
        NumberOfParticipants INT             NULL,
        VerificationCode    NVARCHAR(10)     NULL,
        CodeHash            NVARCHAR(200)    NULL,
        Attempts            INT              NULL DEFAULT 0,
        MaxAttempts         INT              NULL DEFAULT 5,
        Type                NVARCHAR(50)     NULL,
        WillParticipate     BIT              NULL,
        EventId             UNIQUEIDENTIFIER NULL,
        ExpiresAt           DATETIME2        NULL,
        CreatedAt           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
    );
    CREATE INDEX IX_PendingRegistrations_Email ON PendingRegistrations(Email);
END
GO

-- 10. Participations
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Participations')
BEGIN
    CREATE TABLE Participations (
        Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        UserId          UNIQUEIDENTIFIER NULL,
        Email           NVARCHAR(320)    NOT NULL,
        EventId         UNIQUEIDENTIFIER NOT NULL,
        Roles           NVARCHAR(200)    NULL,
        TeamId          UNIQUEIDENTIFIER NULL,
        IsTeamAdmin     BIT              NOT NULL DEFAULT 0,
        HotelNight_MonTue BIT            NOT NULL DEFAULT 0,
        HotelNight_TueWed BIT            NOT NULL DEFAULT 0,
        HotelNight_WedThu BIT            NOT NULL DEFAULT 0,
        HotelNight_ThuFri BIT            NOT NULL DEFAULT 0,
        HotelNight_FriSat BIT            NOT NULL DEFAULT 0,
        HotelNight_SatSun BIT            NOT NULL DEFAULT 0,
        HotelNight_SunMon BIT            NOT NULL DEFAULT 0,
        HotelPaidBy     NVARCHAR(50)     NULL,
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
END
GO

-- 11. Invitations
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Invitations')
BEGIN
    CREATE TABLE Invitations (
        Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        Email           NVARCHAR(320)    NOT NULL,
        InviteeFirstName NVARCHAR(100)   NULL,
        InviteeLastName  NVARCHAR(100)   NULL,
        TeamId          UNIQUEIDENTIFIER NULL,
        TeamName        NVARCHAR(200)    NULL,
        EventId         UNIQUEIDENTIFIER NULL,
        Role            NVARCHAR(50)     NULL,
        InviterId       UNIQUEIDENTIFIER NOT NULL,
        InviterName     NVARCHAR(200)    NULL,
        InviterEmail    NVARCHAR(320)    NULL,
        Message         NVARCHAR(MAX)    NULL,
        Status          NVARCHAR(20)     NOT NULL DEFAULT 'pending',
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
END
GO

-- 13. InterestLeads
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'InterestLeads')
BEGIN
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
END
GO

-- 14. EventBadges
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'EventBadges')
BEGIN
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
END
GO

-- 15. BadgeClaims
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'BadgeClaims')
BEGIN
    CREATE TABLE BadgeClaims (
        Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        EventBadgeId    UNIQUEIDENTIFIER NOT NULL,
        EventId         UNIQUEIDENTIFIER NOT NULL,
        BadgeId         NVARCHAR(100)    NOT NULL,
        TeamId          UNIQUEIDENTIFIER NULL,
        Status          NVARCHAR(20)     NOT NULL DEFAULT 'pending',
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
        CONSTRAINT CK_BadgeClaims_Status CHECK (Status IN ('draft','pending','approved','declined'))
    );
    CREATE INDEX IX_BadgeClaims_EventId ON BadgeClaims(EventId);
    CREATE INDEX IX_BadgeClaims_TeamId ON BadgeClaims(TeamId);
END
GO

-- 16. EmailCampaigns
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'EmailCampaigns')
BEGIN
    CREATE TABLE EmailCampaigns (
        Id                UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        SequenceId        UNIQUEIDENTIFIER NULL,
        Subject           NVARCHAR(500)    NOT NULL,
        Content           NVARCHAR(MAX)    NULL,
        CtaUrl            NVARCHAR(2000)   NULL,
        CtaText           NVARCHAR(200)    NULL,
        Type              NVARCHAR(50)     NOT NULL DEFAULT 'sequence',
        SequenceOrder     INT              NULL,
        Status            NVARCHAR(50)     NOT NULL DEFAULT 'draft',
        ScheduledSendTime DATETIME2        NULL,
        CreatedAt         DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CreatedBy         UNIQUEIDENTIFIER NULL,
        UpdatedAt         DATETIME2        NULL,
        CONSTRAINT FK_EmailCampaigns_Sequences FOREIGN KEY (SequenceId) REFERENCES Sequences(Id)
    );
    CREATE INDEX IX_EmailCampaigns_SequenceId ON EmailCampaigns(SequenceId);
END
GO

-- 17. EmailDeliveries
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'EmailDeliveries')
BEGIN
    CREATE TABLE EmailDeliveries (
        Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        CampaignId      NVARCHAR(900)    NOT NULL,
        Email           NVARCHAR(320)    NOT NULL,
        LeadId          UNIQUEIDENTIFIER NULL,
        UserId          UNIQUEIDENTIFIER NULL,
        Status          NVARCHAR(20)     NOT NULL DEFAULT 'pending',
        SentAt          DATETIME2        NULL,
        ErrorMessage    NVARCHAR(MAX)    NULL,
        DigestId        UNIQUEIDENTIFIER NULL,
        IsDigest        BIT              NOT NULL DEFAULT 0,
        DigestCount     INT              NULL,
        SentVia         NVARCHAR(50)     NULL,
        ScheduledSend   BIT              NOT NULL DEFAULT 0,
        CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_EmailDeliveries_Status CHECK (Status IN ('pending','sent','failed'))
    );
    CREATE INDEX IX_EmailDeliveries_Email ON EmailDeliveries(Email);
    CREATE INDEX IX_EmailDeliveries_CampaignId ON EmailDeliveries(CampaignId);
END
GO

-- 18. EmailLog
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'EmailLog')
CREATE TABLE EmailLog (
    Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    TemplateId      NVARCHAR(100)    NULL,
    Subject         NVARCHAR(500)    NULL,
    RecipientCount  INT              NOT NULL DEFAULT 0,
    SentAt          DATETIME2        NULL,
    ResultsSent     INT              NOT NULL DEFAULT 0,
    ResultsFailed   INT              NOT NULL DEFAULT 0,
    ResultsErrors   NVARCHAR(MAX)    NULL,
    Status          NVARCHAR(50)     NOT NULL DEFAULT 'pending',
    Source          NVARCHAR(50)     NULL,
    CampaignId      UNIQUEIDENTIFIER NULL,
    CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- 19. ScheduledRuns
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'ScheduledRuns')
CREATE TABLE ScheduledRuns (
    Id                  UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    StartTime           DATETIME2        NOT NULL,
    EndTime             DATETIME2        NULL,
    Duration            DECIMAL(10,3)    NULL,
    EmailsSent          INT              NOT NULL DEFAULT 0,
    EmailsFailed        INT              NOT NULL DEFAULT 0,
    CampaignsProcessed  INT              NOT NULL DEFAULT 0,
    Error               NVARCHAR(MAX)    NULL,
    Status              NVARCHAR(50)     NOT NULL DEFAULT 'running',
    CreatedAt           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- 20. ScheduledRunCampaigns
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'ScheduledRunCampaigns')
CREATE TABLE ScheduledRunCampaigns (
    Id              INT              IDENTITY(1,1) NOT NULL PRIMARY KEY,
    ScheduledRunId  UNIQUEIDENTIFIER NOT NULL,
    CampaignId      UNIQUEIDENTIFIER NOT NULL,
    Subject         NVARCHAR(500)    NULL,
    Recipients      INT              NOT NULL DEFAULT 0,
    CONSTRAINT FK_ScheduledRunCampaigns_Runs FOREIGN KEY (ScheduledRunId) REFERENCES ScheduledRuns(Id) ON DELETE CASCADE
);
GO

-- 21. SystemEmailConfig
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SystemEmailConfig')
CREATE TABLE SystemEmailConfig (
    TemplateKey     NVARCHAR(100)    NOT NULL PRIMARY KEY,
    Name            NVARCHAR(200)    NOT NULL,
    Subject         NVARCHAR(500)    NOT NULL,
    MergeFields     NVARCHAR(MAX)    NULL,
    EditableSections NVARCHAR(MAX)   NULL,
    EventThemes     NVARCHAR(MAX)    NULL,
    StructuralConfig NVARCHAR(MAX)   NULL,
    UpdatedAt       DATETIME2        NULL
);
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'SystemEmailConfig' AND COLUMN_NAME = 'StructuralConfig')
    ALTER TABLE SystemEmailConfig ADD StructuralConfig NVARCHAR(MAX) NULL;
GO

-- 22. InterestQueue
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'InterestQueue')
CREATE TABLE InterestQueue (
    Id          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    EventId     UNIQUEIDENTIFIER NULL,
    Email       NVARCHAR(320)    NULL,
    Data        NVARCHAR(MAX)    NULL,
    Status      NVARCHAR(50)     NOT NULL DEFAULT 'pending',
    CreatedAt   DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- 23. SoloQueue
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SoloQueue')
CREATE TABLE SoloQueue (
    Id        UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    UserId    UNIQUEIDENTIFIER NOT NULL,
    EventId   UNIQUEIDENTIFIER NOT NULL,
    Note      NVARCHAR(500)    NULL,
    Status    NVARCHAR(20)     NOT NULL DEFAULT 'waiting',
    JoinedAt  DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- 24. Errors (centralised error log)
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Errors')
CREATE TABLE [Errors] (
    [Id]           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    [OccurredAt]   DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
    [FunctionName] NVARCHAR(100)    NOT NULL,
    [ErrorMessage] NVARCHAR(MAX)    NOT NULL,
    [StackTrace]   NVARCHAR(MAX)    NULL,
    [Details]      NVARCHAR(MAX)    NULL,
    [Severity]     NVARCHAR(20)     NOT NULL DEFAULT 'error',
    CONSTRAINT [PK_Errors] PRIMARY KEY ([Id])
);
GO

-- 25. EventSponsors
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'EventSponsors')
BEGIN
    CREATE TABLE EventSponsors (
        Id            UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        EventId       UNIQUEIDENTIFIER NOT NULL,
        CompanyName   NVARCHAR(200)    NOT NULL,
        ContactPerson NVARCHAR(200)    NULL,
        PhoneNumber   NVARCHAR(50)     NULL,
        Email         NVARCHAR(320)    NULL,
        Amount        DECIMAL(12,2)    NULL,
        Status        NVARCHAR(30)     NOT NULL DEFAULT 'reached-out',
        Notes         NVARCHAR(MAX)    NULL,
        CreatedAt     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt     DATETIME2        NULL,
        CONSTRAINT FK_EventSponsors_Events FOREIGN KEY (EventId) REFERENCES Events(Id) ON DELETE CASCADE,
        CONSTRAINT CK_EventSponsors_Status CHECK (Status IN ('reached-out', 'negotiating', 'declined', 'confirmed'))
    );
    CREATE INDEX IX_EventSponsors_EventId ON EventSponsors(EventId);
    CREATE INDEX IX_EventSponsors_Status ON EventSponsors(Status);
END
GO

-- 26. EventFinancials
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'EventFinancials')
BEGIN
    CREATE TABLE EventFinancials (
        Id              UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
        EventId         UNIQUEIDENTIFIER NOT NULL,
        ParticipationId UNIQUEIDENTIFIER NULL,
        SponsorId       UNIQUEIDENTIFIER NULL,
        Type            NVARCHAR(10)     NOT NULL,
        Category        NVARCHAR(30)     NOT NULL,
        Description     NVARCHAR(200)    NOT NULL,
        UnitCost        DECIMAL(12,2)    NULL,
        Days            INT              NULL,
        Amount          DECIMAL(12,2)    NOT NULL,
        PaidBy          NVARCHAR(20)     NOT NULL DEFAULT 'event',
        Source          NVARCHAR(10)     NOT NULL DEFAULT 'manual',
        Notes           NVARCHAR(MAX)    NULL,
        CreatedAt       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt       DATETIME2        NULL,
        CONSTRAINT FK_EventFinancials_Events FOREIGN KEY (EventId) REFERENCES Events(Id) ON DELETE CASCADE,
        CONSTRAINT CK_EventFinancials_Type CHECK (Type IN ('income','expense')),
        CONSTRAINT CK_EventFinancials_PaidBy CHECK (PaidBy IN ('participant','event')),
        CONSTRAINT CK_EventFinancials_Source CHECK (Source IN ('manual','auto'))
    );
    CREATE INDEX IX_EventFinancials_EventId ON EventFinancials(EventId);
    CREATE INDEX IX_EventFinancials_ParticipationId ON EventFinancials(ParticipationId);
    CREATE INDEX IX_EventFinancials_SponsorId ON EventFinancials(SponsorId);
END
GO

PRINT '=== All 26 tables created successfully ===';
SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME;
