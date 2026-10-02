import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bieniciAdapter, listingUrl, searchUrl } from "./bienici";

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "__fixtures__", "bienici-la-mole.json"), "utf8"),
) as { total: number; realEstateAds: Record<string, unknown>[]; _plot: Record<string, unknown> };

const doc = (i: number) => JSON.stringify(FIXTURE.realEstateAds[i]);
const parse = (d: string, id = "x") => bieniciAdapter.parse(d, listingUrl(id));

test("an apartment arrives complete, straight from the search record", () => {
  const r = parse(doc(0), "agence-immo-3-VA34460");
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const l = r.listing;
  assert.equal(l.externalId, "agence-immo-3-VA34460");
  assert.equal(l.url, "https://www.bienici.com/annonce/agence-immo-3-VA34460");
  assert.equal(l.priceEur, 270300);
  assert.equal(l.areaM2, 53.53);
  assert.equal(l.rooms, 2);
  assert.equal(l.bedrooms, 1);
  assert.equal(l.propertyType, "Appartement");
  assert.equal(l.communeRaw, "La Môle");
  assert.equal(l.postalCode, "83310");
  assert.equal(l.agencyName, "AGENCE.IMMO");
  assert.equal(l.agencyRef, "VA34460");
  assert.equal(l.imageUrls.length, 3);
  assert.equal(l.imageUrl, l.imageUrls[0]);
  assert.match(l.imageUrl ?? "", /^https:\/\/file\.bienici\.com\/photo\//);
  assert.equal(l.publishedAt?.toISOString(), "2026-09-25T08:02:02.775Z");
});

test("coordinates are not taken — theirs are blurred on purpose", () => {
  const r = parse(doc(0));
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.lat, null);
  assert.equal(r.listing.lon, null);
});

test("a villa keeps floor area and land apart, and the modification date is the source's", () => {
  const r = parse(doc(1));
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.areaM2, 265);
  assert.equal(r.listing.landM2, 5000);
  assert.equal(r.listing.priceEur, 3640000);
  assert.equal(r.listing.sourceUpdatedAt?.toISOString(), "2026-09-28T11:57:12.106Z");
});

test("a repeated photo URL appears once in the gallery", () => {
  const r = parse(doc(1));
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.imageUrls.length, 2);
});

test("their epoch 'no date' is a missing date, not 1970", () => {
  const r = parse(doc(3));
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.publishedAt, null);
  assert.ok(r.listing.sourceUpdatedAt);
});

test("an empty title stays empty rather than becoming a blank string", () => {
  const r = parse(doc(3));
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.title, null);
  // and zero bathrooms is 'not stated', like every other adapter
  assert.equal(r.listing.bathrooms, null);
});

test("a building plot has land and no floor area, and is complete", () => {
  const r = parse(JSON.stringify(FIXTURE._plot));
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.listing.areaM2, null);
  assert.equal(r.listing.landM2, 1005);
  assert.equal(r.listing.propertyType, "Terrain");
});

test("a programme's price range is not one home's price", () => {
  const prog = { ...FIXTURE.realEstateAds[0], price: [398000, 695000], newProperty: true };
  const r = parse(JSON.stringify(prog));
  assert.equal(r.status, "partial");
  if (r.status !== "partial") return;
  assert.equal(r.listing.priceEur, null);
  assert.deepEqual((r.listing.raw as { priceRange: number[] }).priceRange, [398000, 695000]);
});

test("a rental is refused even if it slipped into the pool", () => {
  const rent = { ...FIXTURE.realEstateAds[0], transactionType: "rent" };
  assert.equal(parse(JSON.stringify(rent)).status, "failed");
});

test("garbage is a failure, not an empty listing", () => {
  assert.equal(parse("<html>Just a moment…</html>").status, "failed");
});

async function discoverWith(pages: (from: number) => unknown, communes = ["83079"]) {
  const asked: string[] = [];
  const incomplete: [string, string][] = [];
  const out = [];
  const ctx = {
    fetch: async (url: string) => {
      asked.push(url);
      const filters = JSON.parse(decodeURIComponent(url.split("filters=")[1]));
      return JSON.stringify(pages(filters.from));
    },
    communeInsee: communes,
    config: {},
    incomplete: (i: string, r: string) => incomplete.push([i, r]),
  };
  for await (const d of bieniciAdapter.discover(ctx)) out.push(d);
  return { out, asked, incomplete };
}

test("discovery hands over the whole record, so no listing page is ever fetched", async () => {
  const { out, asked } = await discoverWith(() => FIXTURE);
  assert.equal(asked.length, 1);
  assert.equal(out.length, 4);
  for (const d of out) {
    assert.ok(d.document, "document present");
    assert.equal(d.url, listingUrl(d.externalId));
    assert.equal(d.communeHint, "83079");
    assert.equal(bieniciAdapter.parse(d.document!, d.url).status !== "failed", true);
  }
});

test("the stored record leaves out what changes between two identical requests", async () => {
  const { out } = await discoverWith(() => FIXTURE);
  const first = JSON.parse(out[0].document!);
  for (const k of ["userRelativeData", "phoneDisplays", "highlightMailContact", "endOfPromotedAsExclusive", "blurInfo"]) {
    assert.equal(k in first, false, k);
  }
  assert.deepEqual(Object.keys(first.status).sort(), ["autoImported", "closedByUser", "onTheMarket"]);
});

test("pagination stops at their stated total, because past it they repeat the tail", async () => {
  // 250 stated: three pages of 100. A fourth request would bring the tail again.
  const make = (from: number) => ({
    total: 250,
    realEstateAds: Array.from({ length: Math.min(100, 250 - from) }, (_, i) => ({
      ...FIXTURE.realEstateAds[0],
      id: `ad-${from + i}`,
    })),
  });
  const { out, asked, incomplete } = await discoverWith(make);
  assert.equal(asked.length, 3);
  assert.equal(out.length, 250);
  assert.deepEqual(incomplete, []);
});

test("a record from another commune is dropped, not filed under this one", async () => {
  const mixed = {
    total: 2,
    realEstateAds: [FIXTURE.realEstateAds[0], { ...FIXTURE._plot }],
  };
  const { out } = await discoverWith(() => mixed);
  assert.deepEqual(out.map((d) => d.externalId), ["agence-immo-3-VA34460"]);
});

test("a refused page marks the commune incomplete instead of reading as empty", async () => {
  const asked: string[] = [];
  const incomplete: [string, string][] = [];
  const ctx = {
    fetch: async (url: string) => {
      asked.push(url);
      throw new Error("HTTP 403");
    },
    communeInsee: ["83079"],
    config: {},
    incomplete: (i: string, r: string) => incomplete.push([i, r]),
  };
  const out = [];
  for await (const d of bieniciAdapter.discover(ctx)) out.push(d);
  assert.equal(out.length, 0);
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0][1], /403/);
});

test("a commune without a zone is reported, not silently skipped", async () => {
  const { incomplete } = await discoverWith(() => FIXTURE, ["99999"]);
  assert.equal(incomplete.length, 1);
});

test("the search asks for sales only, on the market, in the zone, a hundred at a time", () => {
  const f = JSON.parse(decodeURIComponent(searchUrl("-970876", 200).split("filters=")[1]));
  assert.equal(f.filterType, "buy");
  assert.deepEqual(f.onTheMarket, [true]);
  assert.deepEqual(f.zoneIdsByTypes, { zoneIds: ["-970876"] });
  assert.equal(f.size, 100);
  assert.equal(f.from, 200);
});

test("escaped titles and descriptions arrive as text, not as entities", () => {
  // Seen on the client's dashboard 2026-10-02: "Terrain &agrave; b&acirc;tir".
  const ad = {
    ...FIXTURE.realEstateAds[0],
    title: "Terrain &agrave; b&acirc;tir &amp; vue mer",
    description: "Premi&egrave;re ligne.<br>Vue d&#233;gag&eacute;e.<br/><b>Rare</b>",
  };
  const r = parse(JSON.stringify(ad));
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.title, "Terrain à bâtir & vue mer");
  assert.equal(r.listing.description, "Première ligne.\nVue dégagée.\nRare");
});

test("a new-build programme is labelled as one", () => {
  const r = parse(JSON.stringify({ ...FIXTURE.realEstateAds[0], propertyType: "programme" }));
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.propertyType, "Programme neuf");
});

test("photos come from their CDN, built from `photo` when `url` is missing, the agency original last", () => {
  const ad = {
    ...FIXTURE.realEstateAds[0],
    photos: [
      { photo: "x-1_storage.gra.cloud.ovh.net_raw", url_photo: "https://storage.gra.cloud.ovh.net/v1/AUTH_x/kimono/abc/raw" },
      { url_photo: "https://storage.gra.cloud.ovh.net/v1/AUTH_x/kimono/def/raw" },
    ],
  };
  const r = parse(JSON.stringify(ad));
  if (r.status === "failed") return assert.fail(r.error);
  assert.deepEqual(r.listing.imageUrls, [
    "https://file.bienici.com/photo/x-1_storage.gra.cloud.ovh.net_raw",
    "https://storage.gra.cloud.ovh.net/v1/AUTH_x/kimono/def/raw",
  ]);
});
