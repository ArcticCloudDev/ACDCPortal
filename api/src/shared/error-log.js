const { getPool, sql } = require('./sql');
const { generateId } = require('./id');

async function logError(context, error, details = null) {
    try {
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
            .input('id',            sql.UniqueIdentifier,  generateId())
            .input('functionName',  sql.NVarChar(100),     functionName)
            .input('errorMessage',  sql.NVarChar(sql.MAX), errorMessage)
            .input('stackTrace',    sql.NVarChar(sql.MAX), stackTrace)
            .input('details',       sql.NVarChar(sql.MAX), detailsJson)
            .query(`INSERT INTO [Errors] ([Id], [FunctionName], [ErrorMessage], [StackTrace], [Details])
                    VALUES (@id, @functionName, @errorMessage, @stackTrace, @details)`);
    } catch (e) {
        console.error('[error-log] Failed to write to Errors table:', e.message);
    }
}

module.exports = { logError };
