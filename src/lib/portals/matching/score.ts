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
  landM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  propertyType: string | null;
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
  landClose?: boolean;
  roomsEqual?: boolean;
  communeConflict?: boolean;
  /** Shingles on the shorter side — the divisor containment is computed over. */
  textShingles?: number;
  /** Too little prose for similarity to mean anything. See MIN_SHINGLES. */
  textTooShort?: boolean;
  /** Prices too far apart to be one property, whatever the text says. */
  priceConflict?: boolean;
  /** Floor areas too far apart to be one property, beyond how portals round. */
  areaConflict?: boolean;
  /** Plots that disagree. Two listings on different land are different homes. */
  landConflict?: boolean;
  /**
   * Merged on measurements alone, with no help from the prose.
   *
   * Recorded rather than hidden: a merge reached this way rests on a different
   * kind of evidence, and anyone auditing a cluster deserves to know which. It
   * is also the flag to filter on when checking whether this rule is behaving.
   */
  structuralOnly?: boolean;
};

export type MatchVerdict = {
  same: boolean;
  confidence: number;
  signals: MatchSignals;
};

/** Portals round floor area differently — 240,62 becomes 241 or 240. */
const AREA_TOLERANCE = 0.03;
/** A flat's area is measured under the Carrez law, so it needs less room. */
const FLAT_AREA_TOLERANCE = 0.015;
/** Below this, no amount of corroboration makes two listings the same property. */
const TEXT_FLOOR = 0.45;
/**
 * Plot sizes are quoted from the cadastre, so they agree far more closely than
 * floor areas — but they are still rounded, and "environ 2 700 m²" in the prose
 * sits beside 2730 in the field. Wide enough for that, narrow enough that two
 * neighbouring plots do not pass for one.
 */
const LAND_TOLERANCE = 0.05;
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
/**
 * Is this an apartment rather than a house?
 *
 * The distinction earns its place because a DEVELOPMENT breaks every rule this
 * file relies on. Résidence Patio Ruben, Saint-Tropez, found on 2026-09-04:
 * thirty-four listings across six portals became one property, and inside it
 * were at least two different flats — a T3 of 81 m² at 2 350 000 € and a T4 of
 * 85 m² at 2 450 000 €.
 *
 * Nothing in the prose separates them. The developer writes one description for
 * the whole building, so text containment between two different flats is 1.0 —
 * not a near-miss, a perfect score. Nothing in the measurements separates them
 * either, once the areas are four square metres apart.
 *
 * A villa is unique; a flat in a block is one of many that are alike by design.
 * So flats get two extra tests below, and the type has to be known to apply
 * them. Each portal names the type in its own language, which is why this is a
 * pattern and not an enum.
 */
export function isFlat(propertyType: string | null): boolean {
  if (!propertyType) return false;
  return /appart|apartment|flat|studio|duplex|loft|penthouse|triplex/i.test(propertyType);
}

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

  // ── 2a. The price is the identity ──────────────────────────────────────
  /**
   * TWO PRICES THAT DIFFER ARE TWO PROPERTIES. No exceptions below this line.
   *
   * The rule used to be softer, and the reasoning was sound in isolation: an
   * agency updates one portal and forgets another, so the same villa genuinely
   * sits at two prices for a fortnight, and vetoing on price would split
   * exactly the properties whose price history is most worth having. The text
   * rules therefore tolerated a gap of up to a third.
   *
   * What that reasoning missed is the development. Résidence Patio Ruben,
   * Saint-Tropez, found on 2026-09-04: thirty-four listings across six portals
   * in one property, holding at least two different flats — 81 m² at
   * 2 350 000 € and 85 m² at 2 450 000 €. The developer writes ONE description
   * for the whole building, so the text similarity between two different flats
   * is not a near-miss, it is a perfect 1.0. Nothing in the prose can ever
   * separate them, and the only thing that does is the asking price: a
   * development prices a unit by its floor, its view, which way the terrace
   * faces.
   *
   * So price equality is now a precondition for every merge except one, and
   * the cost is accepted deliberately: a villa carrying a stale price on one
   * portal will show as two cards until that portal catches up. That is a
   * visible duplicate, which is the failure this project has always preferred
   * — a wrong split shows something twice, a wrong merge hides it entirely.
   *
   * THE EXCEPTION IS THE MANDATE REFERENCE, and it is above this block rather
   * than inside it: same agency, same mandate number is the agency itself
   * telling us these are one property, and a price that has not been updated
   * does not outrank that.
   */
  if (a.priceEur !== null && b.priceEur !== null && a.priceEur !== b.priceEur) {
    signals.priceConflict = true;
    signals.priceDelta = round(
      Math.abs(a.priceEur - b.priceEur) / Math.max(a.priceEur, b.priceEur),
    );
    return { same: false, confidence: 0, signals };
  }

  // ── 2a bis. And the floor area ─────────────────────────────────────────
  /**
   * A DISAGREEING FLOOR AREA VETOES TOO, on the same footing as the price.
   *
   * Same reasoning, same building: the flats in a development share their
   * description, and what separates them is the price and the size. Requiring
   * both to agree is what makes "the text says they are the same" safe again.
   *
   * NOT exact to the square metre, and that is not a compromise — it is what
   * the data is. One villa in Ramatuelle is published as 344,94 m² by the
   * portal that read the mandate, 345 by the portal that rounded it and 350 by
   * the portal that copied the headline. Demanding an exact match there would
   * split one house into three properties, which is the failure we are trying
   * to remove, not a stricter version of the rule.
   *
   * So: agreement inside the rounding, and nothing wider. Three per cent of a
   * villa is a few square metres; a flat gets half that, because a flat's area
   * is measured under the Carrez law and quoted identically everywhere.
   */
  if (a.areaM2 !== null && b.areaM2 !== null) {
    const delta = Math.abs(a.areaM2 - b.areaM2) / Math.max(a.areaM2, b.areaM2);
    const tolerance = isFlat(a.propertyType) || isFlat(b.propertyType) ? FLAT_AREA_TOLERANCE : AREA_TOLERANCE;
    if (delta > tolerance) {
      signals.areaClose = false;
      signals.areaConflict = true;
      return { same: false, confidence: 0, signals };
    }
  }

  // ── 2b. The measurements, for when the prose cannot speak ──────────────
  /**
   * THE SAME VILLA, DESCRIBED TWICE, MERGED ON ARITHMETIC ALONE.
   *
   * Everything below section 3 is gated behind a text similarity, and two
   * portals carrying one property do not always share a sentence. Two ways
   * that happens, both seen in the live data on 2026-09-04:
   *
   *   1. Different languages. LuxuryEstate publishes in English, every other
   *      portal here in French. "10 room luxury Villa for sale in Ramatuelle"
   *      and "Villa avec piscine et terrasse" have a containment of zero.
   *   2. Different agencies on one mandate. Ramatuelle, 25 000 000 €, 600 m²
   *      habitables, 2730 m² of land, 12 rooms, seven suites and a staff flat
   *      in both texts — and two entirely different paragraphs, two different
   *      photographs, two different mandate references, because two agencies
   *      are selling it. No text rule will ever join those, and they are one
   *      house.
   *
   * So wherever the text rules give up — too short to judge, or judged and
   * found unalike — the measurements get their own say. The conjunction is
   * what makes that safe: the price identical to the euro, the floor area
   * inside the rounding tolerance, the same commune, and — where both portals
   * state it — the same plot. A plot that disagrees is a veto rather than a
   * missing point, because two villas can share a price and a floor area and
   * cannot share the ground they stand on.
   *
   * Room counts deliberately do NOT veto. Portals disagree about what counts
   * as a room routinely — the pair above is 10 rooms on one portal and 12 on
   * another, and the same villa is "9 bedroom" on a third. Requiring them to
   * agree was the first version of this rule and it merged almost nothing.
   *
   * The way this is wrong is two identical units in one development: same
   * plot, same price, same size, genuinely different homes. That risk is real
   * and it is priced in — a market report that counts one villa twice is wrong
   * in a way the client sees immediately, and the flag below makes these
   * merges countable rather than invisible.
   */
  function structuralMatch(): MatchVerdict | null {
      const bothPriced = a.priceEur !== null && b.priceEur !== null;
    const bothSized = a.areaM2 !== null && b.areaM2 !== null;
    const placed = a.communeInsee !== null && b.communeInsee !== null;

    if (bothPriced && bothSized && placed) {
      const areaDelta = Math.abs(a.areaM2! - b.areaM2!) / Math.max(a.areaM2!, b.areaM2!);
      const landKnown = a.landM2 !== null && b.landM2 !== null;
      const landDelta = landKnown
        ? Math.abs(a.landM2! - b.landM2!) / Math.max(a.landM2!, b.landM2!)
        : null;

      // Both already checked above — a disagreement on either never gets here.
    if (a.priceEur === b.priceEur && areaDelta <= AREA_TOLERANCE) {
        if (landDelta !== null && landDelta > LAND_TOLERANCE) {
          signals.landConflict = true;
        } else {
          signals.priceEqual = true;
          signals.priceDelta = 0;
          signals.areaClose = true;
          signals.structuralOnly = true;
          if (landDelta !== null) signals.landClose = true;

          const roomsKnown = a.rooms !== null && b.rooms !== null;
          if (roomsKnown) signals.roomsEqual = a.rooms === b.rooms;

          /**
           * These sit at and above the default threshold on purpose. Two prices
           * equal to the euro and two floor areas inside the tolerance, in one
           * commune, is not weak evidence — it is three independent measurements
           * agreeing, which is more than most text-backed merges have.
           *
           * The plot is what lifts it: an agreeing plot is the strongest of the
           * four, because it is the one thing two different houses cannot share.
           * An operator who raises MATCH_THRESHOLD above 0.9 turns this rule off
           * entirely, and that is the intended way to turn it off.
           */
          let confidence = 0.8;
          if (signals.roomsEqual === true) confidence += 0.03;
          if (signals.landClose === true) confidence += 0.07;

          return { same: true, confidence: round(confidence), signals };
        }
      }
    }
    return null;
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
    return structuralMatch() ?? { same: false, confidence: 0, signals };
  }

  const cont = containment(textA, textB);
  const jac = similarity(textA, textB);
  signals.textContainment = round(cont);
  signals.textJaccard = round(jac);

  if (cont < TEXT_FLOOR) {
    return structuralMatch() ?? { same: false, confidence: round(cont), signals };
  }

  // ── 4. Corroboration ───────────────────────────────────────────────────
  let support = 0;

  if (a.priceEur !== null && b.priceEur !== null) {
    const delta = Math.abs(a.priceEur - b.priceEur) / Math.max(a.priceEur, b.priceEur);
    signals.priceDelta = round(delta);
    signals.priceEqual = a.priceEur === b.priceEur;

    // Anything reaching here has two equal prices or a price on one side only:
    // section 2a sent every disagreement home.
    if (a.priceEur === b.priceEur) support += 0.15;
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

  const same =
    corroborated && (cont >= TEXT_STRONG ? confidence >= 0.7 : confidence >= 0.8);

  /**
   * Text first, measurements second. Where the prose does carry the merge it
   * also scores it, and it scores it higher — the structural rule is the floor
   * under the text rules, never a ceiling over them.
   */
  if (!same) return structuralMatch() ?? { same, confidence: round(confidence), signals };

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

/**
 * And above this spread in floor area, whatever the prices say.
 *
 * Tighter than the price rule on purpose. A price legitimately differs between
 * portals — one is stale, one is negotiated — while a villa's floor area is
 * the same number everywhere, give or take how each portal rounds it. Ten per
 * cent is far wider than any rounding and far narrower than 480 against 355.
 */
const CLUSTER_AREA_SPAN = 0.1;

/** And for flats, where the number is measured rather than estimated. */
const CLUSTER_FLAT_AREA_SPAN = 0.05;

export function incoherentMembers(
  members: { id: string; priceEur: number | null }[],
): string[] {
  return incoherentBy(
    members.map((m) => ({ id: m.id, value: m.priceEur })),
    CLUSTER_PRICE_SPAN,
  );
}

/**
 * The same guard, on floor area, and it is not optional.
 *
 * Measurement-only merges made it necessary. Every pair they join agrees on
 * price to the euro and on area to within the rounding tolerance — and pairwise
 * agreement is not what union-find produces. Ramatuelle, 2026-09-04, one
 * cluster of seventeen listings all priced 5 300 000 €, with floor areas of
 * 480, 483, 482 and 355 m²: two different villas carrying one price, chained
 * together through the listings in between. Another put 2000 m² and 270 m² in
 * one property at 4 000 000 €.
 *
 * The price guard cannot see any of this — the prices are identical, which is
 * exactly why the merges happened. Area is the second dimension, and a cluster
 * has to be coherent in both.
 */
export function incoherentAreas(
  members: { id: string; areaM2: number | null; propertyType?: string | null }[],
): string[] {
  /**
   * Flats are held to the tighter figure, for the reason the pair rules give:
   * a flat's area is measured under the Carrez law and quoted the same way
   * everywhere, so a spread across a cluster of flats is a cluster holding
   * more than one flat.
   */
  const allFlats =
    members.length > 0 && members.every((m) => m.propertyType === undefined || isFlat(m.propertyType));
  return incoherentBy(
    members.map((m) => ({ id: m.id, value: m.areaM2 })),
    allFlats ? CLUSTER_FLAT_AREA_SPAN : CLUSTER_AREA_SPAN,
  );
}

/**
 * Whatever the pairwise scores said, is this group internally plausible on one
 * measurement? Returns the ids to split back out, keeping the largest coherent
 * subgroup around the median.
 *
 * Splitting to singletons would be safer still, but would also discard the
 * genuine merges caught in the same net.
 */
function incoherentBy(
  members: { id: string; value: number | null }[],
  tolerance: number,
): string[] {
  const known = members.filter((m) => m.value !== null) as { id: string; value: number }[];
  if (known.length < 2) return [];

  const sorted = known.map((m) => m.value).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return [];

  const span = (sorted[sorted.length - 1] - sorted[0]) / sorted[sorted.length - 1];
  if (span <= tolerance) return [];

  // Keep what sits near the median; evict the rest to be properties of their own.
  const outliers = known
    .filter((m) => Math.abs(m.value - median) / Math.max(m.value, median) > tolerance)
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
  return known
    .filter((m) => (medianIsAbove ? m.value < sorted[gapAt] : m.value >= sorted[gapAt]))
    .map((m) => m.id);
}

function round(n: number): number {
  return Number(n.toFixed(3));
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
