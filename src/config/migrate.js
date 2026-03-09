const fs = require('fs');
const path = require('path');
const pool = require('./database');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

async function migrate() {
  // Ensure migrations table exists
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get already applied migrations
  const [applied] = await pool.execute('SELECT name FROM migrations ORDER BY name');
  const appliedSet = new Set(applied.map(r => r.name));

  // Read migration files
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    console.log(`[migrate] Applying ${file}...`);
    for (const stmt of statements) {
      await pool.execute(stmt);
    }

    await pool.execute('INSERT INTO migrations (name) VALUES (?)', [file]);
    count++;
  }

  if (count > 0) {
    console.log(`[migrate] ${count} migration(s) applied.`);
  } else {
    console.log('[migrate] Database is up to date.');
  }
}

module.exports = migrate;
