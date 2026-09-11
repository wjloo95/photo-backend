/**
 * src/config/database.ts
 *
 * Creates and exports a single shared pg.Pool for the entire application.
 * Import `pool` from here wherever you need to run a query.
 *
 * This file does NOT contain any SQL queries — those live in src/db/queries/.
 * See src/config/README.md for an explanation of Pool vs Client.
 */

/* eslint-disable no-console */
import { Pool } from 'pg';
import { env } from './env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,

  // Maximum number of connections in the pool.
  // Each connection is a TCP socket to PostgreSQL.
  // PostgreSQL's default max_connections is 100 — stay well below it.
  max: 10,

  // How long (ms) a client can sit idle before being closed and removed.
  idleTimeoutMillis: 30_000,

  // How long (ms) to wait for a connection before throwing an error.
  // If all 10 connections are busy and a new query waits longer than this, it errors.
  connectionTimeoutMillis: 2_000,
});

// Optional: log when the pool emits an error on an idle connection.
// This surfaces unexpected disconnections (e.g. RDS restarting) rather than
// swallowing them silently.
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});
