import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMatch, cluster, candidatePairs, type Candidate } from "./score";
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
