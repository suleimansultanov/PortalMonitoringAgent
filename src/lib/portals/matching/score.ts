import { containment, similarity, shingles } from "./text";

/**
 * Deciding whether two listings are one property.
 *
 * Pure and deterministic. Every merge this produces is written to the database
 * with its score and the signals behind it, because "why did you decide these
 * two are the same house" has to have an answer — and because a wrong merge is
 * only fixable if you can see what caused it.
 */

export type Candidate = {
  id: string;
  sourceId: string;
  communeInsee: string | null;
  priceEur: number | null;
  areaM2: number | null;
  rooms: number | null;
  agencyId: string | null;
  agencyRef: string | null;
  title: string | null;
  description: string | null;
};

export type MatchSignals = {
  agencyRefExact?: boolean;
  agencyRefConflict?: boolean;
  textContainment?: number;
  textJaccard?: number;
  priceEqual?: boolean;
  priceDelta?: number;
  areaClose?: boolean;
  roomsEqual?: boolean;
  communeConflict?: boolean;
  /** Shingles on the shorter side — the divisor containment is computed over. */
  textShingles?: number;
  /** Too little prose for similarity to mean anything. See MIN_SHINGLES. */
  textTooShort?: boolean;
  /** Prices too far apart to be one property, whatever the text says. */
  priceConflict?: boolean;
};

export type MatchVerdict = {
  same: boolean;
  confidence: number;
  signals: MatchSignals;
};

/** Portals round floor area differently — 240,62 becomes 241 or 240. */
const AREA_TOLERANCE = 0.03;
/** Below this, no amount of corroboration makes two listings the same property. */
const TEXT_FLOOR = 0.45;
/** Above this, the same prose is the same listing. */
const TEXT_STRONG = 0.75;

/**
 * A text has to be long enough for its similarity to mean anything.
 *
 * Containment is |A∩B| / min(|A|,|B|). With three shingles on each side, two
 * listings that happen to share a stock phrase — "villa vue mer proche plage" —
 * score a perfect 1.0. That is not evidence; it is an artefact of the divisor.
 *
 * THIS IS NOT HYPOTHETICAL. Green-Acres was parsed from `og:description`, a
 * social-sharing teaser with a median length of 49 characters, and the result
 * on a full commune was a single "property" holding 47 listings priced from
 * €739k to €7.8M, chained together transitively through dozens of accidental
 * perfect matches.
 *
 * Twelve shingles is roughly sixteen words — a real sentence of description,
 * not a headline. Below that the text signal is discarded entirely rather than
 * merely discounted, because a fabricated 1.0 is worse than no signal at all.
 */
const MIN_SHINGLES = 12;

/**
 * Is this string plausibly a mandate reference, or a word that landed in the
 * field by accident?
 *
 * The exact-reference rule is the strongest in the matcher: same agency, same
 * reference, merged at 100% with no threshold and no price check. That power is
 * only safe while the value really is a key. A Superimmo parser bug once put
 * the literal word "VILLA" in this field for three different villas, and
 * "SWI" for five — eight properties became two, priced €5.49M to €9.95M, all at
 * "100% confidence".
 *
 * The parser is fixed. This is the second lock, because the next portal will
 * have its own version of that bug and it must not cost a property.
 *
 * A digit is the test. Every genuine reference seen across the portals carries
 * one — 313688, V1958, 6138-NGU, MPNO-A4I-P8D — and the accidents never do,
 * because they are words. A bare date is excluded too: "2025-09-12" has digits
 * and is still not a key.
 */
export function looksLikeMandateRef(ref: string): boolean {
  const value = ref.trim();
  if (value.length < 3) return false;
  if (!/\d/.test(value)) return false;
  // A date is a date, whoever put it in the reference field.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{2}\/\d{2}\/\d{4}$/.test(value)) return false;
  return true;
}

export function scoreMatch(a: Candidate, b: Candidate): MatchVerdict {
  const signals: MatchSignals = {};

  // ── 1. The exact key, when both sides have one worth trusting ──────────
  if (
    a.agencyId &&
    b.agencyId &&
    a.agencyId === b.agencyId &&
    a.agencyRef &&
    b.agencyRef &&
    looksLikeMandateRef(a.agencyRef) &&
    looksLikeMandateRef(b.agencyRef)
  ) {
    if (a.agencyRef.trim().toLowerCase() === b.agencyRef.trim().toLowerCase()) {
      signals.agencyRefExact = true;
      return { same: true, confidence: 1, signals };
    }
    /**
     * Same agency, different mandate numbers. That is the agency itself telling
     * us these are two properties, and it outranks any amount of shared prose —
     * agencies reuse whole paragraphs between neighbouring villas.
     */
    signals.agencyRefConflict = true;
    return { same: false, confidence: 0, signals };
  }

  // ── 2. Cheap vetoes ────────────────────────────────────────────────────
  if (a.communeInsee && b.communeInsee && a.communeInsee !== b.communeInsee) {
    signals.communeConflict = true;
    return { same: false, confidence: 0, signals };
  }

  // ── 3. Text ────────────────────────────────────────────────────────────
  const textA = [a.title, a.description].filter(Boolean).join(" ");
  const textB = [b.title, b.description].filter(Boolean).join(" ");

  /**
   * Containment, not Jaccard, is the deciding number. Portals truncate the
   * agency's text at different lengths, and Jaccard reads a truncation as a
   * disagreement. Jaccard is still recorded — it is the better description of
   * how alike two full texts are, and worth having when reviewing a merge.
   */
  /**
   * Both texts must be substantial before their similarity counts.
   *
   * Checked on the SHORTER side, because containment divides by it — that is
   * precisely where a tiny text manufactures a perfect score.
   */
  const shortest = Math.min(shingles(textA).size, shingles(textB).size);
  signals.textShingles = shortest;
  if (shortest < MIN_SHINGLES) {
    signals.textTooShort = true;
    return { same: false, confidence: 0, signals };
  }

  const cont = containment(textA, textB);
  const jac = similarity(textA, textB);
  signals.textContainment = round(cont);
  signals.textJaccard = round(jac);

  if (cont < TEXT_FLOOR) return { same: false, confidence: round(cont), signals };

  // ── 4. Corroboration ───────────────────────────────────────────────────
  let support = 0;

  if (a.priceEur !== null && b.priceEur !== null) {
    const delta = Math.abs(a.priceEur - b.priceEur) / Math.max(a.priceEur, b.priceEur);
    signals.priceDelta = round(delta);
    signals.priceEqual = a.priceEur === b.priceEur;

    if (a.priceEur === b.priceEur) support += 0.15;
    else if (delta <= 0.02) support += 0.08;
    /**
     * A price disagreement does NOT veto. Agencies update one portal and forget
     * another routinely, so the same villa genuinely sits at two prices for
     * weeks. Vetoing on price would split exactly the properties whose price
     * history we most want — the ones being repriced.
     */
    else if (delta > 0.25) support -= 0.1;
  }

  if (a.areaM2 !== null && b.areaM2 !== null) {
    const delta = Math.abs(a.areaM2 - b.areaM2) / Math.max(a.areaM2, b.areaM2);
    signals.areaClose = delta <= AREA_TOLERANCE;
    if (signals.areaClose) support += 0.1;
    else if (delta > 0.15) support -= 0.1;
  }

  if (a.rooms !== null && b.rooms !== null) {
    signals.roomsEqual = a.rooms === b.rooms;
    support += a.rooms === b.rooms ? 0.05 : -0.05;
  }

  const confidence = clamp(cont + support);

  /**
   * Prose is never enough ON ITS OWN. Something measurable has to agree.
   *
   * The previous rule let a containment of 0.75 merge with no corroboration at
   * all, on the theory that identical prose means an identical listing. That
   * holds when the prose is the agency's own paragraph and fails completely
   * when it is a headline — and it is not the parser's job to guarantee the
   * matcher gets good input.
   *
   * "Agreeing" means price or floor area, not merely the absence of a
   * disagreement: two listings with no price on either side corroborate
   * nothing. A hard veto on strong conflicts sits below.
   */
  const corroborated = signals.priceEqual === true || signals.areaClose === true;

  /**
   * A large price gap vetoes outright, however similar the text.
   *
   * Softer than it sounds: an agency updating one portal and forgetting another
   * moves a price by a few percent, and that still merges. A factor of two is
   * not a stale listing — it is a different house sharing a template.
   */
  if (signals.priceDelta !== undefined && signals.priceDelta > 0.35) {
    signals.priceConflict = true;
    return { same: false, confidence: 0, signals };
  }

  const same =
    corroborated && (cont >= TEXT_STRONG ? confidence >= 0.7 : confidence >= 0.8);

  return { same, confidence: round(confidence), signals };
}

/**
 * Which pairs are worth scoring at all.
 *
 * Comparing every listing to every other is quadratic, and at a few thousand
 * listings across thirteen portals that is millions of shingle comparisons a
 * night. Blocking cuts it to pairs that could plausibly match: same commune, or
 * one of them unplaced.
 */
export function blockKey(c: Candidate): string {
  return c.communeInsee ?? "unknown";
}

export function candidatePairs(candidates: Candidate[]): [Candidate, Candidate][] {
  const blocks = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = blockKey(c);
    const list = blocks.get(key);
    if (list) list.push(c);
    else blocks.set(key, [c]);
  }

  const unknown = blocks.get("unknown") ?? [];
  const pairs: [Candidate, Candidate][] = [];

  for (const [key, list] of blocks) {
    // Everything inside a commune against everything else inside it.
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) pairs.push([list[i], list[j]]);
    }
    // Unplaced listings are compared against every commune, because "unknown"
    // is a parse gap, not a location.
    if (key !== "unknown") {
      for (const u of unknown) for (const c of list) pairs.push([u, c]);
    }
  }

  return pairs;
}

/**
 * Union-find over the pairs that matched.
 *
 * Transitivity matters here: if A matches B and B matches C, all three are one
 * property even when A and C never scored above the threshold themselves —
 * which happens when one portal truncated the description and another rewrote
 * the title.
 */
export function cluster(
  ids: string[],
  matches: [string, string][],
): Map<string, string> {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression, so repeated lookups stay flat.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  for (const [a, b] of matches) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const out = new Map<string, string>();
  for (const id of ids) out.set(id, find(id));
  return out;
}

/**
 * A cluster has to be internally plausible, not merely pairwise-plausible.
 *
 * Union-find is transitive by design: A–B and B–C makes {A,B,C} even though A
 * and C were never compared favourably. That is correct when the links are
 * strong and catastrophic when one is wrong — a single bad edge welds two
 * blobs together, and each new bad edge doubles the damage.
 *
 * This is the last line of defence, and it is deliberately blunt: whatever the
 * pairwise scores said, a group whose prices span more than this is not one
 * house. It ran for real — 47 listings from €739k to €7.8M in one "property" —
 * and no amount of tuning the pair rules removes the need for a check on the
 * result.
 *
 * Returns the ids that must be split back out, keeping the largest coherent
 * subgroup around the median price. Splitting to singletons would be safer
 * still, but would also discard the genuine merges caught in the same net.
 */
const CLUSTER_PRICE_SPAN = 0.35;

export function incoherentMembers(
  members: { id: string; priceEur: number | null }[],
): string[] {
  const priced = members.filter((m) => m.priceEur !== null) as {
    id: string;
    priceEur: number;
  }[];
  if (priced.length < 2) return [];

  const sorted = priced.map((m) => m.priceEur).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return [];

  const span = (sorted[sorted.length - 1] - sorted[0]) / sorted[sorted.length - 1];
  if (span <= CLUSTER_PRICE_SPAN) return [];

  // Keep what sits near the median; evict the rest to be properties of their own.
  const outliers = priced
    .filter((m) => Math.abs(m.priceEur - median) / Math.max(m.priceEur, median) > CLUSTER_PRICE_SPAN)
    .map((m) => m.id);
  if (outliers.length > 0) return outliers;

  /**
   * The span says the group is incoherent, but no single member is far enough
   * from the median to be thrown out. Three listings at €5.49M, €6.99M and
   * €9.95M do exactly this: the ends are 45% apart, while each of them sits
   * within 30% of the €6.99M in the middle.
   *
   * Reporting incoherence and then evicting nobody is the worst of both — the
   * guard appears to have run and the group survives intact. So split at the
   * widest relative gap instead and keep the side holding the median. It always
   * removes something, which is the point: a wrong split shows a duplicate, a
   * wrong merge hides a property.
   */
  let gapAt = 1;
  let widest = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] - sorted[i - 1]) / sorted[i];
    if (gap > widest) {
      widest = gap;
      gapAt = i;
    }
  }

  const medianIsAbove = median >= sorted[gapAt];
  return priced
    .filter((m) => (medianIsAbove ? m.priceEur < sorted[gapAt] : m.priceEur >= sorted[gapAt]))
    .map((m) => m.id);
}

function round(n: number): number {
  return Number(n.toFixed(3));
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
