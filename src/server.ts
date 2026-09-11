/**
 * src/server.ts
 *
 * Entry point. Starts the HTTP server and verifies infrastructure connections.
 *
 * Run with: npm run dev
 */

import * as dotenv from 'dotenv';
dotenv.config(); // Must be first — loads .env before any other import reads process.env

import app from './app';
import { env } from './config/env';
import { pool } from './config/database';
import { redis } from './config/redis';

async function start() {
  // Verify database connectivity before accepting traffic.
  // If DATABASE_URL is wrong or Postgres is not running, fail fast here
  // rather than on the first request.
  try {
    await pool.query('SELECT 1');
    console.log('✅  PostgreSQL connected');
  } catch (err) {
    console.error('❌  PostgreSQL connection failed:', err);
    process.exit(1);
  }

  // Redis connectivity is verified by the 'connect' event handler in config/redis.ts.
  // A connection error there will log to stderr. Here we just confirm it is ready.
  if (redis.status !== 'ready') {
    console.warn('⚠️   Redis not yet connected — jobs and cache will fail until it is');
  }

  app.listen(env.PORT, () => {
    console.log(`🚀  Server running on port ${env.PORT} [${env.NODE_ENV}]`);
  });
}

start();
