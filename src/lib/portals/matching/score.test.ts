import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreMatch,
  cluster,
  candidatePairs,
  incoherentAreas,
  incoherentMembers,
  looksLikeMandateRef,
  type Candidate,
} from "./score";
import { containment, normaliseForCompare } from "./text";

/**
 * Fixtures are real text taken off Maisons et Appartements on 2026-08-25, not
 * invented prose. Deduplication thresholds tuned against made-up sentences are
 * tuned against nothing.
 */

const BARNES = `EXCLUSIVITE BARNES - Dans le secteur prisé de La Quessine, superbe bastide provençale d'environ 320 m² nichée au cœur d'un parc paysager d'1 hectare. En position dominante, elle offre une vue imprenable sur la mer, le Cap Taillat et la campagne environnante. La maison principale comprend un vaste salon, une cuisine, une salle à manger, le tout ouvert sur de grandes terrasses panoramiques. La partie nuit est composée de 8 chambres. Piscine, calme absolu et environnement naturel exceptionnel. Les informations sur les risques auxquels ce bien est exposé sont disponibles sur le site Géorisques : www.georisques.gouv.fr`;

/** The same listing as another portal truncates it. */
const BARNES_TRUNCATED = `EXCLUSIVITE BARNES - Dans le secteur prisé de La Quessine, superbe bastide provençale d'environ 320 m² nichée au cœur d'un parc paysager d'1 hectare. En position dominante, elle offre une vue imprenable sur la mer, le Cap Taillat et la campagne...`;

/** A different villa, same agency, sharing the mandatory legal footer. */
const OTHER_VILLA = `Villa contemporaine neuve à Gassin, 210 m² sur terrain de 1100 m², 4 chambres en suite, piscine à débordement, vue dégagée sur les vignes. Les informations sur les risques auxquels ce bien est exposé sont disponibles sur le site Géorisques : www.georisques.gouv.fr`;

const base: Omit<Candidate, "id"> = {
  sourceId: "s1",
  communeInsee: "83101",
  priceEur: 9_500_000,
  areaM2: 320,
  landM2: null,
  rooms: 10,
  agencyId: "ag1",
  agencyRef: null,
  title: "Ramatuelle",
  description: BARNES,
};

const c = (over: Partial<Candidate> & { id: string }): Candidate => ({ ...base, ...over });

test("the legally mandated footer is stripped before anything is compared", () => {
  const n = normaliseForCompare(BARNES);
  assert.ok(!n.includes("georisques"), "otherwise unrelated villas start at ~40% similar");
  assert.ok(!n.includes("risques auxquels"));
});

test("digits are dropped — portals round area and convert price", () => {
  assert.ok(!normaliseForCompare(BARNES).includes("320"));
});

test("a truncated copy is almost entirely contained in the full text", () => {
  assert.ok(containment(BARNES, BARNES_TRUNCATED) > 0.9);
});

test("a different villa from the same agency is not similar once the footer goes", () => {
  assert.ok(containment(BARNES, OTHER_VILLA) < 0.15);
});

test("the same listing on two portals merges", () => {
  const v = scoreMatch(c({ id: "a" }), c({ id: "b", sourceId: "s2" }));
  assert.equal(v.same, true);
  assert.ok(v.confidence > 0.9);
});

test("a matching mandate reference decides it outright, whatever the text says", () => {
  const v = scoreMatch(
    c({ id: "a", agencyRef: "86836462" }),
    c({ id: "b", sourceId: "s2", agencyRef: "86836462", description: "entirely different prose" }),
  );
  assert.equal(v.same, true);
  assert.equal(v.confidence, 1);
  assert.equal(v.signals.agencyRefExact, true);
});

test("a word in the reference field is not a mandate reference", () => {
  // Superimmo's parser stopped at the first space, so "VILLA LUMA-…" arrived as
  // "VILLA" and "SWI 1316" as "SWI". Three villas shared "VILLA" and five
  // listings shared "SWI"; eight properties became two, at 100% confidence.
  assert.equal(looksLikeMandateRef("VILLA"), false);
  assert.equal(looksLikeMandateRef("SWI"), false);
  assert.equal(looksLikeMandateRef("ref"), false);

  // A date has digits and is still not a key.
  assert.equal(looksLikeMandateRef("2025-09-12"), false);

  // Every real reference seen across the portals carries a digit.
  for (const real of ["313688", "V1958", "6138-NGU", "MPNO-A4I-P8D", "SWI 1316", "70880"]) {
    assert.equal(looksLikeMandateRef(real), true, real);
  }
});

test("a word-shaped reference cannot merge two villas at 100%", () => {
  const v = scoreMatch(
    c({ id: "a", agencyRef: "VILLA", priceEur: 5_490_000, areaM2: 356, description: "one villa" }),
    c({
      id: "b",
      sourceId: "s2",
      agencyRef: "VILLA",
      priceEur: 9_950_000,
      areaM2: 316,
      description: "a different villa entirely",
    }),
  );
  assert.equal(v.same, false, "€5.49M and €9.95M are not one property");
  assert.notEqual(v.signals.agencyRefExact, true);
});

test("a word-shaped reference is not treated as a conflict either", () => {
  // Junk on both sides means we know nothing, not that the agency told us they
  // are different. The decision has to fall through to price, area and text.
  const v = scoreMatch(
    c({ id: "a", agencyRef: "VILLA" }),
    c({ id: "b", sourceId: "s2", agencyRef: "SWI" }),
  );
  assert.notEqual(v.signals.agencyRefConflict, true);
});

test("different mandates from one agency are two properties, however alike they read", () => {
  const v = scoreMatch(c({ id: "a", agencyRef: "2365" }), c({ id: "b", sourceId: "s2", agencyRef: "2351" }));
  assert.equal(v.same, false);
  assert.equal(v.signals.agencyRefConflict, true);
});

test("a genuinely different villa does not merge", () => {
  const v = scoreMatch(
    c({ id: "a" }),
    c({ id: "b", sourceId: "s2", description: OTHER_VILLA, areaM2: 210, rooms: 5 }),
  );
  assert.equal(v.same, false);
});

test("different communes veto before any text is compared", () => {
  const v = scoreMatch(c({ id: "a" }), c({ id: "b", sourceId: "s2", communeInsee: "83068" }));
  assert.equal(v.same, false);
  assert.equal(v.signals.communeConflict, true);
});

test("a stale price on one portal does not split the property", () => {
  // Agencies update one portal and forget another for weeks. Vetoing on price
  // would split exactly the listings whose price history matters most.
  const v = scoreMatch(c({ id: "a" }), c({ id: "b", sourceId: "s2", priceEur: 8_900_000 }));
  assert.equal(v.same, true);
});

test("truncation by one portal does not split the property either", () => {
  const v = scoreMatch(c({ id: "a" }), c({ id: "b", sourceId: "s2", description: BARNES_TRUNCATED }));
  assert.equal(v.same, true);
});

test("clustering is transitive", () => {
  // A and C may never score above threshold against each other — one portal
  // truncated, another rewrote the title — but through B they are one property.
  const m = cluster(["a", "b", "c", "d"], [["a", "b"], ["b", "c"]]);
  assert.equal(m.get("a"), m.get("c"));
  assert.notEqual(m.get("d"), m.get("a"));
});

test("blocking compares within a commune and across the unplaced", () => {
  const pairs = candidatePairs([
    c({ id: "1", communeInsee: "83101" }),
    c({ id: "2", communeInsee: "83101" }),
    c({ id: "3", communeInsee: "83068" }),
    c({ id: "4", communeInsee: null }),
  ]);
  // (1,2) inside 83101, plus the unplaced one against all three.
  assert.equal(pairs.length, 4);
  assert.ok(
    !pairs.some(([x, y]) => (x.id === "1" && y.id === "3") || (x.id === "3" && y.id === "1")),
    "two different communes are never compared",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the 47-listing blob
//
// A full commune produced one "property" holding 47 listings priced from €739k
// to €7.8M. Cause: Green-Acres descriptions were parsed from og:description —
// median 49 characters — so containment divided by three or four shingles and
// returned a perfect 1.0 for any two listings sharing a stock phrase. Transitive
// clustering then welded the accidents together.
//
// Three guards now stand against it, and each is tested separately because each
// would have been enough on its own.
// ─────────────────────────────────────────────────────────────────────────────

/** Real BARNES prose — long enough for the text signal to be legitimate. */
const LONG_TEXT = BARNES;

/** Build a candidate from the file's base fixture. */
function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return { ...base, agencyRef: null, ...over };
}

const SHORT_A = "Villa vue mer proche plage Ramatuelle";
const SHORT_B = "Villa vue mer proche plage Sainte-Maxime";

test("a headline-length description cannot drive a merge", () => {
  // Prices deliberately unequal: this test is about the text guard alone, and
  // an identical price would let the structural rule merge them before the
  // text is ever looked at — a different rule, tested below on its own terms.
  const a = candidate({ id: "a", description: SHORT_A, priceEur: 739_000, areaM2: 90 });
  const b = candidate({ id: "b", description: SHORT_B, priceEur: 745_000, areaM2: 90 });

  const v = scoreMatch(a, b);
  assert.equal(v.same, false, "39 characters is not evidence of anything");
  assert.equal(v.signals.textTooShort, true);
});

test("identical prose alone does not merge — something measurable must agree", () => {
  // Two neighbouring villas sharing an agency's stock paragraph, no price or
  // area on either side to corroborate.
  const prose = LONG_TEXT;
  const a = candidate({ id: "a", description: prose, priceEur: null, areaM2: null });
  const b = candidate({ id: "b", description: prose, priceEur: null, areaM2: null });

  assert.equal(scoreMatch(a, b).same, false);
});

test("identical prose plus an agreeing price does merge", () => {
  const a = candidate({ id: "a", description: LONG_TEXT, priceEur: 2_000_000, areaM2: 200 });
  const b = candidate({ id: "b", description: LONG_TEXT, priceEur: 2_000_000, areaM2: 200 });

  assert.equal(scoreMatch(a, b).same, true);
});

test("a price gap of more than a third vetoes, however similar the text", () => {
  const a = candidate({ id: "a", description: LONG_TEXT, priceEur: 739_000, areaM2: 200 });
  const b = candidate({ id: "b", description: LONG_TEXT, priceEur: 7_800_000, areaM2: 200 });

  const v = scoreMatch(a, b);
  assert.equal(v.same, false);
  assert.equal(v.signals.priceConflict, true);
});

test("a stale price on one portal still merges — that is the normal case", () => {
  // An agency updated one portal and forgot the other. 4% apart.
  const a = candidate({ id: "a", description: LONG_TEXT, priceEur: 2_000_000, areaM2: 200 });
  const b = candidate({ id: "b", description: LONG_TEXT, priceEur: 1_920_000, areaM2: 200 });

  assert.equal(scoreMatch(a, b).same, true, "area agrees, price is merely stale");
});

test("an incoherent cluster is broken apart after the fact", () => {
  // The last line of defence: whatever the pair scores said, this is not one
  // house. Independent of the scoring, which is the point of having it.
  const outliers = incoherentMembers([
    { id: "a", priceEur: 739_000 },
    { id: "b", priceEur: 780_000 },
    { id: "c", priceEur: 7_800_000 },
  ]);
  assert.deepEqual(outliers, ["c"]);
});

test("a coherent cluster is left alone", () => {
  assert.deepEqual(
    incoherentMembers([
      { id: "a", priceEur: 2_000_000 },
      { id: "b", priceEur: 1_950_000 },
      { id: "c", priceEur: 2_050_000 },
    ]),
    [],
  );
});

test("an incoherent cluster always loses a member, even with no lone outlier", () => {
  /**
   * The three Superimmo listings that were merged on the reference "VILLA".
   * Ends 45% apart, so the span check fires — but each of them sits within 30%
   * of the €6.99M in the middle, so the outlier rule evicts nobody. The group
   * used to survive intact with the guard appearing to have run.
   */
  const evicted = incoherentMembers([
    { id: "cheap", priceEur: 5_490_000 },
    { id: "middle", priceEur: 6_990_000 },
    { id: "dear", priceEur: 9_950_000 },
  ]);

  assert.ok(evicted.length > 0, "reporting incoherence and evicting nobody is the worst outcome");
  assert.ok(!evicted.includes("middle"), "the side holding the median stays");
  assert.deepEqual(evicted, ["dear"], "split at the widest gap: 6.99 → 9.95");
});

test("a cluster with no prices is not split — unknown is not a conflict", () => {
  assert.deepEqual(
    incoherentMembers([
      { id: "a", priceEur: null },
      { id: "b", priceEur: null },
    ]),
    [],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// MEASUREMENTS WITHOUT PROSE
//
// Live on 2026-09-04: one Ramatuelle villa listed by two agencies, 25 000 000 €
// and 600 m² on both, 2730 m² of land on both, twelve rooms on both, two
// entirely different paragraphs and two different photographs. Nothing in the
// text rules could ever join them.
// ─────────────────────────────────────────────────────────────────────────────

test("one price, one floor area, one commune — merged without any shared prose", () => {
  const a = candidate({
    id: "a",
    description: "Au cœur d'un des domaines les plus exclusifs de la presqu'île, face à Pampelonne.",
    priceEur: 25_000_000,
    areaM2: 600,
    landM2: 2730,
    rooms: 12,
  });
  const b = candidate({
    id: "b",
    sourceId: "s2",
    description: "Villa with spectacular sea view, 7 suites and a staff apartment, secured domain.",
    priceEur: 25_000_000,
    areaM2: 600,
    landM2: 2730,
    rooms: 12,
  });

  const v = scoreMatch(a, b);
  assert.equal(v.same, true);
  assert.equal(v.signals.structuralOnly, true);
  assert.ok(v.confidence >= 0.8, "must clear the default match threshold or it merges nothing");
});

test("a disagreeing room count does not stop it — portals count rooms differently", () => {
  const a = candidate({ id: "a", priceEur: 25_000_000, areaM2: 600, rooms: 10, description: "x" });
  const b = candidate({
    id: "b",
    sourceId: "s2",
    priceEur: 25_000_000,
    areaM2: 600,
    rooms: 12,
    description: "y",
  });

  const v = scoreMatch(a, b);
  assert.equal(v.same, true);
  assert.equal(v.signals.roomsEqual, false);
});

test("a disagreeing plot does stop it — two houses cannot share the ground", () => {
  const a = candidate({ id: "a", priceEur: 25_000_000, areaM2: 600, landM2: 2730, description: "x" });
  const b = candidate({
    id: "b",
    sourceId: "s2",
    priceEur: 25_000_000,
    areaM2: 600,
    landM2: 8000,
    description: "y",
  });

  const v = scoreMatch(a, b);
  assert.equal(v.same, false);
  assert.equal(v.signals.landConflict, true);
});

test("a price that is merely close is not enough on measurements alone", () => {
  // 1% apart. Enough to corroborate shared prose, not enough to stand in for it.
  const a = candidate({ id: "a", priceEur: 25_000_000, areaM2: 600, description: "x" });
  const b = candidate({ id: "b", sourceId: "s2", priceEur: 24_750_000, areaM2: 600, description: "y" });

  assert.equal(scoreMatch(a, b).same, false);
});

test("two listings with no price agree on nothing", () => {
  const a = candidate({ id: "a", priceEur: null, areaM2: null, description: "x" });
  const b = candidate({ id: "b", sourceId: "s2", priceEur: null, areaM2: null, description: "y" });

  assert.equal(scoreMatch(a, b).same, false);
});

test("a cluster incoherent in AREA is broken apart, however equal the prices", () => {
  // Ramatuelle, live: one cluster of listings all priced 5 300 000 €, floor
  // areas 480, 483, 482 and 355 m². Two villas sharing a price, chained
  // together by measurement-only merges. The price guard cannot see it —
  // the prices are identical, which is why the merges happened at all.
  const outliers = incoherentAreas([
    { id: "a", areaM2: 480 },
    { id: "b", areaM2: 483 },
    { id: "c", areaM2: 482 },
    { id: "d", areaM2: 355 },
  ]);
  assert.deepEqual(outliers, ["d"]);
});

test("rounding differences between portals are not incoherence", () => {
  assert.deepEqual(
    incoherentAreas([
      { id: "a", areaM2: 344.94 },
      { id: "b", areaM2: 345 },
      { id: "c", areaM2: 350 },
    ]),
    [],
  );
});
