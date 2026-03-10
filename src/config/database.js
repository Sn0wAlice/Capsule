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

module.exports = pool;
