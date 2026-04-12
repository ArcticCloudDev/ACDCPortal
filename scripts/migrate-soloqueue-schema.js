/**
 * Migration: Rebuild SoloQueue table with correct schema.
 *
 * Old schema: Id, EventId, Email, Data, Status, CreatedAt
 * New schema: Id, UserId, EventId, Note, Status, JoinedAt
 *
 * Run from the api/ directory:
 *   cd api && node ../scripts/migrate-soloqueue-schema.js
 */

'use strict';

const { DefaultAzureCredential } = require('@azure/identity');
const { Connection, Request, TYPES } = require('tedious');

const SERVER   = 'acdc-portal-db.database.windows.net';
const DATABASE = 'acdc-portal-db';

async function getToken() {
  const cred = new DefaultAzureCredential();
  const result = await cred.getToken('https://database.windows.net/');
  return result.token;
}

async function run() {
  const token = await getToken();

  const config = {
    server: SERVER,
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    options: { database: DATABASE, encrypt: true, trustServerCertificate: false },
  };

  await new Promise((resolve, reject) => {
    const conn = new Connection(config);

    conn.on('connect', err => {
      if (err) return reject(err);

      const sql = `
        -- Drop old table (no FK constraints reference it)
        IF OBJECT_ID('dbo.SoloQueue', 'U') IS NOT NULL
            DROP TABLE dbo.SoloQueue;

        -- Recreate with correct schema
        CREATE TABLE dbo.SoloQueue (
            Id        UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
            UserId    UNIQUEIDENTIFIER NOT NULL,
            EventId   UNIQUEIDENTIFIER NOT NULL,
            Note      NVARCHAR(500)    NULL,
            Status    NVARCHAR(20)     NOT NULL DEFAULT 'waiting',
            JoinedAt  DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
        );
      `;

      const req = new Request(sql, (err2) => {
        if (err2) {
          console.error('Migration failed:', err2.message);
          conn.close();
          return reject(err2);
        }
        console.log('SoloQueue table recreated successfully.');
        conn.close();
        resolve();
      });

      conn.execSql(req);
    });

    conn.on('error', reject);
    conn.connect();
  });
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
