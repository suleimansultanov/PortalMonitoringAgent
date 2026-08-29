import { test } from "node:test";
import assert from "node:assert/strict";
import { collectCharacteristics, isEmpty } from "./attributes";

test("a labelled cell becomes an attribute, a bare one a flag", () => {
  const c = collectCharacteristics(["Orientation : Sud", "Piscine", "Vue sur mer"]);
  assert.deepEqual(c.attributes, { Orientation: "Sud" });
  assert.deepEqual(c.flags, ["Piscine", "Vue sur mer"]);
});

test("non-breaking spaces are normalised", () => {
  // French markup is full of them, and a label carrying one never matches a
  // label that does not.
  const c = collectCharacteristics(["Prix de vente : 4 400 000 €"]);
  assert.deepEqual(c.attributes, { "Prix de vente": "4 400 000 €" });
});

test("a sentence with a colon is not a label", () => {
  const long =
    "Les informations sur les risques auxquels ce bien est exposé sont disponibles : " +
    "www.georisques.gouv.fr";
  const c = collectCharacteristics([long]);
  assert.deepEqual(c.attributes, {});
  assert.deepEqual(c.flags, [long]);
});

test("a label with nothing after the colon is a flag", () => {
  assert.deepEqual(collectCharacteristics(["Alarme :"]).flags, ["Alarme"]);
});

test("duplicates and empties are dropped", () => {
  const c = collectCharacteristics(["Piscine", "  ", "Piscine", ""]);
  assert.deepEqual(c.flags, ["Piscine"]);
});

test("order is preserved so the block reads as the portal printed it", () => {
  const c = collectCharacteristics(["Cheminée", "Climatisation", "Cave"]);
  assert.deepEqual(c.flags, ["Cheminée", "Climatisation", "Cave"]);
});

test("nothing found is reported as empty rather than as empty objects", () => {
  assert.equal(isEmpty(collectCharacteristics([])), true);
  assert.equal(isEmpty(collectCharacteristics(["Piscine"])), false);
});
