/**
 * Scoring a property against a buyer's brief.
 *
 * Pure: two objects in, a score and a list of sentences out. No database, no
 * network, no client — which is what makes it testable and what makes it
 * possible to change the weighting without touching anything else.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * A score is never produced without its reasons. An agent will not act on "87%"
 * they cannot check, and the first time an unexplained number is wrong the
 * feature is dead however good the arithmetic is. So `scoreBuyerMatch` returns
 * both, `reasons` is not optional, and every criterion the buyer stated gets a
 * line — including the ones that passed, because "budget and commune fit,
 * bedrooms one short" is a judgement an agent can make and a bare 72 is not.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No learning, no weights tuned against outcomes. There is no outcome data yet;
 * inventing weights and calling them a model would produce confident numbers
 * with nothing behind them. The weights below are stated in one place, in the
 * open, and should be argued about by humans until there is something real to
 * fit them to.
 */

export type BuyerBrief = {
  id: string;
  name: string;
  isTestData: boolean;

  budgetMinEur: number | null;
  budgetMaxEur: number | null;
  /** INSEE codes. Empty means the buyer did not restrict location. */
  communeInsee: string[];
  bedroomsMin: number | null;
  roomsMin: number | null;
  areaMinM2: number | null;
  landMinM2: number | null;
  propertyTypes: string[];
  mustHave: string[];
  niceToHave: string[];
};

export type PropertyFacts = {
  id: string;
  priceEur: number | null;
  areaM2: number | null;
  landM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  propertyType: string | null;
  communeInsee: string | null;
  /** Lowercased title + description, for feature detection. */
  text: string;
};

/** One line the screen can render verbatim. */
export type Reason = {
  field: string;
  /** true = satisfied, false = not satisfied, null = we do not know. */
  ok: boolean | null;
  detail: string;
  /** Set when this alone rules the property out. */
  disqualifying?: boolean;
};

export type MatchResult = {
  /** 0–100, only meaningful next to `reasons`. */
  score: number;
  matched: boolean;
  reasons: Reason[];
};

/**
 * Weights, in one place and adding to 100.
 *
 * Budget and location dominate because those are the two an agent will not
 * override: nobody sends a 12M villa to a 4M buyer to see what happens, and
 * nobody sends Ramatuelle stock to someone who only wants Sainte-Maxime.
 */
const WEIGHTS = {
  budget: 35,
  commune: 25,
  bedrooms: 12,
  area: 12,
  propertyType: 8,
  niceToHave: 8,
} as const;

/**
 * Feature words as the French portals actually write them, with the English
 * that Green-Acres and LuxuryEstate mix in on the same pages.
 *
 * Matching on substrings of the listing text is crude, and it is honest about
 * being crude: a description saying "no pool" would register as a pool. That
 * is why a nice-to-have can only ever ADD score, never disqualify, and why a
 * must-have failure is phrased as "not mentioned" rather than "absent".
 */
const FEATURE_WORDS: Record<string, string[]> = {
  pool: ["piscine", "pool"],
  sea_view: ["vue mer", "vue sur mer", "sea view", "vue panoramique mer"],
  garden: ["jardin", "garden"],
  garage: ["garage", "parking"],
  walking_distance_beach: ["plage à pied", "plage a pied", "walk to the beach", "beachfront"],
  renovated: ["rénové", "renove", "renovated", "refait à neuf"],
  air_conditioning: ["climatisation", "climatisé", "air conditioning"],
  guest_house: ["maison d'amis", "dépendance", "guest house", "pool house"],
};

export function hasFeature(text: string, feature: string): boolean {
  const words = FEATURE_WORDS[feature] ?? [feature.replace(/_/g, " ")];
  const haystack = text.toLowerCase();
  return words.some((w) => haystack.includes(w.toLowerCase()));
}

function money(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(2).replace(/0$/, "")} M€`;
  }
  return `${Math.round(n / 1000)} k€`;
}

function label(feature: string): string {
  return feature.replace(/_/g, " ");
}

/**
 * Score one property against one buyer.
 *
 * `communeNames` maps INSEE to a human label purely so the reasons read like
 * sentences. Passing it is optional; without it the codes are shown, which is
 * ugly but never wrong.
 */
export function scoreBuyerMatch(
  buyer: BuyerBrief,
  property: PropertyFacts,
  communeNames: Record<string, string> = {},
): MatchResult {
  const reasons: Reason[] = [];
  let earned = 0;
  let available = 0;
  let disqualified = false;

  const place = (insee: string | null) =>
    insee ? (communeNames[insee] ?? insee) : "an unknown commune";

  // ── Budget ──────────────────────────────────────────────────────────────
  if (buyer.budgetMinEur !== null || buyer.budgetMaxEur !== null) {
    available += WEIGHTS.budget;
    const price = property.priceEur;

    if (price === null) {
      // Unknown is not a failure. Every portal we collect publishes a price, so
      // this means a parse gap on our side, and penalising the buyer for our
      // bug would quietly hide properties that may fit perfectly.
      reasons.push({ field: "budget", ok: null, detail: "price not published — cannot tell" });
    } else {
      const min = buyer.budgetMinEur;
      const max = buyer.budgetMaxEur;
      const range = `${min ? money(min) : "no floor"}–${max ? money(max) : "no ceiling"}`;

      if (max !== null && price > max) {
        /**
         * A ceiling is soft up to 10%.
         *
         * Buyers routinely stretch, and an agent who never sees anything above
         * the stated number cannot have the conversation about stretching. Over
         * 10% it disqualifies outright — that is not a stretch, it is a
         * different search.
         */
        const over = (price - max) / max;
        if (over <= 0.1) {
          earned += WEIGHTS.budget * 0.5;
          reasons.push({
            field: "budget",
            ok: false,
            detail: `${money(price)} is ${Math.round(over * 100)}% over their ${money(max)} ceiling`,
          });
        } else {
          disqualified = true;
          reasons.push({
            field: "budget",
            ok: false,
            disqualifying: true,
            detail: `${money(price)} is well over their ${range} range`,
          });
        }
      } else if (min !== null && price < min * 0.7) {
        // Far below budget usually means a different kind of property, not a
        // bargain — a studio shown to someone shopping for a villa.
        disqualified = true;
        reasons.push({
          field: "budget",
          ok: false,
          disqualifying: true,
          detail: `${money(price)} is far below their ${range} range`,
        });
      } else {
        earned += WEIGHTS.budget;
        reasons.push({ field: "budget", ok: true, detail: `${money(price)} fits ${range}` });
      }
    }
  }

  // ── Commune ─────────────────────────────────────────────────────────────
  if (buyer.communeInsee.length > 0) {
    available += WEIGHTS.commune;
    if (property.communeInsee === null) {
      reasons.push({ field: "commune", ok: null, detail: "commune unknown — cannot tell" });
    } else if (buyer.communeInsee.includes(property.communeInsee)) {
      earned += WEIGHTS.commune;
      reasons.push({
        field: "commune",
        ok: true,
        detail: `${place(property.communeInsee)} is on their list`,
      });
    } else {
      /**
       * Location does not disqualify.
       *
       * A buyer who wrote "Saint-Tropez" usually means the area, and the
       * neighbouring commune is a five-minute drive. Scoring it zero and
       * showing it is the right call; hiding it is not — that is the agent's
       * judgement, and they have the context we do not.
       */
      reasons.push({
        field: "commune",
        ok: false,
        detail: `${place(property.communeInsee)} is not among ${buyer.communeInsee
          .map(place)
          .join(", ")}`,
      });
    }
  }

  // ── Bedrooms ────────────────────────────────────────────────────────────
  if (buyer.bedroomsMin !== null) {
    available += WEIGHTS.bedrooms;
    const have = property.bedrooms;
    if (have === null) {
      reasons.push({ field: "bedrooms", ok: null, detail: "bedroom count not published" });
    } else if (have >= buyer.bedroomsMin) {
      earned += WEIGHTS.bedrooms;
      reasons.push({ field: "bedrooms", ok: true, detail: `${have} bedrooms, wanted ${buyer.bedroomsMin}+` });
    } else if (have === buyer.bedroomsMin - 1) {
      // One short is worth saying out loud rather than filtering away.
      earned += WEIGHTS.bedrooms * 0.4;
      reasons.push({
        field: "bedrooms",
        ok: false,
        detail: `${have} bedrooms — one short of the ${buyer.bedroomsMin} they asked for`,
      });
    } else {
      reasons.push({
        field: "bedrooms",
        ok: false,
        detail: `${have} bedrooms, wanted ${buyer.bedroomsMin}+`,
      });
    }
  }

  // ── Living area ─────────────────────────────────────────────────────────
  if (buyer.areaMinM2 !== null) {
    available += WEIGHTS.area;
    const have = property.areaM2;
    if (have === null) {
      reasons.push({ field: "area", ok: null, detail: "floor area not published" });
    } else if (have >= buyer.areaMinM2) {
      earned += WEIGHTS.area;
      reasons.push({ field: "area", ok: true, detail: `${have} m², wanted ${buyer.areaMinM2} m²+` });
    } else {
      const short = (buyer.areaMinM2 - have) / buyer.areaMinM2;
      if (short <= 0.15) earned += WEIGHTS.area * 0.5;
      reasons.push({
        field: "area",
        ok: false,
        detail: `${have} m², wanted ${buyer.areaMinM2} m²+`,
      });
    }
  }

  // ── Land ────────────────────────────────────────────────────────────────
  if (buyer.landMinM2 !== null) {
    const have = property.landM2;
    if (have === null) {
      reasons.push({ field: "land", ok: null, detail: "plot size not published" });
    } else {
      reasons.push({
        field: "land",
        ok: have >= buyer.landMinM2,
        detail: `${have.toLocaleString("fr-FR")} m² of land, wanted ${buyer.landMinM2.toLocaleString("fr-FR")} m²+`,
      });
    }
  }

  // ── Property type ───────────────────────────────────────────────────────
  if (buyer.propertyTypes.length > 0) {
    available += WEIGHTS.propertyType;
    const have = property.propertyType;
    if (have === null) {
      reasons.push({ field: "type", ok: null, detail: "property type not published" });
    } else if (buyer.propertyTypes.some((t) => t.toLowerCase() === have.toLowerCase())) {
      earned += WEIGHTS.propertyType;
      reasons.push({ field: "type", ok: true, detail: `${have}, which they want` });
    } else {
      /**
       * Type DOES disqualify. Someone looking for an apartment does not want a
       * plot of land, and unlike location there is no near-miss reading of it.
       */
      disqualified = true;
      reasons.push({
        field: "type",
        ok: false,
        disqualifying: true,
        detail: `${have}, but they want ${buyer.propertyTypes.join(" or ")}`,
      });
    }
  }

  // ── Must-haves ──────────────────────────────────────────────────────────
  for (const feature of buyer.mustHave) {
    if (hasFeature(property.text, feature)) {
      reasons.push({ field: feature, ok: true, detail: `${label(feature)} — mentioned` });
    } else {
      /**
       * Phrased as "not mentioned", not "absent", and it does NOT disqualify.
       *
       * All we did was fail to find a word in a description an agency wrote in
       * a hurry. A villa with a pool whose listing forgets to say so is common;
       * dropping it silently would be us presenting the limits of substring
       * matching as a fact about the property.
       */
      reasons.push({
        field: feature,
        ok: false,
        detail: `${label(feature)} — not mentioned in the listing`,
      });
    }
  }

  // ── Nice-to-haves ───────────────────────────────────────────────────────
  if (buyer.niceToHave.length > 0) {
    available += WEIGHTS.niceToHave;
    const found = buyer.niceToHave.filter((f) => hasFeature(property.text, f));
    earned += (WEIGHTS.niceToHave * found.length) / buyer.niceToHave.length;
    if (found.length > 0) {
      reasons.push({
        field: "extras",
        ok: true,
        detail: `${found.map(label).join(", ")} — also on their wish list`,
      });
    }
  }

  /**
   * Normalise against what the buyer actually stated, not against the full 100.
   *
   * A buyer who gave only a budget and a commune should be able to reach a high
   * score on those two. Dividing by the full weight table instead would cap
   * every under-specified buyer at 60 and make the number mean "how much did
   * this person type", which is not a property of the match at all.
   */
  const score = available === 0 ? 0 : Math.round((earned / available) * 100);

  return {
    score: disqualified ? 0 : score,
    matched: !disqualified && score >= MATCH_THRESHOLD,
    reasons,
  };
}

/**
 * Below this, a match is not worth an agent's attention.
 *
 * The rule this has to express: **a property that fits the budget but is in the
 * wrong commune must not surface.** For a buyer who stated only those two
 * things, that case scores 35 of an available 60 — 58. The first version of this
 * constant was 55, which let exactly the case it was meant to exclude through;
 * the test caught it, and the number was wrong rather than the test.
 *
 * 65 sits clear of that 58 without cutting into real matches. The worst
 * legitimate case — budget and commune right, bedrooms one short, area slightly
 * under, type right — scores in the mid eighties, so there is a wide margin.
 *
 * It is still arbitrary in the way every threshold is, and it is the first thing
 * to revisit once agents have dismissed a few hundred of these and told us what
 * they actually think. `buyer_matches.dismissed_reason` exists to collect that.
 */
export const MATCH_THRESHOLD = 65;

/** Feature keys we understand, for the UI to offer rather than free text. */
export function knownFeatures(): string[] {
  return Object.keys(FEATURE_WORDS);
}
