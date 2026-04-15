-- Rename HotelAcknowledged -> ProfileVerification
-- More generic: used to verify that profile data is correct, not just hotel-specific
EXEC sp_rename 'Participations.HotelAcknowledged', 'ProfileVerification', 'COLUMN';
