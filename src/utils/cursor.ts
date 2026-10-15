/**
 * src/utils/cursor.ts
 *
 * Opaque cursors for keyset ("after this position") pagination over a list
 * ordered by (timestamp, id).
 *
 * A cursor encodes the last returned item's sort position, not its id alone,
 * so it keeps working when that item is deleted: "after where it was" still
 * has a meaning. Offset pagination can't offer that. Removing one item from
 * an earlier page shifts every later item up a slot, and the next page
 * silently skips one.
 */

export interface CursorPosition {
  at: Date;
  id: string;
}

/** base64url of `[isoTimestamp, id]`. Clients pass it back untouched. */
export function encodeCursor({ at, id }: CursorPosition): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}

/**
 * Returns null for anything encodeCursor couldn't have produced, including a
 * repeated query param (`?cursor=a&cursor=b` arrives as an array). The caller
 * turns null into a 400. Falling back to the first page instead, the way a bad
 * `limit` falls back, would restart a client's infinite list and repeat
 * everything it already showed.
 */
export function decodeCursor(value: unknown): CursorPosition | null {
  if (typeof value !== 'string' || value === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    parsed[1] === ''
  ) {
    return null;
  }

  const at = new Date(parsed[0]);
  // The round trip rejects anything toISOString wouldn't have written,
  // including dates Date.parse accepts loosely ("2026", "Oct 15").
  if (Number.isNaN(at.getTime()) || at.toISOString() !== parsed[0]) {
    return null;
  }

  return { at, id: parsed[1] };
}

/** Whether `position` sorts strictly after `cursor` in (at, id) order. */
export function isAfterCursor(position: CursorPosition, cursor: CursorPosition): boolean {
  const atDiff = position.at.getTime() - cursor.at.getTime();
  return atDiff > 0 || (atDiff === 0 && position.id > cursor.id);
}
