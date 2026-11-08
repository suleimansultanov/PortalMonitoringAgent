/**
 * Text that was UTF-8 and got read as Latin-1 somewhere upstream: "cœur" arrives
 * as "cÅ“ur", "m²" as "mÂ²", "à" as "Ã ". Not our reading: 2 451 Stream.Estate
 * titles with accents arrive clean, and so do 19 with a real "œ". It is the
 * advert itself, garbled before the portal published it (Stream.Estate's
 * SeLoger and Belles Demeures rows, the twimmo CRM feed on Bien'ici, V1
 * descriptions). On 2026-11-08: 75 listings, 18 titles on the client's cards.
 *
 * The client's app runs this same repair in its data contract (vault
 * `contract-pure.ts`) and counts every row it has to repair against us, so
 * ingest repairs the text first, with the same function, and `lib/health`
 * judges the feed with it. ONE PASS, NEVER TWO: a text garbled twice ("360ÃÂ°")
 * has lost a byte, and a second pass would turn it into "360ð". It is left as
 * it came and the contract flags it, which is the honest answer.
 */

/** One pattern for JavaScript and for Postgres `~`, so the feed check and the origin query agree. */
export const MOJIBAKE_PATTERN = String.raw`Ã[\u0080-¿€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]|â€|Å[’“”Ž]|Â[ -¿]`;
const MOJIBAKE_RE = new RegExp(MOJIBAKE_PATTERN);
export const hasMojibake = (s: string | null | undefined): boolean => !!s && MOJIBAKE_RE.test(s);

// The Windows-1252 characters for bytes 0x80–0x9F: what a UTF-8 continuation byte becomes when misread.
const CP1252: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b,
  "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99,
  "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
const byteOf = (ch: string): number | null => CP1252[ch] ?? (ch.charCodeAt(0) <= 0xff ? ch.charCodeAt(0) : null);
const CONT = "[\\u0080-\\u00BF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]";
// Only the lead bytes French text produces, so a legitimate "É’" is never touched.
const SEQ = new RegExp(`[\\u00C2\\u00C3\\u00C5]${CONT}|\\u00E2${CONT}{2}|\\u00F0${CONT}{3}`, "g");

/** Undo UTF-8 read as Latin-1, one character at a time, so a partly garbled text keeps the rest. */
export function repairMojibake(s: string): string {
  // "à" is C3 A0: misread, it is Ã and a no-break space, often normalised to a plain space on the way.
  return s.replace(/Ã /g, "Ã ").replace(SEQ, (m) => {
    const bytes = [...m].map(byteOf);
    if (bytes.some((b) => b === null)) return m;
    try {
      const out = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes as number[]));
      return out.length === 1 || (out.length === 2 && /[\uD800-\uDFFF]/.test(out)) ? out : m;
    } catch {
      return m;
    }
  });
}

/** Garbled, and still garbled after the repair: what vault's own count of garbled text is left with. */
export const unrepairable = (s: string | null | undefined): boolean => hasMojibake(s) && hasMojibake(repairMojibake(s ?? ""));

/** What ingest stores: the text as it came, unless one pass makes it readable. Null stays null. */
export function repairedText(s: string | null): string | null {
  if (s === null || !hasMojibake(s)) return s;
  return repairMojibake(s);
}
