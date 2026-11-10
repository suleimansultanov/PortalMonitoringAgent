import { test } from "node:test";
import assert from "node:assert/strict";
import { licenceOnly, livingAreaFromText, programmePage } from "./textFacts";

test("a living area stated in words is read when the page has none", () => {
  // Green-Acres, La Garde-Freinet, 2026-11-10: no area field, this in the description.
  assert.equal(livingAreaFromText("Sur la commune de la Garde Freinet", "… plantés en vignes. La bâtisse de 160M² habitables construite avec des matériaux…"), 160);
  assert.equal(livingAreaFromText(null, "Villa offrant une surface habitable de 245 m² sur un terrain de 3 000 m²"), 245);
  assert.equal(livingAreaFromText(null, "Surface habitable : 85,5 m2. Jardin."), 85.5);
  assert.equal(livingAreaFromText(null, "Propriété de 1 200 m² habitables"), 1200);
  assert.equal(livingAreaFromText(null, "appartement de 62 m² environ habitables"), 62);
});

test("an area not said to be the living one is not read: it is as often the plot", () => {
  assert.equal(livingAreaFromText("Villa de 250 m²", "Terrain de 2 500 m2, piscine"), null);
  assert.equal(livingAreaFromText(null, "maison de 150 m2 environ, construite sur 2 niveaux"), null);
});

test("the first statement wins: the main house comes before the annex", () => {
  assert.equal(livingAreaFromText(null, "Maison de 180 m² habitables et maison d'amis de 45 m² habitables"), 180);
});

test("implausible figures are not a living area", () => {
  assert.equal(livingAreaFromText(null, "5 m² habitables"), null);
  assert.equal(livingAreaFromText(null, "surface habitable de 45 000 m²"), null);
});

test("an advert for a licence alone is not a property; a bar with its licence is", () => {
  assert.equal(licenceOnly("Licence IV à vendre ou à louer", null), true);
  assert.equal(licenceOnly("LICENCE 4 - CAVALAIRE", null), true);
  assert.equal(licenceOnly("SAINTE MAXIME - BAR, LICENCE 4, EMPLACEMENT N°1", null), false);
  assert.equal(licenceOnly("Licence IV et murs commerciaux", 120), false);
  assert.equal(licenceOnly("Restaurant–Bar Licence IV à Port-Grimaud", null), false);
});

test("a developer's programme page is not one property; a lot inside a programme is", () => {
  // The resellers Stream.Estate carried on 2026-11-10.
  assert.equal(programmePage("https://utopiaimmobilier.com/programmes/les-hauts-du-golfe-cogolin-0855a5"), true);
  assert.equal(programmePage("https://www.quoideneufimmo.fr/programmes/programme?0855a537ff11"), true);
  assert.equal(programmePage("https://acimmobilierneuf06.fr/programmes/programme?0e9db2690b01"), true);
  // Bien'ici sells programme lots one by one, under its ordinary advert path.
  assert.equal(programmePage("https://www.bienici.com/annonce/mgc-BPTLNJEGO281474977552126"), false);
  assert.equal(programmePage("https://www.seloger.com/annonces/achat/appartement/sainte-maxime-83/programme-neuf/123.htm"), false);
  assert.equal(programmePage("not a url"), false);
});

