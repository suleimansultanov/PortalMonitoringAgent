import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/utils/crypto";

/**
 * Encrypted key/value store, ported from Vault.
 *
 * Keys must be registered below. The guard exists because a typo in a setting
 * key is otherwise invisible: the write succeeds into a row nobody reads, and
 * the feature just quietly behaves as if unconfigured. Throwing on an unknown
 * key turns a silent misconfiguration into a stack trace.
 */

export const SETTING_KEYS = {
  /** Master switch for the daily discovery cron. Off by default. */
  COLLECTION_ENABLED: "collection_enabled",
  /** ISO timestamp of the last completed discovery pass across all sources. */
  LAST_COLLECTION_AT: "last_collection_at",
  /**
   * Fraction of yesterday's count below which a run aborts without emitting
   * delistings. Stored rather than hardcoded so it can be loosened during a
   * genuine market lull without a deploy.
   */
  ABORT_THRESHOLD: "abort_threshold",
  /** Similarity score above which two listings are considered one property. */
  MATCH_THRESHOLD: "match_threshold",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

const KNOWN_KEYS_LIST: readonly string[] = Object.values(SETTING_KEYS);

/** Keys whose values are encrypted at rest. Add API tokens here as they appear. */
const ENCRYPTED_KEYS: ReadonlySet<string> = new Set<string>([]);

function assertKnown(key: string): void {
  if (!KNOWN_KEYS_LIST.includes(key)) {
    throw new Error(
      `Unknown setting key "${key}". Register it in SETTING_KEYS in lib/settings/store.ts.`,
    );
  }
}

export async function getSetting(key: SettingKey | string): Promise<string | null> {
  assertKnown(key);
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  if (!row?.value) return null;
  if (!row.encrypted) return row.value;
  try {
    return decrypt(row.value);
  } catch (err) {
    // Do not let one unreadable secret take down an unrelated code path.
    console.error(`[settings] could not decrypt "${key}":`, (err as Error).message);
    return null;
  }
}

export async function setSetting(
  key: SettingKey | string,
  value: string,
  updatedBy: string | null = null,
): Promise<void> {
  assertKnown(key);
  const shouldEncrypt = ENCRYPTED_KEYS.has(key);
  const stored = shouldEncrypt ? encrypt(value) : value;

  await db
    .insert(settings)
    .values({ key, value: stored, encrypted: shouldEncrypt, updatedBy })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: stored, encrypted: shouldEncrypt, updatedBy, updatedAt: new Date() },
    });
}

/** Read a number with a default. Bad values fall back rather than throw. */
export async function getNumberSetting(key: SettingKey, fallback: number): Promise<number> {
  const raw = await getSetting(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function getBoolSetting(key: SettingKey, fallback = false): Promise<boolean> {
  const raw = await getSetting(key);
  return raw === null ? fallback : raw === "true";
}
