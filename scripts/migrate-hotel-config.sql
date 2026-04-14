-- Migration: Add hotel configuration fields
-- Events: HotelEnabled, HotelMandatory
-- Participations: HotelAcknowledged

ALTER TABLE [Events]
    ADD [HotelEnabled]  BIT NOT NULL DEFAULT 0;

ALTER TABLE [Events]
    ADD [HotelMandatory] BIT NOT NULL DEFAULT 0;

ALTER TABLE [Participations]
    ADD [HotelAcknowledged] BIT NOT NULL DEFAULT 0;
