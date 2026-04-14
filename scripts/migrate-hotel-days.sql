-- Add configurable hotel booking window to Events
-- HotelDaysBefore: how many nights before event start are available to book (default 1)
-- HotelDaysAfter:  how many nights after event end are available to book (default 1)

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('Events') AND name = 'HotelDaysBefore')
    ALTER TABLE [Events] ADD [HotelDaysBefore] INT NOT NULL DEFAULT 1;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('Events') AND name = 'HotelDaysAfter')
    ALTER TABLE [Events] ADD [HotelDaysAfter] INT NOT NULL DEFAULT 1;
