/**
 * The Gulf of Saint-Tropez, as Med-Estates asked for it — and as France
 * actually divides it, which is not the same thing.
 *
 * THREE OF THE FOURTEEN ARE NOT COMMUNES.
 *
 * Port Grimaud is a district of Grimaud. Marines de Cogolin is a district of
 * Cogolin. Les Issambres is a locality inside Roquebrune-sur-Argens, which is a
 * different commune entirely and one nobody put on the list.
 *
 * This matters twice over. A portal filtered by INSEE code will return the
 * whole of Roquebrune-sur-Argens when asked for Les Issambres — most of which
 * is inland and not what the client means. And a client asking "how many
 * listings in Port Grimaud" gets an answer about Grimaud unless we keep the
 * district distinction.
 *
 * So: collection is keyed on INSEE (12 codes), display and filtering keep the
 * client's fourteen labels, and the locality ones carry a text match against
 * the listing's own wording. It is imperfect — an agency that writes
 * "Grimaud" for a Port Grimaud marina flat will be filed under Grimaud — but
 * it is honest, and the alternative is a number that quietly means something
 * else.
 */

export type CommuneEntry = {
  /** The label the client uses. */
  label: string;
  /** INSEE code of the commune this falls in. */
  insee: string;
  /** Set when the label is a district rather than a commune of its own. */
  localityOf?: string;
  /**
   * Lowercase fragments that identify this locality inside a larger commune.
   * Only consulted for locality entries.
   */
  localityMatch?: string[];
};

export const GULF_OF_SAINT_TROPEZ: CommuneEntry[] = [
  { label: "Grimaud", insee: "83068" },
  {
    label: "Port Grimaud",
    insee: "83068",
    localityOf: "Grimaud",
    localityMatch: ["port grimaud", "port-grimaud"],
  },
  { label: "Saint-Tropez", insee: "83119" },
  { label: "Cogolin", insee: "83042" },
  {
    label: "Marines de Cogolin",
    insee: "83042",
    localityOf: "Cogolin",
    localityMatch: ["marines de cogolin", "les marines"],
  },
  {
    label: "Les Issambres",
    insee: "83107",
    localityOf: "Roquebrune-sur-Argens",
    /**
     * The agencies also write the locality by its parts. Val d'Esquières and
     * San Peïre are inside Les Issambres; La Garonnette is not listed because
     * it straddles the border with Sainte-Maxime. Bien'ici labels a listing
     * "Roquebrune-sur-Argens - Val d'Esquières - Port" (2026-10-07) and on
     * "issambres" alone it went unfiled.
     */
    localityMatch: ["issambres", "esquieres", "san peire"],
  },
  { label: "Sainte-Maxime", insee: "83115" },
  { label: "Gassin", insee: "83065" },
  { label: "Ramatuelle", insee: "83101" },
  { label: "La Croix-Valmer", insee: "83048" },
  { label: "Cavalaire-sur-Mer", insee: "83036" },
  /**
   * 83079, corrected 2026-08-30. It was 83078 for the whole of this project's
   * life, and 83078 is Moissac-Bellevue — an inland village eighty kilometres
   * away with no connection to the Gulf.
   *
   * How it was caught is the useful part. The wrong code broke nothing visible:
   * every portal is crawled by ITS OWN slug ("la-mole"), so the listings were
   * always the right ones, filed under a label nobody read. It surfaced only
   * when Figaro — the one portal that publishes real INSEE codes rather than
   * names — answered "83079" and the adapter's own check said the two did not
   * agree. Confirmed against insee.fr before changing anything.
   *
   * It would have become visible, expensively, the moment anything joined on
   * this code: DVF transaction prices for Moissac-Bellevue against La Môle's
   * listings would have looked like a market, not like a bug.
   */
  { label: "La Môle", insee: "83079" },
  { label: "La Garde-Freinet", insee: "83063" },
  { label: "Le Plan-de-la-Tour", insee: "83094" },
];

/**
 * Distinct INSEE codes to collect. Twelve, not fourteen.
 *
 * All twelve verified. Ten were read straight out of Etreproprio's own URLs,
 * which embed the INSEE code (`...-v83119/`). The remaining two were checked
 * against insee.fr on 2026-08-30: Roquebrune-sur-Argens is 83107 as recorded,
 * and La Môle is 83079 — it had been 83078, which is Moissac-Bellevue. See the
 * note on La Môle above for how a wrong code hides.
 */
export const COLLECTION_INSEE: string[] = [
  ...new Set(GULF_OF_SAINT_TROPEZ.map((c) => c.insee)),
];

/** Strip accents, punctuation and case so portal spellings compare equal. */
export function normaliseCommuneName(raw: string): string {
  return raw
    .normalize("NFD")
    // Combining diacritics, written as escapes rather than literal marks —
    // literal ones are invisible in a diff and get mangled by editors.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_NORMALISED = new Map<string, CommuneEntry>();
for (const entry of GULF_OF_SAINT_TROPEZ) {
  BY_NORMALISED.set(normaliseCommuneName(entry.label), entry);
}
// Spellings portals actually use that do not match the canonical label.
for (const [alias, label] of [
  ["st tropez", "Saint-Tropez"],
  ["sainte maxime", "Sainte-Maxime"],
  ["ste maxime", "Sainte-Maxime"],
  ["la mole", "La Môle"],
  ["plan de la tour", "Le Plan-de-la-Tour"],
  ["croix valmer", "La Croix-Valmer"],
  ["garde freinet", "La Garde-Freinet"],
  ["ramatuel", "Ramatuelle"],
] as const) {
  const entry = GULF_OF_SAINT_TROPEZ.find((c) => c.label === label);
  if (entry) BY_NORMALISED.set(alias, entry);
}

/** Every name that points at an entry: its label, the spellings above, its locality fragments. */
const NAMES: { name: string; entry: CommuneEntry }[] = [
  ...[...BY_NORMALISED].map(([name, entry]) => ({ name, entry })),
  ...GULF_OF_SAINT_TROPEZ.flatMap((entry) => (entry.localityMatch ?? []).map((frag) => ({ name: normaliseCommuneName(frag), entry }))),
];

/** The entry named first in a normalised text, as whole words; the longer name on a tie, so "port grimaud" beats "grimaud". */
function firstNamed(text: string, keep: (e: CommuneEntry) => boolean = () => true): CommuneEntry | null {
  const hay = ` ${text} `;
  let best: { at: number; length: number; entry: CommuneEntry } | null = null;
  for (const { name, entry } of NAMES) {
    if (!keep(entry)) continue;
    const at = hay.indexOf(` ${name} `);
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && name.length > best.length)) best = { at, length: name.length, entry };
  }
  return best?.entry ?? null;
}

/** A district of the commune already settled on, if the text names one: "Grimaud" and "appartement Port Grimaud". */
function districtOf(commune: CommuneEntry, text: string): CommuneEntry {
  if (commune.localityOf) return commune;
  return firstNamed(text, (e) => e.insee === commune.insee && !!e.localityOf) ?? commune;
}

/**
 * Where a listing is, from what it states.
 *
 * THE PORTAL'S STATEMENT OF PLACE OUTRANKS ANYTHING THE ADVERT SAYS ABOUT ITSELF.
 * Adverts name their neighbours: "à 15 minutes de Saint-Tropez", "proche de Port
 * Grimaud". This used to look for a commune in the place and the text together,
 * taking the first of its own list, and Saint-Tropez comes before Sainte-Maxime.
 * Any stated place that was not a commune's bare name fell into that search, and
 * Bien'ici's all are not: "Sainte-Maxime - Sémaphore - Nartelle". 362 of its 3 032
 * live rows were filed under a commune they do not state, 229 of them under
 * Saint-Tropez, and the client found them by clicking through (2026-11-05). A row
 * in the wrong commune also never merges with the same house in the right one.
 *
 * So: the first commune the stated place names; then the postcode, which is coarse
 * but cannot be flattery. A place we do not watch is an answer, not a gap ("Vidauban",
 * or "Roquebrune-sur-Argens - Village" at 83520): it stays unfiled, whatever its text
 * mentions. The text is read only for a district of the commune already settled on,
 * to choose among communes sharing a postcode, and when nothing at all was stated.
 *
 * Roquebrune-sur-Argens is watched in part: Les Issambres. Its name alone does not
 * put a listing there, and neither does postcode 83380, which Bien'ici also prints on
 * "Roquebrune-sur-Argens - Village". It takes the district named, and never at 83520.
 */
export function resolveCommune(
  communeRaw: string | null,
  postalCode: string | null,
  freeText?: string | null,
): CommuneEntry | null {
  const stated = normaliseCommuneName(communeRaw ?? "");
  const text = normaliseCommuneName(freeText ?? "");
  const postal = postalCode?.trim() || null;

  const named = firstNamed(stated);
  if (named) return districtOf(named, text);

  if (stated.includes("roquebrune")) {
    return !postal || postal === "83380" ? firstNamed(text, (e) => e.insee === "83107") : null;
  }

  const byPost = postal ? POSTCODE_TO_INSEE[postal] : undefined;
  if (byPost && postal) {
    const shared = SHARED_POSTCODES[postal];
    const chosen = shared ? firstNamed(text, (e) => !e.localityOf && shared.includes(e.insee)) : null;
    const commune = chosen ?? GULF_OF_SAINT_TROPEZ.find((c) => c.insee === byPost && !c.localityOf) ?? null;
    return commune && districtOf(commune, text);
  }

  // A place we do not watch stays unfiled. Nothing stated at all: only a district is specific enough to mean itself.
  return stated ? null : firstNamed(text, (e) => !!e.localityOf);
}

/** Communes sharing a postcode, where the first is what the postcode alone resolves to. */
const SHARED_POSTCODES: Record<string, string[]> = {
  "83310": ["83068", "83042", "83079"], // Grimaud, Cogolin, La Môle
  "83120": ["83115", "83094"], // Sainte-Maxime, Le Plan-de-la-Tour
};

/** Postcodes are not one-to-one with communes — Grimaud and Cogolin share 83310. */
const POSTCODE_TO_INSEE: Record<string, string> = {
  "83990": "83119", // Saint-Tropez
  "83350": "83101", // Ramatuelle
  "83580": "83065", // Gassin
  "83120": "83115", // Sainte-Maxime
  "83420": "83048", // La Croix-Valmer
  "83240": "83036", // Cavalaire-sur-Mer
  "83310": "83068", // Grimaud, Cogolin AND La Môle — ambiguous, prefer the name
  /**
   * 83680 is LA GARDE-FREINET, not La Môle.
   *
   * Corrected 2026-08-29 against Superimmo's own commune URLs, read the same
   * day: `la-garde-freinet-83680` and `la-mole-83310`. La Môle shares 83310
   * with Cogolin and Grimaud, which is also why it cannot be resolved by
   * postcode at all and has been moved into the ambiguous line above.
   *
   * The old entry sent every listing resolved by this postcode to a commune
   * roughly twenty kilometres away — silently, since a listing filed under the
   * wrong commune looks exactly like a listing.
   */
  "83680": "83063", // La Garde-Freinet
};

/**
 * Tonight's slice of a commune list, chosen by the date.
 *
 * Pure, and here rather than in `nightly.ts`, because `nightly.ts` cannot be
 * imported without a database and a rotation nobody can test is how a rotation
 * silently sticks on the same three communes for a month.
 *
 * WHY THE CALENDAR AND NOT "WHICHEVER WAS COLLECTED LONGEST AGO". The obvious
 * version reads the last completed run per commune, and there is already a
 * `--stale` that does it. Its trap: it counts only runs that finished without
 * an error, and a pass that spends its fetch budget records one. A source that
 * spends its budget every night — which is Superimmo for the next week — would
 * have every commune permanently "never collected", so the query would return
 * the same first three every time and the rest would never come round.
 *
 * The day of the year has no state to corrupt. It cannot stick, a missed night
 * costs a slice one cycle rather than forever, and anyone can work out from the
 * date which communes a given night should have covered.
 *
 * Returns everything when the list is no longer than a night's worth, so a
 * small source is never split for no reason.
 */
export function communeSliceForDay(
  all: readonly string[],
  perNight: number,
  dayOfYear: number,
): string[] {
  if (perNight <= 0 || all.length === 0 || all.length <= perNight) return [...all];
  // Sorted, because the subscription order is whatever the rows came back in,
  // and a rotation over an unstable order revisits some communes twice a cycle
  // and others never.
  const ordered = [...all].sort();
  const slices = Math.ceil(ordered.length / perNight);
  const index = ((dayOfYear % slices) + slices) % slices;
  return ordered.slice(index * perNight, index * perNight + perNight);
}
