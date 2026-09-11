/**
 * src/utils/validation.ts
 *
 * Shared zod helpers for request-body parsing.
 *
 * Every endpoint that takes a body parses it once at the top of its handler
 * with safeParse, so a malformed request is a 400 before any DB work happens.
 * The formatting of that 400 lives here so the message shape is identical
 * across routes rather than being reinvented per file.
 */

import { z } from 'zod';

/**
 * Turns a ZodError into one human-readable line for the 400 body.
 *
 * Only the first issue is reported. The client's next move is the same either
 * way — fix the body and resend — and naming the offending path
 * ('questions.3.content') is what makes that possible without dumping zod's
 * full issue tree into the response.
 */
export function firstIssueMessage(error: z.ZodError): string {
  const [issue] = error.issues;
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
