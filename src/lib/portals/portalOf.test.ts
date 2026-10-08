import { test } from "node:test";
import assert from "node:assert/strict";
import { carriedPortals, portalKey, portalLinks, portalOf } from "./portalOf";

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

test("an aggregator row becomes every portal it carries, each with its own link and date", () => {
  const carried = [
    { source: "seloger", url: "https://www.seloger.com/annonces/achat/x/260823763.htm", publishedAt: "2026-09-01T10:00:00Z" },
    { source: "leboncoin", url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2390139342", publishedAt: "2026-09-05T10:00:00Z" },
    { source: "co", url: "https://www.rightmove.co.uk/properties/150123456", publishedAt: null },
  ];
  const ps = carriedPortals("stream-estate", carried[0].url, carried);
  assert.deepEqual(ps.map((p) => p.key), ["seloger", "leboncoin", "rightmove"]);
  assert.equal(ps[1].url, carried[1].url);
  assert.equal(ps[1].publishedAt, "2026-09-05T10:00:00Z");
  for (const p of ps) assert.equal(p.via, "Stream.Estate");
  // A source that is not an aggregator carries nothing.
  assert.deepEqual(carriedPortals("vizzit", "https://www.vizzit.fr/x", carried), []);
});

test("a portal we read ourselves wins over the same portal seen through the aggregator", () => {
  const links = portalLinks(
    [
      { source: "vizzit", url: "https://www.vizzit.fr/acheter/ours" },
      {
        source: "stream-estate",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/1",
        carried: [
          { url: "https://www.vizzit.fr/acheter/theirs" },
          { url: "https://www.leboncoin.fr/ad/ventes_immobilieres/1" },
        ],
      },
    ],
    { vizzit: "Vizzit" },
  );
  assert.deepEqual(links.map((l) => [l.key, l.via ?? null]), [["vizzit", null], ["leboncoin", "Stream.Estate"]]);
  assert.equal(links[0].url, "https://www.vizzit.fr/acheter/ours");
});

test("both Maisons et Appartements sites are our smc source", () => {
  assert.equal(portalKey("https://www.maisonsetappartements.fr/fr/vente/x"), "smc");
  assert.equal(portalKey("https://www.residences-immobilier.com/fr/vente/x"), "smc");
});

test("an agency's own website is shown as 'Agency websites', a portal as itself", () => {
  const ps = carriedPortals("stream-estate", "https://www.seloger.com/a/1.htm", [
    { url: "https://www.tardieu.fr/vente/123" },
    { url: "https://www.orpi.com/annonce-vente-1/" },
    { url: "https://www.seloger.com/a/1.htm" },
  ]);
  assert.deepEqual(ps.map((p) => [p.key, p.name]), [["agency-sites", "Agency websites"], ["seloger", "SeLoger"]]);
  assert.equal(ps[0].url, "https://www.tardieu.fr/vente/123", "the link still opens the agency's site");
});
