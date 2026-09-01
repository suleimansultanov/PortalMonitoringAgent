import "server-only";
import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Load `.env.local` when running outside Next.js.
 *
 * Next loads it for the app; nothing loads it for `db:seed`, `collect` or any
 * other script, so those died on import with "DATABASE_URL is not set" while
 * the variable sat in a file two directories up. Doing it here rather than in
 * each entry point means it cannot be forgotten by whoever writes the next
 * script.
 *
 * Skipped entirely when the variable is already present, so production — where
 * the platform supplies it and `@next/env` is a dev dependency that may not be
 * installed — never reaches the require.
 */
function ensureEnvLoaded(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const require_ = createRequire(import.meta.url);
    const { loadEnvConfig } = require_("@next/env") as {
      loadEnvConfig: (dir: string) => void;
    };
    loadEnvConfig(process.cwd());
  } catch {
    // Not available. The caller's own error message is clearer than anything
    // we could add here.
  }
}

/**
 * Postgres pool. Ported from the Vault project along with the lessons that are
 * baked into these numbers — see the comments on the timeouts, they were each
 * paid for by an outage.
 */

declare global {
  // eslint-disable-next-line no-var
  var __pma_pg_pool: Pool | undefined;
}

/** Loopback means a local Postgres; everything else crosses a network. */
function needsSsl(connectionString: string): boolean {
  if (/[?&]sslmode=disable\b/i.test(connectionString)) return false;
  try {
    const host = new URL(connectionString).hostname;
    return !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host);
  } catch {
    // An unparseable string is somebody else's error to report. Assume remote,
    // because the failure mode of guessing wrong that way is a refused
    // connection rather than an unencrypted one.
    return true;
  }
}

function getPool(): Pool {
  if (globalThis.__pma_pg_pool) return globalThis.__pma_pg_pool;

  ensureEnvLoaded();

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Add it to .env.local.");

  const pool = new Pool({
    connectionString: url,
    max: 10,
    // Drop our idle connections before the Supabase pooler reaps them on its
    // side, so we never hand out a socket that is already dead.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    /**
     * The critical guard for serverless. When a thawed function grabs a pooled
     * socket the pooler closed while we were frozen, a query otherwise hangs
     * forever — the function then runs until it is SIGKILLed at maxDuration,
     * skipping every catch and cleanup path. That is how jobs end up wedged in
     * "running" with no error anywhere. With a timeout the query rejects and
     * withDbRetry re-runs it on a fresh connection.
     */
    query_timeout: 10_000,
    statement_timeout: 10_000,
    /**
     * SSL DECIDED BY WHERE THE DATABASE IS, NOT BY NODE_ENV.
     *
     * This used to read `NODE_ENV === "production"`, which was right while the
     * only thing talking to a remote database was the deployed app. It stopped
     * being right the moment the collector was pointed at Supabase: the nightly
     * runs from the CLI, where NODE_ENV is unset, so the one process that talks
     * to a remote database for hours a night was the one connecting without
     * this.
     *
     * The host is the honest signal. A loopback address is a local Postgres and
     * wants no TLS; anything else is across a network and does. `sslmode` in
     * the connection string still wins, so a deliberate `sslmode=disable`
     * against a remote host — a tunnel, a test — is left alone.
     *
     * Supabase's pooler terminates SSL at a proxy that presents no verifiable
     * chain. Disabling verification still encrypts; it only skips the chain
     * check, which is the standard setup for PgBouncer in front of Supabase.
     */
    ...(needsSsl(url) && { ssl: { rejectUnauthorized: false } }),
  });

  if (process.env.NODE_ENV !== "production") globalThis.__pma_pg_pool = pool;
  return pool;
}

/**
 * Lazy on purpose.
 *
 * This used to be `drizzle(getPool(), …)` evaluated at module load, which meant
 * merely importing anything that touched the database opened a connection — and
 * threw if the environment was not ready yet. Import order became load-bearing:
 * put `import { db }` above the line that loads `.env.local` and the script
 * died, with an error pointing at the database rather than at the ordering.
 *
 * With the pool created on first use, importing is free and the connection is
 * opened by whoever actually needs it, by which time the environment is up.
 */
let instance: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!instance) instance = drizzle(getPool(), { schema });
  return instance;
}

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export { schema };

/** True for errors that mean "this pooled connection is dead", not "this query is wrong". */
function isDeadConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  if (["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND"].includes(code)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /timeout|terminat|connection|socket|server closed|read econn/.test(msg);
}

/**
 * Retry only connection-level failures. Logical errors — unique violations,
 * constraint failures — propagate immediately, because retrying those just
 * fails again more slowly and hides the real problem.
 */
export async function withDbRetry<T>(op: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isDeadConnectionError(err)) throw err;
      console.warn(`[db] retrying after dead-connection error (attempt ${i + 1}):`, (err as Error)?.message);
    }
  }
  throw lastErr;
}
