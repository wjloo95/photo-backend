/**
 * src/email/index.ts
 *
 * Picks the EmailSender implementation from EMAIL_PROVIDER and exports it as
 * the one instance the rest of the app imports.
 *
 * Selection happens once at module load rather than per send, so a typo in
 * EMAIL_PROVIDER is a startup failure rather than a surprise the first time an
 * expiry warning goes out — though the zod enum in config/env.ts already
 * rejects an unknown value before this runs.
 *
 * Adding SES means writing src/email/sesSender.ts against the same interface
 * and adding one case below. Nothing that sends email changes.
 */

import { env } from '../config/env';
import { consoleSender } from './consoleSender';
import { EmailSender } from './types';

function selectSender(): EmailSender {
  switch (env.EMAIL_PROVIDER) {
    case 'console':
      return consoleSender;
    case 'ses':
      // Not built yet. Failing loudly at startup beats falling back to the
      // console adapter, which would look like a working deployment while
      // every expiry warning quietly went to a log file instead of a client.
      throw new Error(
        'EMAIL_PROVIDER=ses is not implemented yet — add src/email/sesSender.ts or set EMAIL_PROVIDER=console',
      );
  }
}

export const emailSender: EmailSender = selectSender();

export * from './types';
