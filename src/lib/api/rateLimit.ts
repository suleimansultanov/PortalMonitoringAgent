import "server-only";
import { createHmac } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";

/**
 * RATE LIMITS: fixed windows, counted in Postgres.
 *
 * Until 2026-10-15 there were none. One key could pull `limit=500` pages of
 * the whole market as fast as it liked, a password could be guessed as fast
 * as bcrypt allowed, and nothing would have shown either.
 *
 * In Postgres because this runs on Vercel: every request may land on a fresh
 * function instance, so a counter in memory counts one request and is gone.
 * The cost is one upsert per request on a one-row-per-bucket table
 * (`rate_limits`, drizzle/0010). A fixed window rather than a sliding one —
 * a burst at a window's edge may reach twice the limit for a moment, which is
 * harmless at these sizes and keeps it to a single statement.
 *
 * GENEROUS ON PURPOSE. These stop a runaway loop and a guessing script; they
 * must never be felt by a normal client. The client's app is told to pull
 * when `lastSuccessfulCollectionAt` advances (docs/API.md) — a few walks a
 * day of at most a few dozen pages. A limit it can reach is a limit set
 * wrong, and the place to say so is docs/API.md, "429".
 *
 * FAILS OPEN. If the count cannot be written — the table not migrated yet,
 * the pooler dropping a connection — the request goes through and the
 * failure is logged. A limiter that turns a database hiccup into an outage of
 * the client's API is worse than no limiter.
 */
export const LIMITS = {
  /** /api/v1, per key: two a second, sustained for a minute. */
  v1PerKey: { limit: 120, windowSec: 60 },
  /**
   * /api/v1 with a key we do not accept, per address. A client whose key was
   * revoked and keeps polling every few minutes never reaches it; a script
   * trying keys reaches it in its first ten minutes and is answered 429.
   */
  v1UnauthorisedPerIp: { limit: 30, windowSec: 600 },
  /** Failed sign-ins per email and address. The eleventh in 15 minutes is refused. */
  loginPerEmailIp: { limit: 10, windowSec: 900 },
  /** Failed sign-ins per address, whatever the email: one password tried on many accounts. */
  loginPerIp: { limit: 50, windowSec: 900 },
} as const;

export type Rule = { limit: number; windowSec: number };

/** The window `nowMs` falls in, and how long until it ends — the `Retry-After`. */
export function fixedWindow(nowMs: number, windowSec: number): { start: Date; retryAfterSec: number } {
  const size = windowSec * 1000;
  const start = Math.floor(nowMs / size) * size;
  return { start: new Date(start), retryAfterSec: Math.max(1, Math.ceil((start + size - nowMs) / 1000)) };
}

/**
 * The caller's address. On Vercel `x-real-ip` and the first `x-forwarded-for`
 * entry are set by the platform, not the caller; "unknown" locally, where
 * every request shares one bucket.
 */
export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "unknown";
}

/**
 * A bucket name. Keyed HMAC of the parts rather than the parts: the table
 * would otherwise hold every email anyone tried, beside the address it was
 * tried from. Rotating AUTH_SECRET empties every bucket, which is harmless.
 */
export function bucket(kind: string, ...parts: string[]): string {
  const mac = createHmac("sha256", process.env.AUTH_SECRET ?? "pma-rate-limit")
    .update(parts.join("\u0000"))
    .digest("hex");
  return `${kind}:${mac.slice(0, 32)}`;
}

export function loginBuckets(email: string, ip: string): { emailIp: string; ip: string } {
  return { emailIp: bucket("login", email.trim().toLowerCase(), ip), ip: bucket("login-ip", ip) };
}

type Exec = (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>;
const execute: Exec = (query) => db.execute(query) as Promise<{ rows: Record<string, unknown>[] }>;

let warned = false;
function failOpen(where: string, err: unknown): void {
  // Once per instance: a missing table would otherwise log on every request.
  if (warned) return;
  warned = true;
  console.warn(`[rate-limit] ${where} failed; letting requests through:`, dbErrorMessage(err));
}

export type Verdict = { allowed: boolean; count: number; retryAfterSec: number };

/**
 * Count one request against a bucket and say whether it is within the rule.
 *
 * One statement: a new bucket starts at 1; a bucket still in this window adds
 * one; a bucket from an older window restarts at 1. `>=` and `greatest`, so
 * an instance whose clock runs a little behind adds to the current window
 * instead of resetting it.
 */
export async function hit(
  key: string,
  rule: Rule,
  opts: { now?: number; exec?: Exec } = {},
): Promise<Verdict> {
  const w = fixedWindow(opts.now ?? Date.now(), rule.windowSec);
  try {
    const { rows } = await (opts.exec ?? execute)(sql`
      insert into rate_limits (bucket, window_start, count)
      values (${key}, ${w.start.toISOString()}::timestamptz, 1)
      on conflict (bucket) do update set
        count = case
          when rate_limits.window_start >= excluded.window_start then rate_limits.count + 1
          else 1
        end,
        window_start = greatest(rate_limits.window_start, excluded.window_start)
      returning count
    `);
    const count = Number(rows[0]?.count ?? 1);
    return { allowed: count <= rule.limit, count, retryAfterSec: w.retryAfterSec };
  } catch (err) {
    failOpen("hit", err);
    return { allowed: true, count: 0, retryAfterSec: 0 };
  }
}

/** How many are already counted in this window, without counting this one. */
export async function peek(
  key: string,
  rule: Rule,
  opts: { now?: number; exec?: Exec } = {},
): Promise<Verdict> {
  const w = fixedWindow(opts.now ?? Date.now(), rule.windowSec);
  try {
    const { rows } = await (opts.exec ?? execute)(sql`
      select count from rate_limits
      where bucket = ${key} and window_start >= ${w.start.toISOString()}::timestamptz
    `);
    const count = Number(rows[0]?.count ?? 0);
    return { allowed: count < rule.limit, count, retryAfterSec: w.retryAfterSec };
  } catch (err) {
    failOpen("peek", err);
    return { allowed: true, count: 0, retryAfterSec: 0 };
  }
}

/**
 * May this email sign in from this address now? Null when it may, else the
 * seconds until it may. Failed attempts only are counted (`recordFailedLogin`),
 * so a person who signs in correctly is never slowed by their own successes.
 */
export async function loginRefusal(email: string, ip: string): Promise<number | null> {
  const b = loginBuckets(email, ip);
  const [mine, fromIp] = await Promise.all([
    peek(b.emailIp, LIMITS.loginPerEmailIp),
    peek(b.ip, LIMITS.loginPerIp),
  ]);
  if (mine.allowed && fromIp.allowed) return null;
  return Math.max(mine.allowed ? 0 : mine.retryAfterSec, fromIp.allowed ? 0 : fromIp.retryAfterSec);
}

export async function recordFailedLogin(email: string, ip: string): Promise<void> {
  const b = loginBuckets(email, ip);
  await Promise.all([hit(b.emailIp, LIMITS.loginPerEmailIp), hit(b.ip, LIMITS.loginPerIp)]);
}

/**
 * Old rows out, now and then: buckets from windows long gone, and journal
 * rows past their keeping (see `api_request_log` in drizzle/0010). One
 * request in five hundred pays for it; nothing else needs scheduling.
 */
export async function pruneNowAndThen(chance = 1 / 500): Promise<void> {
  if (Math.random() >= chance) return;
  try {
    await execute(sql`delete from rate_limits where window_start < now() - interval '1 day'`);
    await execute(sql`delete from api_request_log where at < now() - interval '90 days'`);
  } catch (err) {
    failOpen("prune", err);
  }
}
