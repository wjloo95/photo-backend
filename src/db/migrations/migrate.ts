/**
 * src/db/migrations/migrate.ts
 *
 * Applies all pending SQL migration files in alphabetical order.
 * Safe to run multiple times — already-applied migrations are skipped.
 *
 * Usage:
 *   npm run migrate
 *   npx ts-node src/db/migrations/migrate.ts
 *
 * See README.md in this folder for a full explanation of how migrations work.
 */

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';

// Load env vars directly here (not via src/config/env.ts) so this script
// can be run standalone without the full app booting.
import * as dotenv from 'dotenv';
dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function migrate() {
  const client = await pool.connect();

  try {
    // Step 1: Ensure the bookkeeping table exists.
    // IF NOT EXISTS makes this idempotent — safe to run every time.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Step 2: Find all .sql files in this directory, sorted alphabetically.
    const migrationsDir = __dirname;
    const allFiles = await readdir(migrationsDir);
    const sqlFiles = allFiles
      .filter((f) => f.endsWith('.sql'))
      .sort(); // alphabetical order = numerical order given 001_, 002_, ...

    // Step 3: Find which migrations have already been applied.
    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations'
    );
    const applied = new Set(rows.map((r) => r.filename));

    // Step 4: Apply each pending migration inside its own transaction.
    // If a migration fails, it rolls back and the script stops — the DB is
    // left in a clean state and schema_migrations is not updated.
    let appliedCount = 0;
    for (const filename of sqlFiles) {
      if (applied.has(filename)) {
        console.log(`  ⏭   ${filename} (already applied)`);
        continue;
      }

      const filePath = path.join(migrationsDir, filename);
      const sql = await readFile(filePath, 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [filename]
        );
        await client.query('COMMIT');
        console.log(`  ✅  ${filename}`);
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`\n❌  Failed on ${filename}:`);
        console.error(err);
        process.exit(1);
      }
    }

    if (appliedCount === 0) {
      console.log('\nAll migrations already applied. Nothing to do.');
    } else {
      console.log(`\nApplied ${appliedCount} migration(s) successfully.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration runner error:', err);
  process.exit(1);
});
