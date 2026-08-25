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
    localityMatch: ["issambres"],
  },
  { label: "Sainte-Maxime", insee: "83115" },
  { label: "Gassin", insee: "83065" },
  { label: "Ramatuelle", insee: "83101" },
  { label: "La Croix-Valmer", insee: "83048" },
  { label: "Cavalaire-sur-Mer", insee: "83036" },
  { label: "La Môle", insee: "83078" },
  { label: "La Garde-Freinet", insee: "83063" },
  { label: "Le Plan-de-la-Tour", insee: "83094" },
];

/**
 * Distinct INSEE codes to collect. Twelve, not fourteen.
 *
 * VERIFY BEFORE PRODUCTION. Ten of these were read straight out of
 * Etreproprio's own URLs, which embed the INSEE code (`...-v83119/`), so they
 * are as good as confirmed. La Môle (83078) and Roquebrune-sur-Argens (83107)
 * were not, and should be checked against the official INSEE list before the
 * first real run — a wrong code fails silently as an empty commune.
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
] as const) {
  const entry = GULF_OF_SAINT_TROPEZ.find((c) => c.label === label);
  if (entry) BY_NORMALISED.set(alias, entry);
}

/**
 * Best-effort resolution of a listing's stated location.
 *
 * Checks locality fragments first: a listing that says "Port Grimaud" should
 * resolve to the district, not to Grimaud, even though both share an INSEE
 * code. Falls back to postcode, which is coarse but never wrong.
 */
export function resolveCommune(
  communeRaw: string | null,
  postalCode: string | null,
  freeText?: string | null,
): CommuneEntry | null {
  const haystack = normaliseCommuneName(`${communeRaw ?? ""} ${freeText ?? ""}`);

  for (const entry of GULF_OF_SAINT_TROPEZ) {
    if (!entry.localityMatch) continue;
    if (entry.localityMatch.some((frag) => haystack.includes(normaliseCommuneName(frag)))) {
      return entry;
    }
  }

  if (communeRaw) {
    const direct = BY_NORMALISED.get(normaliseCommuneName(communeRaw));
    if (direct) return direct;
    for (const [key, entry] of BY_NORMALISED) {
      if (haystack.includes(key)) return entry;
    }
  }

  if (postalCode) {
    const byPost = POSTCODE_TO_INSEE[postalCode.trim()];
    if (byPost) return GULF_OF_SAINT_TROPEZ.find((c) => c.insee === byPost && !c.localityOf) ?? null;
  }

  return null;
}

/** Postcodes are not one-to-one with communes — Grimaud and Cogolin share 83310. */
const POSTCODE_TO_INSEE: Record<string, string> = {
  "83990": "83119", // Saint-Tropez
  "83350": "83101", // Ramatuelle
  "83580": "83065", // Gassin
  "83120": "83115", // Sainte-Maxime
  "83420": "83048", // La Croix-Valmer
  "83240": "83036", // Cavalaire-sur-Mer
  "83310": "83068", // Grimaud AND Cogolin — ambiguous, prefer the name
  "83680": "83078", // La Môle
};
