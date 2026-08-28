/**
 * Get the real message out of a database error.
 *
 * Drizzle wraps driver errors in "Failed query: <the entire SQL>" and puts the
 * one useful line — `relation "market_reports" does not exist`, `column
 * "agency_name" does not exist` — on `cause`, where nothing prints it. The
 * result is a screen showing four hundred characters of SELECT and no
 * indication of what is actually wrong.
 *
 * That cost real time twice in this project: once on a missing column, once on
 * an unapplied migration. Both were one word away from obvious.
 */

type PgError = {
  message?: string;
  detail?: string;
  hint?: string;
  code?: string;
  /** Postgres names the offending table/column here on some error classes. */
  table?: string;
  column?: string;
};

export function dbErrorMessage(err: unknown): string {
  const e = err as Error & { cause?: PgError };
  const cause = e?.cause;
  if (!cause?.message) return e?.message ?? String(err);

  const parts = [cause.message];
  if (cause.detail) parts.push(cause.detail);
  if (cause.hint) parts.push(`hint: ${cause.hint}`);

  /**
   * `42P01` is "undefined_table", which in this project means an unapplied
   * migration far more often than it means a typo. Saying so turns a puzzle
   * into a command.
   */
  if (cause.code === "42P01") {
    parts.push("This usually means a migration has not been applied — try `npm run db:migrate`.");
  }
  if (cause.code === "42703") {
    parts.push(
      "Undefined column: schema.ts and the database disagree. Check the migration for this table has run.",
    );
  }

  return parts.join(" — ");
}

/**
 * Log a database failure legibly, then rethrow.
 *
 * Rethrows rather than swallowing: a page that fails should still fail. The
 * point is only that the reason reaches the console instead of being buried
 * under the SQL that caused it.
 */
export function logDbError(context: string, err: unknown): never {
  console.error(`[${context}] ${dbErrorMessage(err)}`);
  throw err;
}
