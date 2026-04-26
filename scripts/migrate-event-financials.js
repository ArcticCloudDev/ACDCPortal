// Migration: Add EventFinancials table + rate columns on Events
// Run: node scripts/migrate-event-financials.js

const sql = require('mssql');

async function getToken() {
    const { execSync } = require('child_process');
    const token = execSync(
        'az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv',
        { encoding: 'utf8' }
    ).trim();
    if (!token) throw new Error('Failed to acquire Azure SQL access token via az CLI');
    return token;
}

async function run() {
    const token = process.env.SQL_ACCESS_TOKEN || await getToken();

    const config = {
        server: 'acdc-portal-db.database.windows.net',
        database: 'acdc-portal-db',
        options: { encrypt: true, trustServerCertificate: false },
        authentication: {
            type: 'azure-active-directory-access-token',
            options: { token }
        },
        connectionTimeout: 30000,
        requestTimeout: 30000
    };

    const pool = await sql.connect(config);

    try {
        // 1. Add rate columns to Events (idempotent)
        console.log('Adding rate columns to Events...');
        await pool.request().query(`
            IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Events' AND COLUMN_NAME = 'HotelRatePerNight')
                ALTER TABLE Events ADD HotelRatePerNight DECIMAL(12,2) NULL;
            IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Events' AND COLUMN_NAME = 'FoodRatePerDay')
                ALTER TABLE Events ADD FoodRatePerDay DECIMAL(12,2) NULL;
            IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Events' AND COLUMN_NAME = 'FoodDays')
                ALTER TABLE Events ADD FoodDays INT NULL;
        `);
        console.log('  Done.');

        // 2. Create EventFinancials table (idempotent)
        console.log('Creating EventFinancials table...');
        await pool.request().query(`
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
                    CONSTRAINT CK_EventFinancials_Type CHECK (Type IN ('income', 'expense')),
                    CONSTRAINT CK_EventFinancials_PaidBy CHECK (PaidBy IN ('participant', 'event')),
                    CONSTRAINT CK_EventFinancials_Source CHECK (Source IN ('manual', 'auto'))
                );
                CREATE INDEX IX_EventFinancials_EventId ON EventFinancials(EventId);
                CREATE INDEX IX_EventFinancials_ParticipationId ON EventFinancials(ParticipationId);
                CREATE INDEX IX_EventFinancials_SponsorId ON EventFinancials(SponsorId);
                PRINT 'EventFinancials table created.';
            END
            ELSE
                PRINT 'EventFinancials table already exists.';
        `);
        console.log('  Done.');

        // 3. Verify
        const tables = await pool.request().query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_NAME IN ('EventFinancials')
        `);
        const cols = await pool.request().query(`
            SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = 'Events'
              AND COLUMN_NAME IN ('HotelRatePerNight', 'FoodRatePerDay', 'FoodDays')
            ORDER BY COLUMN_NAME
        `);
        console.log('\nVerification:');
        console.log('  Tables:', tables.recordset.map(r => r.TABLE_NAME).join(', '));
        console.log('  New Events columns:', cols.recordset.map(r => `${r.COLUMN_NAME}(${r.DATA_TYPE})`).join(', '));
        console.log('\nMigration complete.');
    } finally {
        await pool.close();
    }
}

run().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
