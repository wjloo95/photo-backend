/**
 * src/email/types.ts
 *
 * The port every email sender implements.
 *
 * Callers depend on this interface, never on a provider SDK, so the expiry
 * pipeline can be built and tested today against a console adapter and moved
 * to SES later by changing one env var. It is also what keeps provider types
 * out of the job processors — a test asserting "a warning was sent to this
 * address" should not have to know what an SES SendEmailCommand looks like.
 *
 * Deliberately minimal: to / subject / text. Not because HTML mail is
 * unreasonable, but because every field here has to be implemented by every
 * adapter, and nothing in this codebase needs more yet. Adding `html` later is
 * additive; removing a field the console adapter silently ignored is not.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  /**
   * Delivers one message, or throws.
   *
   * Throwing is the contract that matters. Callers in the expiry pipeline
   * write "send, then mark as warned" and rely on a failed send skipping the
   * mark, so an adapter that swallows its own errors would silently record
   * warnings nobody received — and, with the deletion gate in
   * getExpiredAlbums, would then let those albums be deleted on schedule.
   */
  send(message: EmailMessage): Promise<void>;
}
