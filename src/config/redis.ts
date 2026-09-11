/**
 * src/config/redis.ts
 *
 * Creates and exports a single shared ioredis client.
 * Used by both the cache layer (src/cache/) and BullMQ queues (src/jobs/queues/).
 *
 * See src/config/README.md for why ioredis is used over the official redis package.
 */

/* eslint-disable no-console */
import Redis from 'ioredis';
import { env } from './env';

export const redis = new Redis(env.REDIS_URL, {
  // Retry failed connections with exponential backoff, up to 10 attempts.
  // Without this, a brief Redis blip would crash the server.
  maxRetriesPerRequest: null, // required by BullMQ — do not change
  retryStrategy(times) {
    if (times > 10) {
      console.error('Redis: exceeded 10 reconnect attempts, giving up');
      return null; // stop retrying
    }
    const delay = Math.min(times * 100, 3_000); // 100ms, 200ms, ... up to 3s
    return delay;
  },
});

redis.on('connect', () => {
  console.log('✅  Redis connected');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});
