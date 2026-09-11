/**
 * src/config/env.ts
 *
 * Validates all required environment variables at startup using Zod.
 * If any are missing or malformed, the process exits with a clear error
 * rather than crashing somewhere unexpected later.
 *
 * Usage anywhere in the app:
 *   import { env } from './config/env';
 *   env.DATABASE_URL  // fully typed, guaranteed to exist
 *
 * See src/config/README.md for a full explanation.
 */

/* eslint-disable no-console */
import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z
    .string()
    .default('3000')
    .transform(Number),

  // PostgreSQL
  DATABASE_URL: z
    .string()
    .url('DATABASE_URL must be a valid connection string (e.g. postgres://user:pass@host:5432/db)'),

  // Redis
  REDIS_URL: z
    .string()
    .url('REDIS_URL must be a valid connection string (e.g. redis://localhost:6379)'),

  // Auth0
  AUTH0_DOMAIN: z
    .string()
    .min(1, 'AUTH0_DOMAIN is required'),
  AUTH0_AUDIENCE: z
    .string()
    .url('AUTH0_AUDIENCE must be a URL (the identifier set in your Auth0 API settings)'),
  AUTH0_WEBHOOK_SECRET: z
    .string()
    .min(1, 'AUTH0_WEBHOOK_SECRET is required'),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().min(1, 'CLOUDINARY_CLOUD_NAME is required'),
  CLOUDINARY_API_KEY: z.string().min(1, 'CLOUDINARY_API_KEY is required'),
  CLOUDINARY_API_SECRET: z.string().min(1, 'CLOUDINARY_API_SECRET is required'),

  // Email
  // Which EmailSender implementation src/email/index.ts wires up. 'console'
  // needs no credentials and is the local default, so the expiry pipeline runs
  // end to end without an email account; 'ses' is the production adapter.
  EMAIL_PROVIDER: z.enum(['console', 'ses']).default('console'),
  // The From address on every outbound message. Defaulted rather than required
  // so an existing .env keeps working — the console adapter only prints it, and
  // the SES adapter will reject an unverified sender loudly at send time.
  EMAIL_FROM: z.string().email('EMAIL_FROM must be an email address').default('no-reply@sysphoto.local'),

  // Node environment
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
});

// parse() throws a ZodError if validation fails.
// The catch block formats the error into a readable message and exits.
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.errors
    .map((e) => `  ${e.path.join('.')}: ${e.message}`)
    .join('\n');

  console.error(`\n❌  Missing or invalid environment variables:\n${formatted}\n`);
  console.error('Copy .env.example to .env and fill in the required values.\n');
  process.exit(1);
}

export const env = parsed.data;
