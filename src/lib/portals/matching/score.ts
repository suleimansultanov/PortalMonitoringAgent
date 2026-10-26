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
  /** Same price to the euro on two houses whose plots do not disagree: the floor area had the 20% band. */
  samePriceBand?: boolean;
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
/**
 * And what a house's floor area is allowed to differ by once the plot under it
 * has already agreed. Two agencies measure a villa differently — habitable,
 * with the annexes, with the covered terrace — and the difference is a few per
 * cent of a large number.
 */
const AREA_TOLERANCE_WITH_LAND = 0.1;
/**
 * And once the plot agrees to the square metre — within a rounding — on a
 * house standing on a real piece of land, at a price identical to the euro.
 *
 * La Croix-Valmer, 4 490 000 €, reported by the client on 2026-10-15: their
 * own mandate (ref 87276762) is 179 m² on 1 423 m²; John Taylor and Home Hunts
 * sell the same villa as 210 m² on 1 423 m². Same price, same plot, same four
 * bedrooms — two properties on the client's screen, because 179 against 210
 * is 15% and the band above stops at 10. The client's search between 2.5 and
 * 6 M€ in that commune showed seventeen properties with a same-price,
 * same-plot twin: 210/230/250 m² on 2 500 m² at 4 290 000 €, 432/350 m² on
 * 10 403 m², 173/195 m² on 1 234 m². Agencies quote habitable area, area with
 * the pool house, area with the covered terraces; the cadastre quotes the plot
 * once.
 *
 * THE RULE, as agreed with the client on 2026-10-15 (Tomaz, after a call with
 * Mark): the same price to the euro, the same commune, floor areas within
 * 20% — and the plots within 20% too, where both state one. An unstated plot
 * does not block it; a plot that disagrees by more does.
 *
 * Not for flats: their area is measured under the Carrez law and quoted
 * identically everywhere, and one residence sells several flats at one price —
 * they keep FLAT_AREA_TOLERANCE. Not for bare plots, whose "area" is the land.
 * The cost is known and accepted: two different villas at one round price in
 * one commune, 200 and 230 m², now read as one.
 */
const AREA_TOLERANCE_SAME_PRICE = 0.2;
const LAND_TOLERANCE_SAME_PRICE = 0.2;
/**
 * TRIED AND REVERTED, 2026-10-19: a tenth instead of a fifth when the plot is
 * unknown on either side. It would have kept two villas on two plots apart
 * (Les Issambres, 2 290 000 €: 225 m² on 3 000 and 180 m² on 1 000, joined
 * through LuxuryEstate's copy of the second, which states no plot — exactly
 * 20% apart). Dry run over the market: 114 MORE properties, because
 * LuxuryEstate and Stream.Estate V1 never state a plot and their copies of a
 * house sit 10–20% from the other portals' figure far more often than two
 * houses hide behind one. Five duplicates fixed, a hundred and fourteen made.
 */
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

/** A plot for sale with no house to measure: its "area" is the land. */
export function isPlot(propertyType: string | null): boolean {
  if (!propertyType) return false;
  return /terrain|land|plot/i.test(propertyType);
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
  /**
   * TRIED AND REVERTED, 2026-10-19: refusing a bare plot against a building.
   * Stream.Estate V1 had carried a villa as "Terrain", no floor area, with the
   * villa's own text, and the text joined it to the villa. The veto cost 32
   * properties in a dry run — "Terrain" rows an agency files beside its house
   * became cards of their own — and merged nothing the client would see.
   */

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

    /**
     * The band widens when the PLOT agrees.
     *
     * Ramatuelle, 19 500 000 €, found on 2026-09-04: Michaël Zingraf publishes
     * 430 m² on 11 000 m² of land, Côte d'Azur Sotheby's publishes 400 m² on
     * 10 653 m², and the second one's own description says "terrain 11 000 m²".
     * One villa, two agencies, two ways of measuring the same house — and a
     * flat 3% rule split it in two.
     *
     * Two agencies inventing the same price to the euro AND the same plot to
     * within a few hundred square metres, in the same commune, by coincidence,
     * is not a thing that happens. When the plot corroborates, the floor area
     * is allowed to disagree the way agencies actually disagree about floor
     * area — which is by a few per cent of a big number, not by a third.
     *
     * Without that corroboration the narrow band stands, and it is what keeps
     * 480 m² away from 355 m² at the same price.
     */
    const tolerance = areaTolerance(a, b);
    if (delta > tolerance) {
      signals.areaClose = false;
      signals.areaConflict = true;
      return { same: false, confidence: 0, signals };
    }
    if (landDeltaOf(a, b) !== null && landDeltaOf(a, b)! <= LAND_TOLERANCE) signals.landClose = true;
    if (tolerance === AREA_TOLERANCE_SAME_PRICE) signals.samePriceBand = true;
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

      /**
       * The same band the veto above applied — a fifth when both plots are
       * stated and agree, a tenth when the plot is unknown, the rounding
       * otherwise — and the matching plot tolerance.
       */
      const tolerance = areaTolerance(a, b);
      const wide = tolerance === AREA_TOLERANCE_SAME_PRICE;
      if (a.priceEur === b.priceEur && areaDelta <= tolerance) {
        if (landDelta !== null && landDelta > (wide ? LAND_TOLERANCE_SAME_PRICE : LAND_TOLERANCE)) {
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

/** Relative disagreement of the two plots, or null when either is unknown. */
function landDeltaOf(a: Candidate, b: Candidate): number | null {
  if (a.landM2 === null || b.landM2 === null || a.landM2 <= 0 || b.landM2 <= 0) return null;
  return Math.abs(a.landM2 - b.landM2) / Math.max(a.landM2, b.landM2);
}

/** Shops, offices, garages, whole buildings: not a home, and not what the 20% band was agreed for. */
function isPremises(propertyType: string | null): boolean {
  if (!propertyType) return false;
  return /commerce|local|bureau|office|parking|garage|\bbox\b|immeuble|fonds|entrep|warehouse|shop/i.test(propertyType);
}

/** Two houses (no flat, no bare plot, no premises) at one price, whose plots do not disagree by more than 20%. */
function sameHouseBand(a: Candidate, b: Candidate): boolean {
  if (a.priceEur === null || a.priceEur !== b.priceEur) return false;
  if ([a, b].some((x) => isFlat(x.propertyType) || isPlot(x.propertyType) || isPremises(x.propertyType))) return false;
  const land = landDeltaOf(a, b);
  return land === null || land <= LAND_TOLERANCE_SAME_PRICE;
}

/** How far two floor areas may disagree and still be one property — see the constants. */
export function areaTolerance(a: Candidate, b: Candidate): number {
  /**
   * Carrez precision only when BOTH portals call it a flat. Agencies file a
   * villa as "Appartement" on one portal and "Maison" on the next (Sainte-
   * Maxime, 595 000 €, 2026-10-18: one mandate, three portals, typed both
   * ways), and holding such a pair to 1.5% split the house. A pair the portals
   * disagree about gets the ordinary rounding band — neither tightened nor
   * widened — and joins through the rows that agree.
   */
  if (isFlat(a.propertyType) && isFlat(b.propertyType)) return FLAT_AREA_TOLERANCE;
  if (sameHouseBand(a, b)) return AREA_TOLERANCE_SAME_PRICE;
  const land = landDeltaOf(a, b);
  if (land === null || land > LAND_TOLERANCE) return AREA_TOLERANCE;
  return AREA_TOLERANCE_WITH_LAND;
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
    // Everything inside a commune that could match everything else inside it.
    pairsWithin(list, pairs);
    // Unplaced listings are compared against every commune, because "unknown"
    // is a parse gap, not a location.
    if (key !== "unknown") pairsAcross(unknown, list, pairs);
  }

  return pairs;
}

/**
 * BLOCKED BY PRICE TOO, because `scoreMatch` vetoes on it.
 *
 * Two different asking prices are two properties (rule 2a) unless the agency's
 * own mandate reference says otherwise (rule 1). So the only pairs worth
 * scoring are: equal prices, a price missing on either side, or the same
 * agency and mandate reference. Everything else was allocated, scored and
 * vetoed on its first numeric comparison — 11.9 million pairs for
 * Sainte-Maxime on 2026-10-14, 97.5% of them thrown away that way (REVIEW §3).
 * The verdicts are identical; `score.test.ts` checks that against scoring
 * every pair.
 */
function pairsWithin(list: Candidate[], out: [Candidate, Candidate][]): void {
  const byPrice = new Map<number, Candidate[]>();
  const unpriced: Candidate[] = [];
  for (const c of list) {
    if (c.priceEur === null) unpriced.push(c);
    else {
      const bucket = byPrice.get(c.priceEur);
      if (bucket) bucket.push(c);
      else byPrice.set(c.priceEur, [c]);
    }
  }
  for (const bucket of byPrice.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) out.push([bucket[i], bucket[j]]);
    }
  }
  // A listing without a price can be anything: it meets the whole block.
  for (let i = 0; i < unpriced.length; i++) {
    for (let j = i + 1; j < unpriced.length; j++) out.push([unpriced[i], unpriced[j]]);
    for (const c of list) if (c.priceEur !== null) out.push([unpriced[i], c]);
  }
  // Different prices, same mandate: the one exception to the price veto.
  for (const bucket of byMandate(list).values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (bucket[i].priceEur !== bucket[j].priceEur) out.push([bucket[i], bucket[j]]);
      }
    }
  }
}

function pairsAcross(unplaced: Candidate[], list: Candidate[], out: [Candidate, Candidate][]): void {
  if (unplaced.length === 0) return;
  const mandates = byMandate(list);
  for (const u of unplaced) {
    const sameMandate = new Set(mandates.get(mandateKey(u) ?? "") ?? []);
    for (const c of list) {
      if (u.priceEur === null || c.priceEur === null || u.priceEur === c.priceEur || sameMandate.has(c)) {
        out.push([u, c]);
      }
    }
  }
}

/** Same agency and a reference that looks like a mandate number — rule 1's own test. */
function mandateKey(c: Candidate): string | null {
  if (!c.agencyId || !c.agencyRef || !looksLikeMandateRef(c.agencyRef)) return null;
  return `${c.agencyId}|${c.agencyRef.trim().toLowerCase()}`;
}

function byMandate(list: Candidate[]): Map<string, Candidate[]> {
  const out = new Map<string, Candidate[]>();
  for (const c of list) {
    const key = mandateKey(c);
    if (!key) continue;
    const bucket = out.get(key);
    if (bucket) bucket.push(c);
    else out.set(key, [c]);
  }
  return out;
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
 * How far a chain of houses may run end to end before it is cut, when no
 * single member is out of the band on its own.
 *
 * The band for houses is the client's own (AREA_TOLERANCE_SAME_PRICE, 20%),
 * measured from the median: four agencies quoting 130, 148, 160 and 167 m²
 * for one villa are each within a fifth of 160 and are one house, though the
 * ends are 22% apart. A guard that cut at the widest gap whenever the ends
 * exceeded the band turned exactly those into two cards — 98 pairs on
 * 2026-10-18, every one of them a pair the pair rule had just joined. But a
 * chain can run on: 280 – 325 – 378 – 400 at one price is two villas, joined
 * through the middle. Past this ceiling end to end, it is cut at the widest
 * gap and the side holding the median stays.
 */
const CLUSTER_AREA_CHAIN = 0.3;

/**
 * And the band when the plots do NOT mostly agree: the rounding band of the
 * pair rules, with the forced split. Two houses at one price on two plots is
 * what this is for (Grimaud, 3 950 000 €: 330 m² on 2 500 against 400 m² on
 * 3 239–4 000); far narrower than 480 against 355.
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
  members: { id: string; areaM2: number | null; propertyType?: string | null; landM2?: number | null }[],
): string[] {
  /**
   * Flats are held to the tighter figure, for the reason the pair rules give:
   * a flat's area is measured under the Carrez law and quoted the same way
   * everywhere, so a spread across a cluster of flats is a cluster holding
   * more than one flat.
   *
   * By MAJORITY of the rows that state a type. "Every member a flat" let one
   * portal's "Appartement" on a villa hold the whole cluster to the flat band
   * (2026-10-18: 31 of 149 pairs left apart); "any member a flat" did the
   * same in the other direction. One portal's label is one vote.
   */
  const areas = members.map((m) => ({ id: m.id, value: m.areaM2 }));
  if (mostlyFlats(members)) return incoherentBy(areas, CLUSTER_FLAT_AREA_SPAN);
  return plotsMostlyAgree(members)
    ? incoherentBy(areas, AREA_TOLERANCE_SAME_PRICE, { chainsUpTo: CLUSTER_AREA_CHAIN })
    : incoherentBy(areas, CLUSTER_AREA_SPAN);
}

/**
 * Do the plots the members state put them on one piece of ground? More than
 * half of them within a fifth of the median plot. Fewer than two stated: yes —
 * unknown is not a disagreement.
 *
 * By majority from the median, not by the cluster's extremes. "Every plot
 * within 20% of every other" let one row saying 923 m² under a villa on 1 500
 * (Cavalaire, 2026-10-18) drop the floor-area band from 20% to 10% for thirty
 * rows, and three agencies' listings of one house became three cards.
 *
 * NOT a reason to evict a member on its own. Measured the same day: of 1 562
 * served houses with two or more listings stating a plot, 197 (13%) have
 * plots more than 20% apart and 85 more than 60% — one house, several
 * portals, several readings of "terrain". A guard that split on the plot tore
 * 1 859 listings out of their clusters in a dry run. The plot chooses the
 * band; the floor area decides.
 */
function plotsMostlyAgree(members: { landM2?: number | null }[]): boolean {
  const plots = members.map((m) => m.landM2).filter((v): v is number => v !== null && v !== undefined && v > 0);
  if (plots.length < 2) return true;
  const sorted = [...plots].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const agreeing = plots.filter((v) => Math.abs(v - median) / Math.max(v, median) <= LAND_TOLERANCE_SAME_PRICE).length;
  return agreeing * 2 > plots.length;
}

/** More than half of the rows that state a type call it a flat. No type stated anywhere: not flats. */
function mostlyFlats(members: { propertyType?: string | null }[]): boolean {
  const typed = members.filter((m) => m.propertyType !== undefined && m.propertyType !== null);
  const flats = typed.filter((m) => isFlat(m.propertyType!)).length;
  return typed.length > 0 && flats * 2 > typed.length;
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
  opts: { chainsUpTo?: number } = {},
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
   *
   * Unless the caller allows a chain: measurements of one house from several
   * hands spread wider than any one of them is from the middle, and up to
   * `chainsUpTo` end to end that is one house, not a cluster to cut.
   */
  if (opts.chainsUpTo !== undefined && span <= opts.chainsUpTo) return [];
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

/**
 * Break apart clusters that are not internally plausible. Mutates `groups`;
 * returns how many listings were split out.
 *
 * WHAT IS SPLIT OUT IS RE-CLUSTERED, not scattered. The evicted listings are
 * grouped again by the edges that joined them to each other, and each group
 * is checked the same way. They used to become one property each: a cluster
 * of 29 at 2 990 000 € in La Croix-Valmer (2026-10-15) held three or four
 * villas chained through listings that state no plot, and the guard kept one
 * villa and turned the other three into fourteen single-listing cards — more
 * duplicates on the client's screen than before the merge, from the step
 * meant to remove them.
 *
 * And each split-out group gets a key of its own. It used to be keyed by its
 * listing id — and when the outlier was the union-find ROOT, that id was the
 * cluster's own key, so `set` replaced the members just kept with the outlier
 * alone. They were never written, and the outlier inherited the old property
 * row: the split was undone in the line that made it (REVIEW §2).
 */
export function splitIncoherent<
  T extends {
    id: string;
    priceEur: number | null;
    areaM2: string | number | null;
    landM2: string | number | null;
    propertyType: string | null;
  },
>(groups: Map<string, T[]>, edges: [string, string][] = []): number {
  const neighbours = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = neighbours.get(from);
    if (list) list.push(to);
    else neighbours.set(from, [to]);
  };
  for (const [a, b] of edges) {
    link(a, b);
    link(b, a);
  }

  let evicted = 0;
  let minted = 0;
  const queue = [...groups.keys()];
  while (queue.length > 0) {
    const key = queue.pop()!;
    const group = groups.get(key)!;
    if (group.length < 2) continue;
    /**
     * Both dimensions, price first, ONE AT A TIME.
     *
     * A cluster welded together by measurement-only merges is coherent in
     * price BY CONSTRUCTION — every such merge required the prices to be
     * identical — so the price guard passes it and sees nothing. Area is what
     * catches those, and a group has to survive both to stand. The plot is not
     * a third guard: it chooses the floor-area band (see plotsMostlyAgree).
     *
     * Each guard keeps the members around its own median, so applied one at a
     * time something always stays. Applied together (2026-10-15) the price
     * guard could keep the median price and the area guard evict it, the union
     * evicted everyone, the whole group re-clustered into itself, and the loop
     * never ended.
     */
    const members = group.map((g) => ({
      id: g.id,
      priceEur: g.priceEur,
      areaM2: g.areaM2 === null ? null : Number(g.areaM2),
      landM2: g.landM2 === null ? null : Number(g.landM2),
      propertyType: g.propertyType,
    }));
    let outliers = new Set(incoherentMembers(members));
    if (outliers.size === 0) outliers = new Set(incoherentAreas(members));
    if (outliers.size === 0) continue;
    const kept = group.filter((g) => !outliers.has(g.id));
    if (kept.length === 0) throw new Error("splitIncoherent: a guard evicted its own median — the loop would not end");

    groups.set(key, kept);
    queue.push(key); // what stays is checked again, on the other dimension too
    evicted += outliers.size;

    // Wrongly separating two listings is a duplicate on a screen; wrongly
    // merging them hides a property from the client entirely. So the split
    // is final, and only what still joins among the split-out stays together.
    const out = group.filter((g) => outliers.has(g.id));
    const parts = cluster(
      out.map((g) => g.id),
      out.flatMap((g) => (neighbours.get(g.id) ?? []).filter((n) => outliers.has(n)).map((n): [string, string] => [g.id, n])),
    );
    const byRoot = new Map<string, T[]>();
    for (const g of out) {
      const root = parts.get(g.id) ?? g.id;
      const list = byRoot.get(root);
      if (list) list.push(g);
      else byRoot.set(root, [g]);
    }
    for (const part of byRoot.values()) {
      // Minted, never derived from a listing id: a part split out a second
      // time would otherwise land on its parent's key and overwrite it.
      const partKey = `evicted:${++minted}`;
      groups.set(partKey, part);
      queue.push(partKey);
    }
  }
  return evicted;
}

/**
 * THE PIPELINE, in one place: score every plausible pair, cluster what
 * matched, break apart what does not hold together. The resolve writes its
 * result, dedup:check measures it dry, the duplicate audit replays it to ask
 * whether what was written is what it would decide — and they have to be the
 * same function, or the measurement is of something else.
 *
 * `bestSignals` keeps the strongest evidence per listing, not the last: a
 * listing that matched three others should carry the reason easiest to
 * defend, which is almost always the exact mandate reference if one fired.
 *
 * `staleSourceIds`: collectors switched off. Their rows stay active forever —
 * nobody reads those portals again — so their price is the one they had when
 * the collector stopped (Figaro 16 September, Superimmo 14 October). They may
 * still join by the agency's own mandate number, which a price does not
 * outrank; by size or by text they may not, because both of those require the
 * price to agree, and theirs is a price nobody is asking any more. Measured
 * 2026-10-26: one Sainte-Maxime property held 53 listings of about a dozen
 * homes, because a villa now at 1 695 000 € was still 1 790 000 € on Figaro's
 * August row, and that row matched every other home at 1 790 000 by size.
 * A property Med-Estates sells was one of them, so the client saw one card.
 */
export function clusterCandidates(
  candidates: Candidate[],
  threshold: number,
  opts: { staleSourceIds?: ReadonlySet<string> } = {},
): {
  /** Group key → member ids. Keys are opaque; a split-out group's key is minted. */
  groups: Map<string, string[]>;
  edges: { a: Candidate; b: Candidate; verdict: MatchVerdict }[];
  bestSignals: Map<string, { confidence: number; signals: MatchSignals }>;
  /** Listings the coherence guards split back out. */
  evicted: number;
} {
  const edges: { a: Candidate; b: Candidate; verdict: MatchVerdict }[] = [];
  const bestSignals = new Map<string, { confidence: number; signals: MatchSignals }>();
  const stale = opts.staleSourceIds;
  for (const [a, b] of candidatePairs(candidates)) {
    const verdict = scoreMatch(a, b);
    if (!verdict.same || verdict.confidence < threshold) continue;
    if (stale && (stale.has(a.sourceId) || stale.has(b.sourceId)) && !verdict.signals.agencyRefExact) continue;
    edges.push({ a, b, verdict });
    for (const id of [a.id, b.id]) {
      const prev = bestSignals.get(id);
      if (!prev || verdict.confidence > prev.confidence) bestSignals.set(id, { confidence: verdict.confidence, signals: verdict.signals });
    }
  }
  const matched: [string, string][] = edges.map((e) => [e.a.id, e.b.id]);
  const roots = cluster(
    candidates.map((c) => c.id),
    matched,
  );
  const grouped = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = roots.get(c.id) ?? c.id;
    const list = grouped.get(key);
    if (list) list.push(c);
    else grouped.set(key, [c]);
  }
  const evicted = splitIncoherent(grouped, matched);
  const groups = new Map<string, string[]>();
  for (const [key, members] of grouped) if (members.length > 0) groups.set(key, members.map((m) => m.id));
  return { groups, edges, bestSignals, evicted };
}

function round(n: number): number {
  return Number(n.toFixed(3));
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
