const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'capsule',
  password: process.env.DB_PASSWORD || 'capsule_secret',
  database: process.env.DB_NAME || 'capsule',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_POOL_SIZE || '30', 10),
  queueLimit: 0,
  connectTimeout: 10000,
});

// Cap how long a single SELECT may run. MySQL keeps executing a statement after
// the HTTP client has given up, so one pathological query can otherwise burn a
// core indefinitely and hold metadata locks that block migrations.
const statementTimeoutMs = parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '15000', 10);
if (statementTimeoutMs > 0) {
  pool.on('connection', (conn) => {
    conn.query(`SET SESSION MAX_EXECUTION_TIME = ${statementTimeoutMs}`, (err) => {
      if (err) console.error('Could not set statement timeout:', err.message);
    });
  });
}

module.exports = pool;
