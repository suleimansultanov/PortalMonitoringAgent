import { test } from "node:test";
import assert from "node:assert/strict";
import { placedAbroad } from "./abroad";

test("an agency-site advert for Phuket is abroad, by its URL alone or by its text", () => {
  // As Stream.Estate V1 delivered it on 2026-10-15, filed under Le Plan-de-la-Tour.
  assert.equal(
    placedAbroad("http://www.agence-immocenter.com/vente/-phuket/1328-kamala/22-propriete/t8/700-phuket-a-kamala-villa"),
    "phuket",
  );
  assert.equal(placedAbroad(null, "Achat : Maison (83120)", "CONDOMINIUM À VENDRE À KATHU – 2 400 000 THB – 62 000 € 25 m²"), "thb");
  assert.equal(placedAbroad("https://www.vizzit.fr/fr/property/maison/le-plan-de-la-tour/Aq4", "Villa", "Villa de luxe en Thaïlande"), "thaïlande");
});

test("what only looks foreign is not abroad", () => {
  assert.equal(placedAbroad(null, "Villa", "Piscine chauffée en pierre de Bali, pool house."), null);
  assert.equal(placedAbroad(null, "Villa", "Barnes : Paris, Cannes, Aix-en-Provence, Miami et 100 collaborateurs."), null);
  assert.equal(placedAbroad("https://www.seloger.com/annonces/achat/maison/sainte-maxime-83/thbx12.htm", "Maison", null), null);
  assert.equal(placedAbroad(null, null, null), null);
});
