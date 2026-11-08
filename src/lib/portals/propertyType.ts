/**
 * One word per kind of property, the client's words.
 *
 * Every portal names the type in its own language and taxonomy — "House" and
 * "Apartment" (LuxuryEstate), "Villa" (Figaro Immobilier, JamesEdition),
 * "Demeure-de-prestige", "Local-commercial", "Immobilier", "Neuf" (Green-Acres,
 * Vizzit), "Programme neuf" (Bien'ici), "Landform", "Accommodation" — and the
 * client's app matches a buyer's search against the type BY EXACT WORD
 * (vault `matching.ts`, `propertyTypes.some(t => t.toLowerCase() === have…)`),
 * and a mismatch disqualifies. On 2026-11-08 a buyer asking for "Maison" was
 * therefore never shown 254 "Villa", 120 "House", 14 "Demeure-de-prestige"
 * cards, nor the 396 "Immobilier" ones that are mostly "Achat : Maison"; one
 * asking for "Appartement" never saw 53 "Apartment".
 *
 * So ingest stores one of CANONICAL_TYPES, the words the client's CRM uses, and
 * keeps the portal's own in `raw.propertyTypeRaw`. A specific type wins; a
 * generic one ("Immobilier", "Neuf", "Bien", "unknown", none) is read from the
 * title, the earliest kind it names; nothing named stays null — "not
 * published" does not disqualify a buyer, a wrong word does.
 *
 * The dedup predicates (`isFlat`, `isPlot`, `isPremises` in matching/score.ts)
 * are patterns over the same words, so they read these as they read the old.
 */

export const CANONICAL_TYPES = ["Maison", "Appartement", "Terrain", "Commerce", "Bureau", "Parking", "Immeuble"] as const;
export type CanonicalType = (typeof CANONICAL_TYPES)[number];

const KINDS: [CanonicalType, RegExp][] = [
  ["Appartement", /\b(appart\w*|apartment|flat|studio|duplex|triplex|loft|penthouse|[tf][1-7])\b/g],
  ["Maison", /\b(maisons?|house|villas?|demeure|propriete|bastide|mas|chateau|chalet|ferme|longere|hotelparticulier)\b/g],
  ["Terrain", /\b(terrains?|land\w*|plot|parcelle)\b/g],
  ["Commerce", /\b(commerces?|commercial|locaux|local|fonds|boutique|shop|restaurant|restauration|hotel|bar|droit au bail)\b/g],
  ["Bureau", /\b(bureaux?|office)\b/g],
  ["Parking", /\b(parking|garage|box|stationnement)\b/g],
  ["Immeuble", /\b(immeuble|building)\b/g],
];

/** Lower case, no accents, "hôtel particulier" as one word so it is a house and not a hotel. */
function plain(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/hotel\s+particulier/g, "hotelparticulier");
}

/** The kind named first in the text, or null when it names none. */
export function kindNamed(text: string | null | undefined): CanonicalType | null {
  if (!text) return null;
  const s = plain(text);
  let best: { kind: CanonicalType; at: number } | null = null;
  for (const [kind, re] of KINDS) {
    re.lastIndex = 0;
    const m = re.exec(s);
    if (m && (!best || m.index < best.at)) best = { kind, at: m.index };
  }
  return best?.kind ?? null;
}

/** The type the portal states if it is specific, else the one the title names, else null. */
export function canonicalPropertyType(stated: string | null | undefined, title: string | null | undefined): CanonicalType | null {
  return kindNamed(stated) ?? kindNamed(title);
}
