import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, chooseExistingId } from "./resolve";

/**
 * The rule that decides whether a split actually lands.
 *
 * Everything else in `resolve` needs a database; this one decision does not,
 * and it is the one that was wrong.
 */

test("a group reuses the property row its listings already point at", () => {
  // Keeps bookmarked links alive across a nightly re-resolve.
  const claimed = new Set<string>();
  assert.equal(chooseExistingId([null, "prop-a", "prop-a"], claimed), "prop-a");
});

test("a row already taken by another group is not reused — this is the whole bug", () => {
  /**
   * Three villas were merged under one property on a truncated mandate
   * reference. The matcher split them correctly, then every one of the three
   * groups found the same old id on one of its listings, reused it, and
   * overwrote the others — putting all three back under a single row.
   *
   * Four hundred splits were computed and discarded exactly here.
   */
  const claimed = new Set<string>(["prop-a"]);
  assert.equal(chooseExistingId(["prop-a"], claimed), null, "must start a new property");
});

test("it falls through to the next unclaimed id rather than giving up", () => {
  const claimed = new Set<string>(["prop-a"]);
  assert.equal(chooseExistingId(["prop-a", "prop-b"], claimed), "prop-b");
});

test("a group of brand new listings gets a brand new property", () => {
  assert.equal(chooseExistingId([null, null], new Set()), null);
});

test("a property row belonging to another commune is never reused", () => {
  /**
   * Resolution runs one commune at a time and `claimed` is per-pass, so two
   * groups in two different communes never collide inside it. Both would find
   * the same stale property id on their listings and both would take it.
   *
   * That is how a 496 m² plot in Sainte-Maxime at €350k and a 2392 m² plot in
   * Roquebrune-sur-Argens at €1.05M ended up as one property — each commune's
   * own pass saw a perfectly coherent pair, and the price guard had nothing to
   * object to because it never saw all four together.
   */
  const ownedHere = new Set<string>(["mine"]);
  assert.equal(chooseExistingId(["theirs"], new Set(), ownedHere), null);
  assert.equal(chooseExistingId(["theirs", "mine"], new Set(), ownedHere), "mine");
});

test("without an ownership set the rule is unchanged", () => {
  // Callers that do not pass one — tests, future callers — keep the old
  // behaviour rather than silently refusing every reuse.
  assert.equal(chooseExistingId(["prop-a"], new Set()), "prop-a");
});

test("match signals compare equal whatever order Postgres hands the keys back in", () => {
  // As stored (jsonb orders keys by length, then bytes) …
  const stored = { areaClose: true, priceDelta: 0, priceEqual: true, roomsEqual: true, textJaccard: 1, textShingles: 95, textContainment: 1 };
  // … and as score.ts builds it (insertion order). Plain JSON.stringify never matched these.
  const built = { textShingles: 95, textJaccard: 1, textContainment: 1, priceEqual: true, priceDelta: 0, areaClose: true, roomsEqual: true };
  assert.notEqual(JSON.stringify(stored), JSON.stringify(built));
  assert.equal(canonicalJson(stored), canonicalJson(built));
  assert.notEqual(canonicalJson(stored), canonicalJson({ ...built, priceDelta: 1 }));
  assert.equal(canonicalJson([{ b: 1, a: [{ d: 1, c: 2 }] }]), canonicalJson([{ a: [{ c: 2, d: 1 }], b: 1 }]));
});
