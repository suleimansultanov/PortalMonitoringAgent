import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreMatch,
  cluster,
  candidatePairs,
  incoherentAreas,
  incoherentMembers,
  looksLikeMandateRef,
  splitIncoherent,
  areaTolerance,
  clusterCandidates,
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
  bedrooms: 6,
  propertyType: "Maison",
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

test("a stale price on one portal splits the property, by decision", () => {
  // This test asserted the opposite until 2026-09-04, and the reasoning was
  // good: agencies update one portal and forget another for weeks, and vetoing
  // on price splits exactly the listings whose price history matters most.
  //
  // A development overrules it. Identical flats a few percent apart in price,
  // sharing one developer's description word for word, cannot be told apart by
  // anything else — so price equality became a precondition, and a stale price
  // now costs a duplicate card rather than a hidden property.
  const v = scoreMatch(c({ id: "a" }), c({ id: "b", sourceId: "s2", priceEur: 8_900_000 }));
  assert.equal(v.same, false);
  assert.equal(v.signals.priceConflict, true);
});

test("a price on one side only is not a disagreement", () => {
  // Half the portals publish "prix sur demande". That is silence, not a
  // different price, and it must not block a merge the text supports.
  const v = scoreMatch(c({ id: "a" }), c({ id: "b", sourceId: "s2", priceEur: null }));
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
  // One side carries no figures at all, so nothing else can decide this: a
  // disagreement would be vetoed before the text is read, and an agreement
  // would be merged by the measurement rule. Silence leaves the text alone
  // with the question, which is what this test is about.
  const a = candidate({ id: "a", description: SHORT_A, priceEur: 739_000, areaM2: 90 });
  const b = candidate({ id: "b", description: SHORT_B, priceEur: null, areaM2: null });

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

test("any price gap vetoes, however similar the text", () => {
  const a = candidate({ id: "a", description: LONG_TEXT, priceEur: 739_000, areaM2: 200 });
  const b = candidate({ id: "b", description: LONG_TEXT, priceEur: 7_800_000, areaM2: 200 });

  const v = scoreMatch(a, b);
  assert.equal(v.same, false);
  assert.equal(v.signals.priceConflict, true);
});

test("a stale price on one portal now splits it — deliberately", () => {
  // 4% apart, identical prose. This USED to merge, on the grounds that an
  // agency updates one portal and forgets another. It no longer does, because
  // a development prices identical flats a few percent apart and no text rule
  // can tell those apart. The cost is a visible duplicate until the portal
  // catches up, and that is the failure this project prefers.
  const a = candidate({ id: "a", description: LONG_TEXT, priceEur: 2_000_000, areaM2: 200 });
  const b = candidate({ id: "b", description: LONG_TEXT, priceEur: 1_920_000, areaM2: 200 });

  const v = scoreMatch(a, b);
  assert.equal(v.same, false);
  assert.equal(v.signals.priceConflict, true);
});

test("a mandate reference still outranks a price that disagrees", () => {
  // The one exception: same agency, same mandate number is the agency saying
  // these are one property.
  const v = scoreMatch(
    c({ id: "a", agencyRef: "313688", priceEur: 2_000_000 }),
    c({ id: "b", sourceId: "s2", agencyRef: "313688", priceEur: 1_920_000 }),
  );
  assert.equal(v.same, true);
  assert.equal(v.confidence, 1);
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

// ─────────────────────────────────────────────────────────────────────────────
// A DEVELOPMENT
//
// Résidence Patio Ruben, Saint-Tropez, live on 2026-09-04: thirty-four listings
// on six portals in one property, holding at least two different flats. The
// developer writes one description for the building, so the text signal between
// two different flats is a perfect 1.0.
// ─────────────────────────────────────────────────────────────────────────────

const PATIO_RUBEN = `Résidence Patio Ruben, au cœur de Saint-Tropez, à quelques pas de la place des Lices et des plages. Appartements neufs de standing avec terrasses, jardin privatif, piscine et stationnement en sous-sol. Prestations haut de gamme, livraison prévue au printemps.`;

const flat = (over: Partial<Candidate> & { id: string }): Candidate =>
  candidate({ propertyType: "Appartement", description: PATIO_RUBEN, ...over });

test("differing bedroom counts do not stop a merge — portals disagree about those too", () => {
  // 8 bedrooms on one portal and 10 on another is one house counted twice,
  // not two houses. Rooms and bedrooms describe the same property differently
  // on every portal; only the price is allowed to veto.
  const a = candidate({ id: "a", priceEur: 4_400_000, areaM2: 345, rooms: 9, bedrooms: 8 });
  const b = candidate({ id: "b", sourceId: "s2", priceEur: 4_400_000, areaM2: 345, rooms: 12, bedrooms: 10 });

  assert.equal(scoreMatch(a, b).same, true);
});

test("two flats in one development do not merge on the developer's own prose", () => {
  const t3 = flat({ id: "a", priceEur: 2_350_000, areaM2: 82, rooms: 3, bedrooms: 2 });
  const t4 = flat({ id: "b", sourceId: "s2", priceEur: 2_450_000, areaM2: 85, rooms: 4, bedrooms: 3 });

  const v = scoreMatch(t3, t4);
  assert.equal(v.same, false);
  assert.equal(v.signals.priceConflict, true);
});

test("same size, same layout, different price — still two flats", () => {
  // The pair that has no bedroom count on either side: identical title, one at
  // 2 350 000 € and one at 2 450 000 €, four floors apart.
  const lower = flat({ id: "a", priceEur: 2_350_000, areaM2: 82, rooms: 3, bedrooms: null });
  const upper = flat({ id: "b", sourceId: "s2", priceEur: 2_450_000, areaM2: 82, rooms: 3, bedrooms: null });

  const v = scoreMatch(lower, upper);
  assert.equal(v.same, false);
  assert.equal(v.signals.priceConflict, true);
});

test("one flat on two portals still merges", () => {
  const a = flat({ id: "a", priceEur: 2_350_000, areaM2: 81.5, rooms: 3, bedrooms: 2 });
  const b = flat({ id: "b", sourceId: "s2", priceEur: 2_350_000, areaM2: 82, rooms: 4, bedrooms: 2 });

  assert.equal(scoreMatch(a, b).same, true, "rooms disagree between portals; that is normal");
});


test("a floor area that disagrees beyond rounding vetoes, like the price", () => {
  const a = candidate({ id: "a", description: LONG_TEXT, priceEur: 5_300_000, areaM2: 480 });
  const b = candidate({ id: "b", sourceId: "s2", description: LONG_TEXT, priceEur: 5_300_000, areaM2: 355 });

  const v = scoreMatch(a, b);
  assert.equal(v.same, false);
  assert.equal(v.signals.areaConflict, true);
});

test("but rounding between portals is not a disagreement", () => {
  // The same Ramatuelle villa: 344,94 from the mandate, 350 from the headline.
  const a = candidate({ id: "a", description: LONG_TEXT, priceEur: 4_400_000, areaM2: 344.94 });
  const b = candidate({ id: "b", sourceId: "s2", description: LONG_TEXT, priceEur: 4_400_000, areaM2: 350 });

  assert.equal(scoreMatch(a, b).same, true);
});

test("two agencies measuring one villa differently still merge when the plot agrees", () => {
  // Ramatuelle, 19 500 000 €: Michaël Zingraf says 430 m² on 11 000 m², Côte
  // d'Azur Sotheby's says 400 m² on 10 653 m². One villa, two mandates.
  const zingraf = candidate({
    id: "a",
    description: LONG_TEXT,
    priceEur: 19_500_000,
    areaM2: 430,
    landM2: 11_000,
  });
  const sothebys = candidate({
    id: "b",
    sourceId: "s2",
    description: LONG_TEXT,
    priceEur: 19_500_000,
    areaM2: 400,
    landM2: 10_653,
  });

  assert.equal(scoreMatch(zingraf, sothebys).same, true);
});

test("without a plot, the same price and a floor area within 20% are one house — agreed with the client 2026-10-15", () => {
  // An unstated plot does not block. A tenth instead was tried on 2026-10-19
  // and reverted: see the note at AREA_TOLERANCE_SAME_PRICE.
  const a = candidate({ id: "a", description: LONG_TEXT, priceEur: 19_500_000, areaM2: 430 });
  const b = candidate({ id: "b", sourceId: "s2", description: LONG_TEXT, priceEur: 19_500_000, areaM2: 400 });
  assert.equal(scoreMatch(a, b).same, true);

  // And past 20% it is still two.
  const c = candidate({ id: "c", sourceId: "s2", description: LONG_TEXT, priceEur: 19_500_000, areaM2: 330 });
  const v = scoreMatch(a, c);
  assert.equal(v.same, false);
  assert.equal(v.signals.areaConflict, true);
});

test("an agreeing plot does not excuse a floor area from another house", () => {
  // 480 against 355 at one price is the Ramatuelle weld that started this.
  const a = candidate({ id: "a", description: LONG_TEXT, priceEur: 5_300_000, areaM2: 480, landM2: 13_000 });
  const b = candidate({ id: "b", sourceId: "s2", description: LONG_TEXT, priceEur: 5_300_000, areaM2: 355, landM2: 13_100 });

  assert.equal(scoreMatch(a, b).same, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Price blocking (2026-10-15): fewer pairs, the same verdicts
// ─────────────────────────────────────────────────────────────────────────────

test("blocking by price and mandate finds every match that scoring all pairs finds", () => {
  // Deterministic pseudo-random corpus: few prices, few agencies, shared texts —
  // dense in exactly the collisions blocking must not lose.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const texts = [BARNES, BARNES_TRUNCATED, OTHER_VILLA, null];
  const list: Candidate[] = Array.from({ length: 160 }, (_, i) => ({
    ...base,
    id: String(i),
    sourceId: pick(["s1", "s2", "s3"]),
    communeInsee: pick(["83101", "83101", "83068", null]),
    priceEur: pick([9_500_000, 9_500_000, 9_400_000, 1_200_000, null]),
    areaM2: pick([320, 320, 210, null]),
    agencyId: pick(["ag1", "ag2", null]),
    agencyRef: pick(["Réf 70880", "réf 70880 ", "12345", null]),
    description: pick(texts),
  }));

  const matches = (pairs: [Candidate, Candidate][]) =>
    new Set(
      pairs
        .filter(([a, b]) => scoreMatch(a, b).same)
        .map(([a, b]) => [a.id, b.id].sort().join("|")),
    );

  // The pairing before blocking by price: every pair in a commune, and the unplaced against all.
  const everyPair: [Candidate, Candidate][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]];
      if (a.communeInsee === b.communeInsee || a.communeInsee === null || b.communeInsee === null) everyPair.push([a, b]);
    }
  }

  const blocked = candidatePairs(list);
  assert.ok(blocked.length < everyPair.length, "blocking has to remove something to be worth having");
  const byId = new Map(list.map((x) => [x.id, x]));
  const all = [...matches(everyPair)].map((k) => k.split("|").map((id) => byId.get(id)!));
  assert.ok(all.some(([a, b]) => a.priceEur !== null && b.priceEur !== null && a.priceEur !== b.priceEur),
    "the corpus must hold a mandate match across two prices, or the exception is untested");
  assert.ok(all.some(([a, b]) => a.communeInsee === null || b.communeInsee === null),
    "and a match reaching an unplaced listing");
  assert.deepEqual([...matches(blocked)].sort(), [...matches(everyPair)].sort());
});

// ─────────────────────────────────────────────────────────────────────────────
// Eviction (2026-10-15): what is split out stays split, regrouped, and the loop ends
// ─────────────────────────────────────────────────────────────────────────────

type Row = { id: string; priceEur: number | null; areaM2: number | null; landM2: number | null; propertyType: string | null };
const row = (id: string, priceEur: number | null, areaM2: number | null, landM2: number | null = null): Row =>
  ({ id, priceEur, areaM2, landM2, propertyType: "Maison" });

test("an outlier that is the cluster's own key does not overwrite the members kept", () => {
  // Union-find named the cluster after "x", and "x" is the one that does not fit.
  const groups = new Map([["x", [row("x", 1_000_000, 480), row("a", 1_000_000, 355), row("b", 1_000_000, 356)]]]);
  splitIncoherent(groups);
  const sets = [...groups.values()].map((g) => g.map((r) => r.id).sort().join(","));
  assert.deepEqual(sets.sort(), ["a,b", "x"]);
});

test("listings split out together stay together when they still match each other", () => {
  // Three villas at one price, chained into one cluster; the guard keeps one,
  // and the other two come back as two properties — not as five single cards.
  const villa = (p: string, n: number, area: number) => Array.from({ length: n }, (_, i) => row(`${p}${i}`, 2_990_000, area));
  const all = [...villa("a", 4, 200), ...villa("b", 3, 300), ...villa("c", 2, 400)];
  const edges: [string, string][] = [];
  for (const p of ["a", "b", "c"]) {
    const ids = all.filter((r) => r.id.startsWith(p)).map((r) => r.id);
    for (let i = 1; i < ids.length; i++) edges.push([ids[0], ids[i]]);
  }
  edges.push(["a0", "b0"], ["b0", "c0"]); // the bad links that welded them
  const groups = new Map([["a0", all]]);
  splitIncoherent(groups, edges);
  const sets = [...groups.values()].filter((g) => g.length > 0).map((g) => g.map((r) => r.id[0]).join(""));
  assert.deepEqual(sets.sort(), ["aaaa", "bbb", "cc"]);
});

test("price and area pointing at different medians still ends, with something kept", () => {
  // The member at the median price is an area outlier and vice versa — the
  // shape that made the two guards together evict everyone and loop for ever.
  const groups = new Map([
    ["k", [row("p1", 1_000_000, 100), row("p2", 1_000_000, 100), row("p3", 2_000_000, 300), row("p4", 2_000_000, 300), row("p5", 1_000_000, 300)]],
  ]);
  const edges: [string, string][] = [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p5"], ["p5", "p1"]];
  splitIncoherent(groups, edges);
  const members = [...groups.values()].flat().map((r) => r.id).sort();
  assert.deepEqual(members, ["p1", "p2", "p3", "p4", "p5"], "nobody lost, nobody twice");
});

test("same price, same commune: two agencies' floor areas may differ by 20% — La Croix-Valmer, ref 87276762", () => {
  const theirs = c({ id: "jt", communeInsee: "83048", priceEur: 4_490_000, areaM2: 210, landM2: 1423, agencyId: "johntaylor", description: OTHER_VILLA, title: null });
  const ours = c({ id: "me", communeInsee: "83048", priceEur: 4_490_000, areaM2: 179, landM2: 1423, agencyId: "med", description: BARNES, title: null });
  const v = scoreMatch(ours, theirs);
  assert.equal(v.same, true);
  assert.equal(v.signals.samePriceBand, true);
  assert.ok(v.confidence >= 0.8);
  // An unstated plot does not block it.
  assert.equal(scoreMatch({ ...ours, landM2: null }, { ...theirs, landM2: null }).same, true);
});

test("the 20% band stops at 20%, at a plot 20% off, at flats, bare plots and two prices", () => {
  const house = { communeInsee: "83048", priceEur: 4_490_000, areaM2: 200, landM2: 1500, propertyType: "Maison", description: BARNES, title: null };
  const other = { ...house, description: OTHER_VILLA };
  assert.equal(scoreMatch(c({ id: "1", ...house }), c({ id: "2", ...other, areaM2: 245 })).same, true, "area 18% apart: one house");
  assert.equal(scoreMatch(c({ id: "1", ...house }), c({ id: "2", ...other, areaM2: 260 })).same, false, "area 23% apart: two");
  assert.equal(scoreMatch(c({ id: "1", ...house }), c({ id: "2", ...other, areaM2: 230, landM2: 2000 })).same, false, "plot 25% apart: two");
  assert.equal(scoreMatch(c({ id: "1", ...house }), c({ id: "2", ...other, areaM2: 230, priceEur: 4_400_000 })).same, false, "two prices: two");
  assert.equal(areaTolerance(c({ id: "1", ...house, propertyType: "Appartement" }), c({ id: "2", ...house })) < 0.2, true, "flats keep Carrez");
  assert.equal(areaTolerance(c({ id: "1", ...house, propertyType: "Terrain" }), c({ id: "2", ...house })) < 0.2, true, "bare plots too");
  assert.equal(areaTolerance(c({ id: "1", ...house, propertyType: "Local" }), c({ id: "2", ...house, propertyType: "Commerce" })) < 0.2, true, "and premises");
  assert.equal(areaTolerance(c({ id: "1", ...house }), c({ id: "2", ...house, landM2: 1300 })), 0.2);
});

// ─────────────────────────────────────────────────────────────────────────────
// The cluster guard after 2026-10-18: one bad row is one row, not the band
// ─────────────────────────────────────────────────────────────────────────────

test("one odd plot under a villa is evicted on its own; it does not tighten the band for thirty rows — Cavalaire, 1 490 000 €", () => {
  // Three agencies, 188–215 m² on 1 500–1 580 m²; one portal's row says 923 m² of land.
  const rows = [
    { id: "odd1", areaM2: 184, landM2: 923, propertyType: "Maison" },
    { id: "odd2", areaM2: 184, landM2: 923, propertyType: "Maison" },
    { id: "a1", areaM2: 188, landM2: 1500, propertyType: "Maison" },
    { id: "a2", areaM2: 188.3, landM2: 1550, propertyType: "Maison" },
    { id: "a3", areaM2: 190, landM2: 1580, propertyType: "Maison" },
    { id: "a4", areaM2: 197, landM2: null, propertyType: "Maison" },
    { id: "b1", areaM2: 207, landM2: 1580, propertyType: "Maison" },
    { id: "c1", areaM2: 215, landM2: 1579, propertyType: "Maison" },
  ];
  assert.deepEqual(incoherentAreas(rows), [], "most plots agree, so the band is the house band: 184 to 215 is one house");
});

test("plots that split down the middle keep the strict band — Grimaud, 3 950 000 €: 330 m² on 2 500 against 400 m² on 3 239–4 000", () => {
  const rows = [
    { id: "a1", areaM2: 330, landM2: 2500, propertyType: "Maison" },
    { id: "a2", areaM2: 340, landM2: 2500, propertyType: "Maison" },
    { id: "a3", areaM2: 340, landM2: 2500, propertyType: "Maison" },
    { id: "b1", areaM2: 380, landM2: 3239, propertyType: "Maison" },
    { id: "b2", areaM2: 400, landM2: 4000, propertyType: "Maison" },
    { id: "b3", areaM2: 400, landM2: 4000, propertyType: "Maison" },
  ];
  const evicted = incoherentAreas(rows);
  assert.ok(evicted.length > 0, "two plots, 18% of floor area apart: two houses");
  assert.ok(evicted.every((id) => id.startsWith("a")) || evicted.every((id) => id.startsWith("b")), `one side goes whole: ${evicted}`);
});

test("a chain within a fifth of its median is one house; past thirty per cent end to end it is cut at the widest gap — Sainte-Maxime, 2 950 000 €", () => {
  const house = (id: string, areaM2: number) => ({ id, areaM2, propertyType: "Maison" });
  assert.deepEqual(incoherentAreas([house("a", 130), house("b", 148), house("c", 160), house("d", 167)]), [], "22% end to end, every area within 20% of 160");
  const cut = incoherentAreas([house("a", 279), house("b", 280), house("c", 325), house("d", 325), house("e", 378), house("f", 400), house("g", 402)]);
  assert.deepEqual(cut.sort(), ["e", "f", "g"], "30.6% end to end: cut at 325 → 378, the side with the median stays");
});

test("a minority of rows typed as a flat does not hold a house to the Carrez band; a majority does", () => {
  const rows = [
    { id: "a", areaM2: 148, landM2: 650, propertyType: "Maison" },
    { id: "b", areaM2: 160, landM2: 625, propertyType: "Immobilier" },
    { id: "c", areaM2: 165, landM2: null, propertyType: "Appartement" },
    { id: "d", areaM2: 167, landM2: 625, propertyType: "Maison" },
    { id: "e", areaM2: 167, landM2: null, propertyType: "Appartement" },
  ];
  assert.deepEqual(incoherentAreas(rows), [], "three of five say house: 148 to 167 is one house");
  const flats = rows.map((r) => ({ ...r, propertyType: "Appartement" }));
  assert.ok(incoherentAreas(flats).length > 0, "all flats: 148 against 167 is two flats");
});

test("a pair typed house on one portal and flat on another gets the ordinary band, not Carrez", () => {
  const base = { communeInsee: "83115", priceEur: 595_000, areaM2: 148, landM2: 650 };
  const house = c({ id: "h", ...base, propertyType: "Maison" });
  const flat = c({ id: "f", ...base, propertyType: "Appartement" });
  assert.equal(areaTolerance(house, flat) >= 0.03, true);
  assert.equal(areaTolerance(flat, c({ id: "f2", ...base, propertyType: "Appartement" })), 0.015);
});

test("clusterCandidates groups what matched and keeps the strongest evidence per listing", () => {
  const a = c({ id: "a", agencyId: "ag", agencyRef: "70880", description: BARNES });
  const b = c({ id: "b", sourceId: "s2", agencyId: "ag", agencyRef: "70880", description: BARNES_TRUNCATED });
  const other = c({ id: "o", sourceId: "s3", priceEur: 1_000_000, description: OTHER_VILLA });
  const r = clusterCandidates([a, b, other], 0.8);
  const groups = [...r.groups.values()].map((ids) => ids.sort().join(",")).sort();
  assert.deepEqual(groups, ["a,b", "o"]);
  assert.equal(r.bestSignals.get("a")?.signals.agencyRefExact, true);
  assert.equal(r.evicted, 0);
});

test("a switched-off collector's row joins by its mandate, never by size at the price it had when it stopped", () => {
  // Sainte-Maxime, 2026-10-26: M0268vm is 1 695 000 € today; Figaro's August
  // row still says 1 790 000 €, and at that price it matched a different home.
  const shape = { communeInsee: "83115", title: null, description: null, propertyType: "Maison" };
  const now = c({ id: "now", sourceId: "live", agencyId: "janssens", agencyRef: "M0268vm", priceEur: 1_695_000, areaM2: 127, landM2: 815, ...shape });
  const august = c({ id: "aug", sourceId: "figaro", agencyId: "janssens", agencyRef: "M0268vm", priceEur: 1_790_000, areaM2: 127, landM2: 815, ...shape });
  const other = c({ id: "other", sourceId: "live2", agencyId: "barnes", agencyRef: "85300505", priceEur: 1_790_000, areaM2: 133, landM2: null, ...shape });
  const groups = (r: ReturnType<typeof clusterCandidates>) =>
    [...r.groups.values()].map((ids) => ids.sort().join(",")).sort();

  assert.deepEqual(groups(clusterCandidates([now, august, other], 0.8)), ["aug,now,other"], "without the veto: one card for two homes");
  assert.deepEqual(
    groups(clusterCandidates([now, august, other], 0.8, { staleSourceIds: new Set(["figaro"]) })),
    ["aug,now", "other"],
  );
});
