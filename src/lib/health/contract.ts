import type { ListingPayload, PropertyPayload } from "@/lib/api/v1";

/**
 * What the client's app refuses or mends in our feed, before it stores a row.
 *
 * Vault runs every property we serve through a "data contract" and files each
 * deviation in `market_quarantine`, which is what its "Values refused or mended"
 * check counts. This is that contract as of vault eaed31c, with one thing
 * missing and one thing added.
 *
 * MISSING: "kept the last good value". Vault compares each read with the last
 * one it stored, so a value that vanished keeps the old figure. We serve only
 * the current read, so those rows (under 6 % of the 887 on 2026-11-03) cannot be
 * reproduced here, and neither can the ×5 price hold.
 *
 * ADDED: `origin`. Vault files a deviation under `leadSource`, the listing seen
 * most recently, whoever supplied the value. On 2026-11-03 that put one
 * Etreproprio fault under SeLoger, Leboncoin and ten others. The report names
 * both, because the portal on the client's screen is rarely the one to fix.
 */

export type FeedListing = Pick<
  ListingPayload,
  "source" | "via" | "url" | "priceEur" | "areaM2" | "bedrooms" | "firstSeenAt" | "lastSeenAt" | "sourceUpdatedAt" | "characteristics"
>;

export type FeedProperty = Pick<
  PropertyPayload,
  "id" | "title" | "description" | "priceEur" | "areaM2" | "bedrooms" | "propertyType" | "communeInsee" | "imageUrl" | "imageUrls"
> & { listings: FeedListing[] };

export type IssueAction = "repaired" | "dropped" | "flagged";
export type IssueField = "price" | "listing.price" | "area" | "listing.area" | "photos" | "cover" | "title" | "description";

export type Issue = {
  field: IssueField;
  /** The portal vault files it under. */
  reportedAs: string | null;
  action: IssueAction;
  reason: string;
  bad: string | null;
};

const PRICE_MIN = 1_000;
const PRICE_MAX = 200_000_000;
const AREA_MIN = 5;
const AREA_MAX = 200_000;

const goodPrice = (n: number) => Number.isFinite(n) && n >= PRICE_MIN && n <= PRICE_MAX;
const goodArea = (n: number) => Number.isFinite(n) && n >= AREA_MIN && n <= AREA_MAX;
const isHttps = (u: string) => u.startsWith("https://");

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

/** A listing whose page says "1 324 sq ft" and whose area is stored as 1324 m² (Green-Acres, late September). */
export function sqftAsM2(area: number | null, characteristics: { label: string; value: string }[]): boolean {
  if (area === null || !Number.isFinite(area) || area <= 0) return false;
  const text = characteristics.map((c) => `${c.label} ${c.value}`).join(" ");
  for (const m of text.matchAll(/(\d[\d\s  .,]*\d|\d)\s?sq\.?\s?ft/gi)) {
    const n = Number(m[1].replace(/[^\d]/g, ""));
    if (Number.isFinite(n) && Math.abs(n - area) < 1) return true;
  }
  return false;
}

/** The portal vault names for a property-level value: its most recently seen listing. */
export function leadSource(listings: FeedListing[]): string | null {
  let best: FeedListing | null = null;
  for (const l of listings) if (!best || String(l.lastSeenAt ?? "") > String(best.lastSeenAt ?? "")) best = l;
  return best?.source ?? null;
}

export function contractIssues(p: FeedProperty): Issue[] {
  const issues: Issue[] = [];
  const src = leadSource(p.listings);
  const add = (field: IssueField, reportedAs: string | null, action: IssueAction, reason: string, bad: unknown) =>
    issues.push({ field, reportedAs, action, reason, bad: bad === null || bad === undefined ? null : String(bad).slice(0, 160) });

  if (p.priceEur !== null && !goodPrice(p.priceEur)) add("price", src, "dropped", "price outside the plausible range", p.priceEur);

  for (const l of p.listings) {
    if (l.priceEur !== null && !goodPrice(l.priceEur)) add("listing.price", l.source, "dropped", "listing price outside the plausible range", l.priceEur);
    if (sqftAsM2(l.areaM2, l.characteristics)) add("listing.area", l.source, "repaired", "area given in sq ft and stored as m²", l.areaM2);
  }

  if (p.areaM2 !== null) {
    if (p.listings.some((l) => sqftAsM2(p.areaM2, l.characteristics))) add("area", src, "repaired", "area given in sq ft and stored as m²", p.areaM2);
    else if (!goodArea(p.areaM2)) add("area", src, "dropped", `area outside ${AREA_MIN}–${AREA_MAX} m²`, p.areaM2);
  }

  const notHttps = p.imageUrls.filter((u) => !isHttps(u));
  if (notHttps.length > 0) add("photos", src, "dropped", `${notHttps.length} photo URL(s) not https`, notHttps[0]);
  if (p.imageUrl && !isHttps(p.imageUrl)) add("cover", src, p.imageUrls.some(isHttps) ? "repaired" : "dropped", "cover photo URL not https", p.imageUrl);

  for (const field of ["title", "description"] as const) {
    const text = p[field];
    if (!hasMojibake(text)) continue;
    if (unrepairable(text)) add(field, src, "flagged", "text garbled (UTF-8 read as Latin-1); could not repair", text);
    else add(field, src, "repaired", "text garbled (UTF-8 read as Latin-1)", text);
  }
  return issues;
}

/**
 * The bedroom count a portal prints beside an empty field. Vault fills a null
 * from this before it stores the row ("Chambres: 4 chambres"), so a check of
 * missing bedrooms has to as well, or it counts rows the client does not.
 */
export function bedroomsFromLabels(listings: FeedListing[]): number | null {
  for (const l of listings) {
    for (const c of l.characteristics) {
      if (!/^\s*(chambres?|bedrooms?)\s*$/i.test(c.label)) continue;
      if (/^\s*studio\b/i.test(c.value)) return 1;
      const n = Number(/(\d{1,3})/.exec(c.value)?.[1] ?? NaN);
      if (Number.isFinite(n) && n > 0 && n < 100) return n;
    }
  }
  return null;
}
