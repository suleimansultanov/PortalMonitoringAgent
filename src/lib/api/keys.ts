import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clientApiKeys, clients, clientSources } from "@/lib/db/schema";

/**
 * API keys for client instances.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * A key determines what its holder may read. The request never does. There is
 * no `?client=` and no `?commune=` that widens anything — `resolveKey` returns
 * the scope, handlers intersect with it, and a caller asking for a commune it
 * does not subscribe to gets nothing rather than an error, because an error
 * would confirm the commune exists.
 *
 * Market data is not secret. The subscription to it is the product, and the
 * first curious instance will try a neighbour's INSEE code out of ordinary
 * curiosity — not malice, just to see. It should find nothing there.
 */

/**
 * `pma_live_` so a leaked string is recognisable as ours at a glance — in a
 * paste, a log, a support ticket. Secret scanners key on prefixes like this
 * too, and a key we can be told about is better than one we cannot.
 */
const PREFIX = "pma_live_";
/** 32 random bytes. Guessing is not a threat model at this width. */
const KEY_BYTES = 32;
/** Enough to name one key among a client's few, not enough to be useful alone. */
const VISIBLE = PREFIX.length + 6;

export type IssuedKey = {
  /** Shown once, at creation, and never recoverable afterwards. */
  key: string;
  prefix: string;
  keyHash: string;
};

export function generateKey(): IssuedKey {
  const key = PREFIX + randomBytes(KEY_BYTES).toString("base64url");
  return { key, prefix: key.slice(0, VISIBLE), keyHash: hashKey(key) };
}

/**
 * SHA-256, deliberately, and not bcrypt.
 *
 * Slow hashes exist to make guessing a human-chosen secret expensive. This
 * secret is 256 bits of randomness — there is nothing to guess, so the slowness
 * would buy nothing and would be paid on every single request.
 */
export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export type KeyScope = {
  keyId: string;
  clientId: string;
  clientSlug: string;
  /** INSEE codes this client watches. Empty means the client watches nothing. */
  communeInsee: string[];
  /** Portal source ids this client subscribes to. */
  sourceIds: string[];
};

/**
 * How often `last_used_at` is actually written.
 *
 * The column answers "is anyone still using this key?" before someone revokes
 * it, which is a question asked monthly at most. Writing it on every request
 * would put a database write on the hot path of a read-only API to gain a
 * precision nobody wants.
 */
const LAST_USED_STALE_MS = 60 * 60 * 1000;

/**
 * Resolve a presented key to what it may read, or null.
 *
 * Null for every failure — unknown, revoked, expired, or belonging to an
 * inactive client. The caller answers 401 without saying which, because
 * "revoked" and "never existed" are different sentences and the difference is
 * only useful to someone probing.
 */
export async function resolveKey(presented: string | null): Promise<KeyScope | null> {
  if (!presented || !presented.startsWith(PREFIX)) return null;

  const [row] = await db
    .select({
      keyId: clientApiKeys.id,
      keyHash: clientApiKeys.keyHash,
      lastUsedAt: clientApiKeys.lastUsedAt,
      clientId: clients.id,
      clientSlug: clients.slug,
      communeInsee: clients.communeInsee,
      active: clients.active,
    })
    .from(clientApiKeys)
    .innerJoin(clients, eq(clients.id, clientApiKeys.clientId))
    .where(
      and(
        eq(clientApiKeys.keyHash, hashKey(presented)),
        isNull(clientApiKeys.revokedAt),
        or(isNull(clientApiKeys.expiresAt), sql`${clientApiKeys.expiresAt} > now()`),
      ),
    )
    .limit(1);

  if (!row || !row.active) return null;

  /**
   * The lookup above already matched on the hash, so this compares two values
   * that are equal. It is here so that the comparison is constant-time if this
   * ever becomes a scan rather than an index lookup — the cheap habit, kept
   * where the expensive one would be easy to forget.
   */
  const a = Buffer.from(row.keyHash, "hex");
  const b = Buffer.from(hashKey(presented), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const subscribed = await db
    .select({ sourceId: clientSources.sourceId })
    .from(clientSources)
    .where(and(eq(clientSources.clientId, row.clientId), eq(clientSources.enabled, true)));

  const stale =
    !row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_STALE_MS;
  if (stale) {
    // Not awaited into the response path's critical work, but awaited so a
    // serverless runtime cannot freeze mid-write.
    await db
      .update(clientApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(clientApiKeys.id, row.keyId),
          or(
            isNull(clientApiKeys.lastUsedAt),
            lt(clientApiKeys.lastUsedAt, new Date(Date.now() - LAST_USED_STALE_MS)),
          ),
        ),
      )
      .catch(() => {
        /* A missed timestamp must never fail a request. */
      });
  }

  return {
    keyId: row.keyId,
    clientId: row.clientId,
    clientSlug: row.clientSlug,
    communeInsee: row.communeInsee,
    sourceIds: subscribed.map((s) => s.sourceId),
  };
}

/** `Authorization: Bearer <key>`, or the `X-Api-Key` header for clients that prefer it. */
export function keyFromRequest(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return headers.get("x-api-key")?.trim() || null;
}

/**
 * Narrow a requested commune list to what the key allows.
 *
 * Intersection, never validation: a request naming communes it may not see is
 * not rejected, it simply does not receive them. Rejecting would turn the API
 * into an oracle for "which communes exist in your system".
 */
export function scopeCommunes(scope: KeyScope, requested?: string[]): string[] {
  if (!requested || requested.length === 0) return scope.communeInsee;
  const allowed = new Set(scope.communeInsee);
  return requested.filter((c) => allowed.has(c));
}
