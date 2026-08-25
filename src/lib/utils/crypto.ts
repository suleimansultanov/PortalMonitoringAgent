import "server-only";
import crypto from "node:crypto";

/** AES-256-GCM for secrets at rest in the `settings` table. Ported from Vault. */

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32");
  }
  if (hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex string (64 chars).");
  }
  return Buffer.from(hex, "hex");
}

/** Encrypt plaintext into base64(iv | ciphertext | authTag). */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");
}

/**
 * Decrypt what encrypt() produced. Throws on tamper — and also throws with an
 * unhelpful "Unsupported state" if ENCRYPTION_KEY differs from the one used to
 * write the value. That is almost always the real cause, so say so.
 */
export function decrypt(payload: string): string {
  const key = getKey();
  const data = Buffer.from(payload, "base64");
  if (data.length < 12 + 16) throw new Error("ciphertext too short");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const enc = data.subarray(12, data.length - 16);
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new Error(
      "Failed to decrypt. The usual cause is ENCRYPTION_KEY differing between " +
        "environments that share this database — check local, preview and production match.",
      { cause: err },
    );
  }
}

/** Constant-time comparison. Use for tokens and secrets instead of `===`. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Stable hash of a fetched page body, for skipping unchanged pages. */
export function contentHash(body: string): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}
