/**
 * A path parameter that names a row by uuid.
 *
 * Checked before it reaches Postgres, which answers a malformed uuid with an
 * error (22P02) rather than an empty result. Until 2026-10-15
 * `/api/v1/reports/not-a-uuid` and `/portal/listings/x.png` were 500s — a
 * server fault reported for a typo in a URL. Anything that is not a uuid is
 * simply not found: 404, the same answer as a uuid that matches nothing.
 *
 * Hyphenated, case-insensitive: the form we hand out. Postgres also accepts
 * braces and no hyphens; nobody is sent those, so nobody needs them back.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
