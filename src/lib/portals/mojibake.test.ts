import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMojibake, repairMojibake, repairedText, unrepairable } from "./mojibake";

// Titles as they stood in portal_listings on 2026-11-08.
test("the garbled titles Stream.Estate and twimmo deliver come out as the agency wrote them", () => {
  assert.equal(repairMojibake("PropriÃ©tÃ© d'exception au cÅ“ur de la nature"), "Propriété d'exception au cœur de la nature");
  assert.equal(repairMojibake("GRIMAUD MAS PROVENÃ‡AL SUR 30HA AU CÅ’UR DU GOLFE"), "GRIMAUD MAS PROVENÇAL SUR 30HA AU CŒUR DU GOLFE");
  assert.equal(repairMojibake("CÅ“ur de Saint-Tropez | 91 mÂ² | 4 chambres"), "Cœur de Saint-Tropez | 91 m² | 4 chambres");
  assert.equal(repairMojibake("RAMATUELLE â€“ PropriÃ©tÃ© de charme"), "RAMATUELLE – Propriété de charme");
  assert.equal(repairMojibake("Villa avec vue mer Ã  moderniser Ã  Sainte-Maxime"), "Villa avec vue mer à moderniser à Sainte-Maxime");
});

test("clean French text is not touched, a real œ or É included", () => {
  for (const s of ["Maison au cœur du village", "TERRAIN À BÂTIR – DOMAINE PRIVÉ", "Propriété rénovée, 120 m²", "ÉLÉGANTE VILLA"]) {
    assert.equal(hasMojibake(s), false);
    assert.equal(repairMojibake(s), s);
    assert.equal(repairedText(s), s);
  }
});

test("a text garbled twice has lost a byte: one pass, flagged, never a second", () => {
  const twice = "vue panoramique mer-montagne, 360ÃÂ°. Elle comprend 750m²";
  assert.equal(unrepairable(twice), true);
  // What ingest stores is the single pass; the contract flags what is left.
  assert.equal(hasMojibake(repairedText(twice)!), true);
  assert.ok(!repairedText(twice)!.includes("ð"), "a second decode would invent ð");
});

test("null stays null and a partly garbled text keeps the rest", () => {
  assert.equal(repairedText(null), null);
  assert.equal(repairedText("Duplex rÃ©novÃ©, prestations soignées"), "Duplex rénové, prestations soignées");
});
