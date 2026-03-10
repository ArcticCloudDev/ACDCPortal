// Storage Module — Azure SQL backend
// Re-exports storage-sql.js directly. No JSON fallback.
const sql = require('./storage-sql');

module.exports = sql;
