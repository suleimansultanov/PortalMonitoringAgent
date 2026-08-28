import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreBuyerMatch,
  hasFeature,
  MATCH_THRESHOLD,
  type BuyerBrief,
  type PropertyFacts,
} from "./buyers";

const NAMES = { "83101": "Ramatuelle", "83119": "Saint-Tropez", "83115": "Sainte-Maxime" };

function buyer(over: Partial<BuyerBrief> = {}): BuyerBrief {
  return {
    id: "b1",
    name: "Test buyer",
    isTestData: true,
    budgetMinEur: 4_000_000,
    budgetMaxEur: 6_000_000,
    communeInsee: ["83101", "83119"],
    bedroomsMin: 4,
    roomsMin: null,
    areaMinM2: 200,
    landMinM2: null,
    propertyTypes: ["Maison"],
    mustHave: [],
    niceToHave: [],
    ...over,
  };
}

function property(over: Partial<PropertyFacts> = {}): PropertyFacts {
  return {
    id: "p1",
    priceEur: 4_990_000,
    areaM2: 220,
    landM2: 2_000,
    rooms: 9,
    bedrooms: 5,
    propertyType: "Maison",
    communeInsee: "83101",
    text: "villa avec piscine et vue mer",
    ...over,
  };
}

test("a property that fits everything scores high and says why", () => {
  const r = scoreBuyerMatch(buyer(), property(), NAMES);
  assert.ok(r.matched);
  assert.ok(r.score >= 90, `expected a high score, got ${r.score}`);

  // Every criterion the buyer stated produces a line — including the ones that
  // passed. "Budget and commune fit" is the sentence an agent acts on.
  const fields = r.reasons.map((x) => x.field);
  for (const f of ["budget", "commune", "bedrooms", "area", "type"]) {
    assert.ok(fields.includes(f), `no reason given for ${f}`);
  }
  assert.ok(r.reasons.every((x) => x.detail.length > 0), "every reason has words");
});

test("a score is never returned without reasons", () => {
  // The rule the module exists to enforce. An unexplained number gets ignored
  // the first time it is wrong, and then the feature is dead.
  const r = scoreBuyerMatch(buyer(), property({ priceEur: 20_000_000 }), NAMES);
  assert.ok(r.reasons.length > 0);
});

test("a ceiling is soft up to 10% — the agent gets to have that conversation", () => {
  const r = scoreBuyerMatch(buyer(), property({ priceEur: 6_500_000 }), NAMES);
  const budget = r.reasons.find((x) => x.field === "budget");
  assert.equal(budget?.ok, false);
  assert.ok(!budget?.disqualifying, "8% over is a stretch, not a different search");
  assert.match(budget?.detail ?? "", /over/);
});

test("well over the ceiling disqualifies outright", () => {
  const r = scoreBuyerMatch(buyer(), property({ priceEur: 12_000_000 }), NAMES);
  assert.equal(r.matched, false);
  assert.equal(r.score, 0);
  assert.ok(r.reasons.some((x) => x.disqualifying), "and it says which criterion killed it");
});

test("far below budget is a different kind of property, not a bargain", () => {
  const r = scoreBuyerMatch(buyer(), property({ priceEur: 900_000 }), NAMES);
  assert.equal(r.matched, false);
});

test("a neighbouring commune is shown, not hidden", () => {
  // Sainte-Maxime is not on their list but is twenty minutes away. Scoring it
  // low is right; hiding it takes a judgement away from the agent.
  const r = scoreBuyerMatch(buyer({ bedroomsMin: null, areaMinM2: null }), property({ communeInsee: "83115" }), NAMES);
  const commune = r.reasons.find((x) => x.field === "commune");
  assert.equal(commune?.ok, false);
  assert.ok(!commune?.disqualifying);
  assert.match(commune?.detail ?? "", /Sainte-Maxime/);
});

test("the wrong property type does disqualify", () => {
  // Unlike location, there is no near-miss reading of "they wanted a flat, this
  // is a field".
  const r = scoreBuyerMatch(buyer({ propertyTypes: ["Appartement"] }), property(), NAMES);
  assert.equal(r.matched, false);
  assert.equal(r.score, 0);
});

test("one bedroom short is reported, not filtered away", () => {
  const r = scoreBuyerMatch(buyer(), property({ bedrooms: 3 }), NAMES);
  const bed = r.reasons.find((x) => x.field === "bedrooms");
  assert.match(bed?.detail ?? "", /one short/);
});

test("a missing price is 'cannot tell', never a failure", () => {
  // Every portal we collect publishes a price, so a null means our parser
  // missed it. Penalising the buyer for our bug would hide properties that fit.
  const r = scoreBuyerMatch(buyer(), property({ priceEur: null }), NAMES);
  const budget = r.reasons.find((x) => x.field === "budget");
  assert.equal(budget?.ok, null);
  assert.ok(!budget?.disqualifying);
});

test("an unmet must-have is phrased as 'not mentioned' and does not disqualify", () => {
  // All we did was fail to find a word in a description written in a hurry.
  const r = scoreBuyerMatch(
    buyer({ mustHave: ["pool"] }),
    property({ text: "belle villa au calme" }),
    NAMES,
  );
  const pool = r.reasons.find((x) => x.field === "pool");
  assert.equal(pool?.ok, false);
  assert.ok(!pool?.disqualifying);
  assert.match(pool?.detail ?? "", /not mentioned/);
});

test("the score is normalised against what the buyer actually stated", () => {
  /**
   * A buyer who gave only a budget and a commune must be able to reach a high
   * score on those two. Dividing by the full weight table would cap every
   * under-specified buyer below the threshold, and the number would end up
   * measuring how much the person typed rather than how well the property fits.
   */
  const sparse = buyer({
    bedroomsMin: null,
    areaMinM2: null,
    propertyTypes: [],
    niceToHave: [],
  });
  const r = scoreBuyerMatch(sparse, property(), NAMES);
  assert.equal(r.score, 100);
  assert.ok(r.matched);
});

test("the right price in the wrong commune does not surface", () => {
  /**
   * The line the threshold exists to draw, and the one that caught a real
   * mistake: with a threshold of 55 this scored 58 and passed, which is exactly
   * the case it was meant to exclude. The constant was wrong, not the test.
   */
  const sparse = buyer({
    communeInsee: ["83119"],
    bedroomsMin: null,
    areaMinM2: null,
    propertyTypes: [],
    niceToHave: [],
  });

  const wrongPlace = scoreBuyerMatch(sparse, property({ communeInsee: "83115" }), NAMES);
  assert.ok(
    wrongPlace.score < MATCH_THRESHOLD,
    `budget-only fit scored ${wrongPlace.score}, threshold ${MATCH_THRESHOLD}`,
  );
  assert.equal(wrongPlace.matched, false);

  // …and the same buyer in the right commune must clear it comfortably.
  const rightPlace = scoreBuyerMatch(sparse, property({ communeInsee: "83119" }), NAMES);
  assert.ok(rightPlace.matched);
});

test("a near miss on several criteria still surfaces", () => {
  // The other side of the threshold: budget and commune right, bedrooms one
  // short, area slightly under. That is a property an agent should see, and a
  // threshold tuned only against the negative case would swallow it.
  const r = scoreBuyerMatch(buyer(), property({ bedrooms: 3, areaM2: 185 }), NAMES);
  assert.ok(r.matched, `near miss scored ${r.score}`);
});

test("French and English feature words are both recognised", () => {
  // The portals mix languages on the same page.
  assert.ok(hasFeature("Villa avec piscine chauffée", "pool"));
  assert.ok(hasFeature("Villa with heated pool", "pool"));
  assert.ok(hasFeature("magnifique vue mer panoramique", "sea_view"));
  assert.ok(!hasFeature("jardin arboré", "pool"));
});

test("nice-to-haves add score and get named, but never disqualify", () => {
  const withExtras = scoreBuyerMatch(
    buyer({ niceToHave: ["pool", "sea_view"] }),
    property({ text: "villa avec piscine et vue mer" }),
    NAMES,
  );
  const without = scoreBuyerMatch(
    buyer({ niceToHave: ["pool", "sea_view"] }),
    property({ text: "villa au calme" }),
    NAMES,
  );
  assert.ok(withExtras.score > without.score);
  assert.ok(withExtras.reasons.some((x) => x.field === "extras"));
  assert.ok(without.matched, "missing extras must not rule it out");
});
