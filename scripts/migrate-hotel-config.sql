-- Migration: Add hotel configuration fields
-- Events: HotelEnabled, HotelMandatory
-- Participations: ProfileVerification (originally added as HotelAcknowledged, renamed — see migrate-rename-profileverification.sql)

ALTER TABLE [Events]
    ADD [HotelEnabled]  BIT NOT NULL DEFAULT 0;

ALTER TABLE [Events]
    ADD [HotelMandatory] BIT NOT NULL DEFAULT 0;

ALTER TABLE [Participations]
    ADD [HotelAcknowledged] BIT NOT NULL DEFAULT 0;
