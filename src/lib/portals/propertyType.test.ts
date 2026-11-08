import { test } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_TYPES, canonicalPropertyType, kindNamed } from "./propertyType";

// Every type stored on an active listing on 2026-11-08, with a title it came with.
test("each portal's word becomes the client's", () => {
  const cases: [string, string, string | null][] = [
    ["Maison", "", "Maison"],
    ["Appartement", "", "Appartement"],
    ["House", "Villa with sea view", "Maison"],
    ["Apartment", "", "Appartement"],
    ["Villa", "", "Maison"],
    ["Demeure-de-prestige", "Achat : Demeure de prestige (83310)", "Maison"],
    ["Hôtel particulier", "", "Maison"],
    ["Terrain", "", "Terrain"],
    ["Landform", "Building Land in Cavalaire-sur-Mer", "Terrain"],
    ["Commerce", "", "Commerce"],
    ["Local-commercial", "", "Commerce"],
    ["Local", "À VENDRE – DROIT AU BAIL – SAINTE-MAXIME", "Commerce"],
    ["Bureau", "", "Bureau"],
    ["Parking", "", "Parking"],
    ["Parking/garage", "", "Parking"],
    ["Immeuble", "", "Immeuble"],
  ];
  for (const [stated, title, want] of cases) assert.equal(canonicalPropertyType(stated, title), want, stated);
});

test("a generic type is read from the title, the kind it names first", () => {
  assert.equal(canonicalPropertyType("Immobilier", "Achat : Maison (83120)"), "Maison");
  assert.equal(canonicalPropertyType("Immobilier", "La Croix-Valmer – Maison Individuelle Vue Mer"), "Maison");
  assert.equal(canonicalPropertyType("Programme neuf", "MAGNIFIQUE MAISON T4 AVEC TERRASSE PLEIN SUD"), "Maison");
  assert.equal(canonicalPropertyType("Programme neuf", "VILLA MODERNE - T4 - CONFORT ET PRATICITÉ"), "Maison");
  assert.equal(canonicalPropertyType("Programme neuf", "Beau T3 avec terrasse, résidence neuve"), "Appartement");
  assert.equal(canonicalPropertyType("Accommodation", "10 room luxury Hotel for sale in Sainte-Maxime"), "Commerce");
  assert.equal(canonicalPropertyType("unknown", "Local Professionnel à vendre - Lumineux"), "Commerce");
  assert.equal(canonicalPropertyType(null, "SAINT-TROPEZ – LUXURIOUS 2-BEDROOM APARTMENT WITH TERRACES"), "Appartement");
  assert.equal(canonicalPropertyType("Terrain", "TERRAIN À BÂTIR – DOMAINE PRIVÉ À ROQUEBRUNE"), "Terrain");
});

test("nothing named stays null: 'not published' does not disqualify a buyer, a wrong word does", () => {
  assert.equal(canonicalPropertyType("Neuf", "Achat : Programme neuf (83120)"), null);
  assert.equal(canonicalPropertyType("Bien", "Sainte-Maxime - Bien à vendre - 238 m² - 1 500 000 €"), null);
  assert.equal(canonicalPropertyType("Autre", "Achat : Autre (83520)"), null);
  assert.equal(canonicalPropertyType("unknown", ""), null);
  assert.equal(canonicalPropertyType(null, null), null);
});

test("words inside other words do not count", () => {
  assert.equal(kindNamed("Barbecue et masure"), null);
  assert.equal(kindNamed("Localisation idéale"), null);
  assert.equal(kindNamed("Maison avec garage"), "Maison");
});

test("every answer is one of the client's words", () => {
  for (const t of ["House", "Landform", "Local-commercial", "Immobilier", "Programme neuf"]) {
    const out = canonicalPropertyType(t, "Maison T4");
    assert.ok(out === null || (CANONICAL_TYPES as readonly string[]).includes(out), t);
  }
});
