import { test } from "node:test";
import assert from "node:assert/strict";
import { carriedPortals, portalKey, portalLinks, portalNamed, portalOf, servedListings } from "./portalOf";

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

test("a card's agency line that names a portal is recognised; an agency, a person or an agency's site is not", () => {
  // Every label below is one Vizzit's Saint-Tropez index printed on 2026-10-16.
  assert.equal(portalNamed("Seloger")?.key, "seloger");
  assert.equal(portalNamed("idealista.fr")?.key, "idealista");
  assert.equal(portalNamed("Rightmove")?.key, "rightmove");
  assert.equal(portalNamed("Belles Demeures")?.key, "bellesdemeures");
  assert.equal(portalNamed("Lux-Résidences")?.key, "lux-residence");
  assert.equal(portalNamed("tardieu.fr"), null, "an agency's own website is not a portal");
  assert.equal(portalNamed("meissler-co.com"), null);
  assert.equal(portalNamed("cotedazurestate.com"), null, "stored from the runner on 2026-10-15 — must stay fetched");
  assert.equal(portalNamed("EMILE GARCIN"), null);
  assert.equal(portalNamed("Romain Bressy"), null);
  assert.equal(portalNamed("Orpi"), null, "an agency network, not a listing portal");
  assert.equal(portalNamed(""), null);
  assert.equal(portalNamed(null), null);
});

// One SeLoger advert on one card, 2026-11-10: V1 read it on 15 Oct and reports only changes; V2 read it last night.
const row = (source: string, via: string | null, lastSeenAt: string | Date | null) => ({ source, via, lastSeenAt });

test("of two aggregators carrying one portal, the copy seen most recently is sent, in whatever order they come", () => {
  const v1 = row("seloger", "stream-estate-v1", "2026-10-15T01:00:00.000Z");
  const v2 = row("seloger", "stream-estate", "2026-11-10T03:40:00.000Z");
  assert.deepEqual(servedListings([v1, v2]), [v2]);
  assert.deepEqual(servedListings([v2, v1]), [v2]);
});

test("dates as Date objects compare the same as ISO strings (the health history passes Dates)", () => {
  const v1 = row("leboncoin", "stream-estate-v1", new Date("2026-10-15T01:00:00Z"));
  const v2 = row("leboncoin", "stream-estate", new Date("2026-11-10T03:40:00Z"));
  assert.deepEqual(servedListings([v1, v2]), [v2]);
});

test("a portal we read ourselves still wins over both, however fresh the aggregator's copy", () => {
  const direct = row("bienici", null, "2026-11-01T00:00:00.000Z");
  const v2 = row("bienici", "stream-estate", "2026-11-10T03:40:00.000Z");
  assert.deepEqual(servedListings([v2, direct]), [direct]);
});

test("a tie, or no date on either, keeps the first as before", () => {
  const a = row("pap", "stream-estate-v1", null);
  const b = row("pap", "stream-estate", null);
  assert.deepEqual(servedListings([a, b]), [a]);
  const c = row("pap", "stream-estate-v1", "2026-11-10T00:00:00.000Z");
  const d = row("pap", "stream-estate", "2026-11-10T00:00:00.000Z");
  assert.deepEqual(servedListings([c, d]), [c]);
});

test("one copy per portal, other portals untouched", () => {
  const out = servedListings([
    row("seloger", "stream-estate-v1", "2026-10-15T00:00:00Z"),
    row("leboncoin", "stream-estate-v1", "2026-10-15T00:00:00Z"),
    row("seloger", "stream-estate", "2026-11-10T00:00:00Z"),
    row("vizzit", null, "2026-11-09T00:00:00Z"),
  ]);
  assert.deepEqual(out.map((l) => `${l.source}/${l.via}`), ["leboncoin/stream-estate-v1", "seloger/stream-estate", "vizzit/null"]);
});
