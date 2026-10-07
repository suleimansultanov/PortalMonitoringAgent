import { test } from "node:test";
import assert from "node:assert/strict";
import { portalKey, portalOf } from "./portalOf";

test("the portal is the label before the public suffix", () => {
  assert.equal(portalKey("https://www.bellesdemeures.com/annonces/vente/123"), "bellesdemeures");
  assert.equal(portalKey("https://www.leboncoin.fr/ad/ventes_immobilieres/2950123456"), "leboncoin");
  assert.equal(portalKey("https://immobilier.notaires.fr/fr/annonce-immo/123"), "notaires");
  assert.equal(portalKey("https://3gimmo.com/bien/42"), "3gimmo");
});

test("a .co.uk domain is not 'co'", () => {
  // Stream.Estate's own slug for both of these was "co" on 2026-10-07.
  assert.equal(portalKey("https://www.rightmove.co.uk/properties/150123456"), "rightmove");
  assert.equal(portalKey("https://www.patrice-besse.co.uk/property/553710"), "patrice-besse");
});

test("the two Figaro sites stay two portals, keyed as we collect them", () => {
  assert.equal(portalKey("https://proprietes.lefigaro.fr/annonces/123"), "figaro");
  assert.equal(portalKey("https://immobilier.lefigaro.fr/annonces/annonce-123.html"), "figaro-immobilier");
});

test("the keys of the portals we collect ourselves match our own source keys", () => {
  // `ownSources` is checked against these: a mismatch takes a property twice.
  assert.equal(portalKey("https://www.vizzit.fr/acheter/x"), "vizzit");
  assert.equal(portalKey("https://www.bienici.com/annonce/vente/x"), "bienici");
  assert.equal(portalKey("https://www.green-acres.fr/fr/properties/x.htm"), "green-acres");
  assert.equal(portalKey("https://www.luxuryestate.com/p123"), "luxuryestate");
  assert.equal(portalKey("https://www.etreproprio.com/annonce-x.html"), "etreproprio");
  assert.equal(portalKey("https://www.superimmo.com/annonces/x"), "superimmo");
});

test("a name for display: the brand where we know it, the host where we do not", () => {
  assert.deepEqual(portalOf("https://www.bellesdemeures.com/x"), { key: "bellesdemeures", name: "Belles Demeures" });
  assert.deepEqual(portalOf("https://www.rightmove.co.uk/x"), { key: "rightmove", name: "Rightmove" });
  assert.deepEqual(portalOf("https://www.janssens-immobilier.com/x"), {
    key: "janssens-immobilier",
    name: "janssens-immobilier.com",
  });
});

test("something that is not a URL has no portal", () => {
  assert.equal(portalKey("not a url"), null);
  assert.equal(portalOf(""), null);
});
