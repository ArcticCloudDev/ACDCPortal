// Errors API — read from the Errors table (admin use)
const { app } = require('@azure/functions');
const { requireAuth } = require('../shared/auth');
const { getPool, sql } = require('../shared/sql');

// GET /api/errors?limit=100&functionName=foo
app.http('errors-list', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'errors',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const limit        = Math.min(parseInt(request.query.get('limit')  || '100'), 500);
            const functionName = request.query.get('functionName') || null;
            const severity     = request.query.get('severity')     || null;

            const pool = await getPool();
            const req  = pool.request().input('limit', sql.Int, limit);

            let where = '';
            if (functionName) {
                req.input('functionName', sql.NVarChar(100), functionName);
                where += " AND [FunctionName] = @functionName";
            }
            if (severity) {
                req.input('severity', sql.NVarChar(20), severity);
                where += " AND [Severity] = @severity";
            }

            const result = await req.query(
                `SELECT TOP (@limit)
                     [Id], [OccurredAt], [FunctionName], [ErrorMessage], [StackTrace], [Details], [Severity]
                 FROM [Errors]
                 WHERE 1=1 ${where}
                 ORDER BY [OccurredAt] DESC`
            );

            const errors = result.recordset.map(r => ({
                id:           r.Id,
                occurredAt:   r.OccurredAt,
                functionName: r.FunctionName,
                errorMessage: r.ErrorMessage,
                stackTrace:   r.StackTrace   || null,
                details:      r.Details ? JSON.parse(r.Details) : null,
                severity:     r.Severity
            }));

            return { status: 200, jsonBody: { errors, count: errors.length } };
        } catch (error) {
            context.error('errors-list failed:', error);
            return { status: 500, jsonBody: { error: 'Failed to retrieve errors' } };
        }
    }
});

// DELETE /api/errors/:id  (clear a single entry)
app.http('errors-delete', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'errors/{id}',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const id = request.params.id;
            const pool = await getPool();
            await pool.request()
                .input('id', sql.UniqueIdentifier, id)
                .query('DELETE FROM [Errors] WHERE [Id] = @id');
            return { status: 204 };
        } catch (error) {
            context.error('errors-delete failed:', error);
            return { status: 500, jsonBody: { error: 'Failed to delete error' } };
        }
    }
});

// DELETE /api/errors  (clear all — admin housekeeping)
app.http('errors-clear', {
    methods: ['DELETE'],
    authLevel: 'function',
    route: 'errors',
    handler: async (request, context) => {
        try {
            const auth = requireAuth(request, context, { requireAdmin: true });
            if (!auth.authorized) {
                return { status: auth.status, jsonBody: auth.jsonBody };
            }

            const pool = await getPool();
            const result = await pool.request().query('DELETE FROM [Errors]');
            return { status: 200, jsonBody: { deleted: result.rowsAffected[0] } };
        } catch (error) {
            context.error('errors-clear failed:', error);
            return { status: 500, jsonBody: { error: 'Failed to clear errors' } };
        }
    }
});
