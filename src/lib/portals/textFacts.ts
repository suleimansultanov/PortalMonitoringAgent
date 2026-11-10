/**
 * Facts an advert states in its prose that its page leaves out of the fields.
 *
 * Read only where the field is empty, and only in the one phrasing that cannot
 * mean anything else: a living area is "N m² habitables" / "surface habitable de
 * N m²". "Villa de 250 m²" is not read — it is as often the plot, the terrace or
 * the whole estate. On 2026-11-10, 81 of the 1 212 live rows with no area said
 * it this way (Green-Acres: "La bâtisse de 160M² habitables"); the rest need a
 * reader that understands the sentence, not a pattern.
 */

const plain = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** 160, 1 200, 85,5 — a number as French adverts write one. */
const NUMBER = String.raw`(\d{1,2}[ \u00a0.]\d{3}|\d{1,4}(?:[.,]\d{1,2})?)`;
// No `\b` after "²": it is not a word character, so a boundary never follows it.
const SQM = String.raw`\s*m(?:²|2|\s?carres?)(?![a-z0-9])`;
const PATTERNS = [
  new RegExp(`${NUMBER}${SQM}\\s*(?:environ\\s+)?(?:habitables?|de surface habitable|de surface de plancher habitable)`),
  new RegExp(`surface\\s+habitable\\s*(?:de|:|d'environ|d’environ|environ|d'env\\.?)?\\s*(?:environ\\s+)?${NUMBER}${SQM}`),
];

const MIN_M2 = 10;
const MAX_M2 = 2000;

/** The living area an advert states in words, or null. The first statement wins: the main house comes before the annex. */
export function livingAreaFromText(...texts: (string | null | undefined)[]): number | null {
  const text = plain(texts.filter(Boolean).join(" \n "));
  let best: { at: number; value: number } | null = null;
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const value = Number(m[1].replace(/[ \u00a0]/g, "").replace(/\.(?=\d{3}\b)/, "").replace(",", "."));
    if (!Number.isFinite(value) || value < MIN_M2 || value > MAX_M2) continue;
    if (!best || m.index < best.at) best = { at: m.index, value };
  }
  return best?.value ?? null;
}

/**
 * An advert for a licence to sell alcohol, not for a property: "Licence IV à
 * vendre ou à louer", 250 €, Cavalaire (V1, 2026-11-10). The client's contract
 * refused its price as implausible and its card counted in the market. A bar
 * sold with its licence states premises — "BAR, LICENCE 4, EMPLACEMENT N°1",
 * 35 m² — and stays: only a title that STARTS with the licence and no area.
 */
export function licenceOnly(title: string | null | undefined, areaM2: number | null): boolean {
  if (!title || areaM2 !== null) return false;
  return /^\s*licen[cs]e\s+(?:iv|4|iii|3|grande)\b/.test(plain(title));
}

/**
 * A developer's programme page, not one property: "Les Hauts du Golfe", Cogolin,
 * at utopiaimmobilier.com/programmes/…, quoideneufimmo.fr/programmes/programme?…
 * and two more resellers of new builds, all through Stream.Estate (2026-11-10,
 * 18 live rows). Its price is the cheapest lot's or the whole development's, its
 * area the smallest lot's, and the same programme sits on three sites; when the
 * page changed from one to the other it read as a ×5 price jump on the client's
 * Data health. Kept like a home abroad, in no commune and on no card. Recognised
 * by a path segment named for it, never by a word in the advert: a lot inside a
 * programme ("Programme neuf", Bien'ici) is one property and stays.
 */
export function programmePage(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.split("/").some((seg) => /^programmes?$/i.test(seg));
  } catch {
    return false;
  }
}

