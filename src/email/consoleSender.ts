/**
 * src/email/consoleSender.ts
 *
 * An EmailSender that prints instead of sending.
 *
 * This is the local default (EMAIL_PROVIDER=console), and it exists so the
 * expiry pipeline is runnable end to end with no email account, no verified
 * domain and no credentials — the same reason POST /invites returns its token
 * in the response body rather than mailing it.
 *
 * It never throws. That is honest for what it does (writing to stdout does not
 * fail in any way worth modelling) but it does mean the "send failed, so don't
 * mark the album warned" path in the expiry processor is unreachable while
 * this adapter is wired up. That path is covered by tests against a stub
 * sender instead.
 */

/* eslint-disable no-console */
import { env } from '../config/env';
import { EmailMessage, EmailSender } from './types';

export const consoleSender: EmailSender = {
  async send(message: EmailMessage): Promise<void> {
    console.log(
      [
        '───── email (console adapter, not actually sent) ─────',
        `from:    ${env.EMAIL_FROM}`,
        `to:      ${message.to}`,
        `subject: ${message.subject}`,
        '',
        message.text,
        '──────────────────────────────────────────────────────',
      ].join('\n'),
    );
  },
};
