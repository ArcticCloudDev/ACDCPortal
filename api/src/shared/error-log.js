// Centralised error logging — writes to the Errors table in Azure SQL.
// Never throws: if the DB write fails we console.error and move on.
//
// Usage:
//   const { logError } = require('../shared/error-log');   // from functions/
//   const { logError } = require('./error-log');           // from shared/
//
//   await logError(context, error);
//   await logError('my-background-job', error, { userId, eventId });
//   await logError(context, error, { extraInfo: 'something useful' });

const { getPool, sql } = require('./sql');
const { v4: uuidv4 } = require('uuid');

/**
 * Persist an error to the Errors table.
 *
 * @param {object|string|null} context
 *   - Azure Functions InvocationContext  → uses context.functionName
 *   - string                            → used as function name directly
 *   - null / undefined                  → recorded as 'unknown'
 * @param {Error|any} error  The thrown value.
 * @param {object}  [details]  Optional JSON-serialisable extra info (IDs, payloads…).
 */
async function logError(context, error, details = null) {
    try {
        // Resolve a readable function name from whatever we received
        const functionName = (
            typeof context === 'string'
                ? context
                : (context?.functionName || context?.executionContext?.functionName || 'unknown')
        ).substring(0, 100);

        const errorMessage = (error instanceof Error ? error.message : String(error)) || 'Unknown error';
        const stackTrace   = error instanceof Error ? (error.stack || null) : null;
        const detailsJson  = details ? JSON.stringify(details) : null;

        const pool = await getPool();
        await pool.request()
            .input('id',            sql.UniqueIdentifier,  uuidv4())
            .input('functionName',  sql.NVarChar(100),     functionName)
            .input('errorMessage',  sql.NVarChar(sql.MAX), errorMessage)
            .input('stackTrace',    sql.NVarChar(sql.MAX), stackTrace)
            .input('details',       sql.NVarChar(sql.MAX), detailsJson)
            .query(`INSERT INTO [Errors] ([Id], [FunctionName], [ErrorMessage], [StackTrace], [Details])
                    VALUES (@id, @functionName, @errorMessage, @stackTrace, @details)`);
    } catch (e) {
        // Never propagate — logging must not break the caller
        console.error('[error-log] Failed to write to Errors table:', e.message);
    }
}

module.exports = { logError };
