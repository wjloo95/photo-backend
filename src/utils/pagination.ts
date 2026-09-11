/**
 * src/utils/pagination.ts
 *
 * Shared ?page=&limit= parsing for the paginated list endpoints
 * (album photos, conversation messages).
 */

/**
 * Reads one pagination query param, falling back rather than erroring.
 *
 * Either param falls back to its default when missing or not a positive
 * integer — a caller who sends ?page=abc gets page 1, not a 400. When `max`
 * is given the value is capped, so a caller can't request an unbounded page
 * in a single request.
 */
export function parsePaginationParam(value: unknown, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return max ? Math.min(parsed, max) : parsed;
}
