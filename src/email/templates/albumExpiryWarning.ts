/**
 * src/email/templates/albumExpiryWarning.ts
 *
 * Builds the 90 / 30 / 7-day expiry warning sent to the client whose album is
 * about to be deleted.
 *
 * A pure function from data to EmailMessage — no DB access, no sending. That
 * split is what makes the wording testable without a mail adapter, and it
 * keeps the processor's job to deciding *whether* to send rather than what to
 * say.
 */

import { EmailMessage } from '../types';

export type WarningDays = 90 | 30 | 7;

export interface AlbumExpiryWarningInput {
  clientEmail: string;
  clientName: string | null;
  shootDate: Date;
  accessExpiresAt: Date;
  days: WarningDays;
}

/**
 * Dates render as ISO calendar days (YYYY-MM-DD) rather than a locale format.
 * The server has no idea what locale or timezone the recipient reads in, and
 * an unqualified "01/02/2029" is genuinely ambiguous across regions — which is
 * a bad property for the last notice before irreversible deletion.
 */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function albumExpiryWarning(input: AlbumExpiryWarningInput): EmailMessage {
  const { clientEmail, clientName, shootDate, accessExpiresAt, days } = input;

  // The 7-day notice is the last one that goes out, so it says so. The earlier
  // two are informational; this one is the point at which "I'll get to it"
  // stops being safe.
  const isFinal = days === 7;
  const greeting = clientName ? `Hi ${clientName},` : 'Hi,';

  const subject = isFinal
    ? `Final notice: your photos are deleted in ${days} days`
    : `Your photos will be deleted in ${days} days`;

  const text = [
    greeting,
    '',
    `Your gallery from the shoot on ${formatDate(shootDate)} is scheduled for`,
    `permanent deletion on ${formatDate(accessExpiresAt)} — ${days} days from now.`,
    '',
    isFinal
      ? 'This is the last reminder you will get. Once the photos are deleted they cannot be recovered, so please download anything you want to keep before that date.'
      : 'Download anything you want to keep before then. Deletion is permanent and the photos cannot be recovered afterwards.',
    '',
    'If you need more time, contact your photographer.',
  ].join('\n');

  return { to: clientEmail, subject, text };
}
