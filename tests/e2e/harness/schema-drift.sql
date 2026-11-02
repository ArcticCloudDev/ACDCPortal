-- Columns production has but scripts/create-tables.sql does not.
-- Reconstructed from one-time migrations that were applied to production and later
-- deleted from the repo (see the commit for each). Applied after create-tables.sql.
--
-- Deliberately NOT added, because no migration, doc or DDL ever created them; the code
-- writing them is treated as a bug the E2E suite should surface:
--   Teams.CommittedParticipants / PresentationFile / DeliveryVideo  (teams.js PUT allowedFields)
--   Events.HotelNights                                              (admin-events.js saveEventRates)
--   EmailCampaigns.Stats                                            (sequences.js copy)
--   InterestQueue.FirstName/LastName/Phone/Company/Source/...      (interest-queue.js)
--   Participations.InterestVerified/InterestDate/InterestSource    (interest.js, participations.js)

-- 9d27302 scripts/migrate-hotel-config.sql
IF COL_LENGTH('Events', 'HotelEnabled') IS NULL
    ALTER TABLE [Events] ADD [HotelEnabled] BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('Events', 'HotelMandatory') IS NULL
    ALTER TABLE [Events] ADD [HotelMandatory] BIT NOT NULL DEFAULT 0;
GO

-- 9d27302 added HotelAcknowledged; 3d1601f renamed it (scripts/migrate-rename-profileverification.sql)
IF COL_LENGTH('Participations', 'ProfileVerification') IS NULL
    ALTER TABLE [Participations] ADD [ProfileVerification] BIT NOT NULL DEFAULT 0;
GO

-- 1df2078 scripts/migrate-hotel-days.sql
IF COL_LENGTH('Events', 'HotelDaysBefore') IS NULL
    ALTER TABLE [Events] ADD [HotelDaysBefore] INT NOT NULL DEFAULT 1;
IF COL_LENGTH('Events', 'HotelDaysAfter') IS NULL
    ALTER TABLE [Events] ADD [HotelDaysAfter] INT NOT NULL DEFAULT 1;
GO

-- 4763a8d docs/SQL_CREATE_TABLES.md
IF COL_LENGTH('Events', 'EventImage') IS NULL
    ALTER TABLE [Events] ADD [EventImage] NVARCHAR(2000) NULL;
IF COL_LENGTH('Events', 'EventImageData') IS NULL
    ALTER TABLE [Events] ADD [EventImageData] NVARCHAR(MAX) NULL;
GO

-- 7a87b73 scripts/migrate-add-invitation-pending.js
IF COL_LENGTH('Users', 'InvitationPending') IS NULL
    ALTER TABLE [Users] ADD [InvitationPending] BIT NOT NULL CONSTRAINT DF_Users_InvitationPending DEFAULT 0;
GO

-- 4dda226 scripts/migrate-add-invitation-contact-details.js
IF COL_LENGTH('Invitations', 'InviteePhone') IS NULL
    ALTER TABLE [Invitations] ADD [InviteePhone] NVARCHAR(50) NULL;
IF COL_LENGTH('Invitations', 'InviteeGamertag') IS NULL
    ALTER TABLE [Invitations] ADD [InviteeGamertag] NVARCHAR(100) NULL;
IF COL_LENGTH('Invitations', 'InviteeAllergies') IS NULL
    ALTER TABLE [Invitations] ADD [InviteeAllergies] NVARCHAR(MAX) NULL;
GO

-- Sponsor fields from the code's own DDL (api/src/shared/event-financials.js ensureTable)
IF COL_LENGTH('EventFinancials', 'ContactPerson') IS NULL
    ALTER TABLE [EventFinancials] ADD [ContactPerson] NVARCHAR(200) NULL;
IF COL_LENGTH('EventFinancials', 'PhoneNumber') IS NULL
    ALTER TABLE [EventFinancials] ADD [PhoneNumber] NVARCHAR(50) NULL;
IF COL_LENGTH('EventFinancials', 'ContactEmail') IS NULL
    ALTER TABLE [EventFinancials] ADD [ContactEmail] NVARCHAR(320) NULL;
IF COL_LENGTH('EventFinancials', 'SponsorStatus') IS NULL
    ALTER TABLE [EventFinancials] ADD [SponsorStatus] NVARCHAR(30) NULL
        CONSTRAINT CK_EventFinancials_SponsorStatus CHECK (SponsorStatus IN ('reached-out','negotiating','declined','confirmed'));
GO
