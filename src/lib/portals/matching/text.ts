/**
 * Comparing listing descriptions.
 *
 * The premise, verified on real pages: an agency writes the description once in
 * its CRM and it syndicates to every portal verbatim. `Réf 70880` from Swixim
 * appears with byte-identical prose on both SeLoger and Etreproprio — companies
 * with no relationship to each other. So the same property carries the same two
 * thousand characters across eight sites, and text similarity is a stronger
 * signal than coordinates would have been.
 */

/**
 * Text every French listing carries and no listing is identified by.
 *
 * This is the part that makes or breaks the whole approach. Legally mandated
 * boilerplate — the Géorisques notice, the brush-clearing obligation, the
 * agent's registration number — appears verbatim on thousands of unrelated
 * listings. Leave it in and two completely different villas score 40% similar
 * before anyone has said a word about the property. Every threshold would then
 * be tuned against noise.
 */
const BOILERPLATE: RegExp[] = [
  /les informations sur les risques auxquels ce bien est exposé[^.]*\./gi,
  /**
   * The URL is stripped on its own, and `www.` is optional on purpose.
   *
   * The sentence rule above ends at the first full stop — which, in
   * "…disponibles sur le site Géorisques : www.georisques.gouv.fr", is the dot
   * inside the URL. That leaves "georisques.gouv.fr" behind, and a pattern
   * requiring `www` would then miss it. This one catches whatever survives.
   */
  /(?:www\.)?georisques\.gouv\.fr/gi,
  /bien situé dans une zone soumise à l'obligation[^.]*\./gi,
  /propriété située dans une zone soumise à l'obligation[^.]*\./gi,
  /honoraires? (?:à la )?charge (?:du )?(?:vendeur|acquéreur)[^.]*\./gi,
  /copropriété de \d+ lots?[^.]*\./gi,
  /(?:no|n°)\s*rsac[^.\n]*/gi,
  /r[ée]seau immobilier [a-z]+\s*-\s*votre agent commercial[^.]*\./gi,
  /entrepreneur individuel[^.]*\./gi,
  /ce bien vous est propos[ée] par[^.]*\./gi,
  /cette annonce vous est propos[ée]e par[^.]*\./gi,
  /contactez[- ]nous[^.]*\./gi,
  /pour (?:toute )?informations? compl[ée]mentaires?[^.]*\./gi,
];

export function stripBoilerplate(text: string): string {
  let out = text;
  for (const re of BOILERPLATE) out = out.replace(re, " ");
  return out;
}

/**
 * Normalise for comparison: strip markup and accents, fold case, collapse
 * whitespace, and remove digits.
 *
 * Digits go because they are the thing most likely to differ between two
 * copies of the same listing — one portal rounds 240,62 m² to 241, another
 * converts the price, a third omits the reference. Keeping them punishes
 * matches for cosmetic differences. Price and area are compared separately, as
 * numbers, where a tolerance can be stated honestly.
 */
export function normaliseForCompare(raw: string): string {
  return stripBoilerplate(raw)
    .replace(/<[^>]+>/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SHINGLE_SIZE = 5;

/**
 * Word-level 5-grams.
 *
 * Five rather than three: French listing prose shares a lot of short phrases
 * ("au coeur du village", "vue mer panoramique") that say nothing about which
 * property this is. Three-word windows match on those and inflate every score.
 * Five is long enough that a shared window means a shared sentence.
 */
export function shingles(text: string, size = SHINGLE_SIZE): Set<string> {
  const words = normaliseForCompare(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (words.length < size) {
    // Too short to shingle. The whole thing becomes one token — a listing with
    // a ten-word description can still match an identical ten-word description.
    if (words.length > 0) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + size <= words.length; i++) {
    out.add(words.slice(i, i + size).join(" "));
  }
  return out;
}

/** Jaccard: shared windows over total distinct windows. */
export function similarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;

  let shared = 0;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const s of small) if (large.has(s)) shared += 1;

  return shared / (sa.size + sb.size - shared);
}

/**
 * Containment rather than Jaccard.
 *
 * Portals truncate. One shows the agency's full text, another cuts it at 300
 * characters with an ellipsis. Jaccard punishes that hard — the short version
 * shares everything it has, but the union is dominated by the long one — while
 * containment asks the more useful question: is the shorter text entirely
 * inside the longer one?
 */
export function containment(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;

  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let shared = 0;
  for (const s of small) if (large.has(s)) shared += 1;

  return shared / small.size;
}
