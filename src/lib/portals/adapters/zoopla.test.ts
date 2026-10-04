import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { indexUrl, listingUrl, readIndex, townOf, zooplaAdapter } from "./zoopla";

/** Real pages fetched 2026-10-04, trimmed to what the adapter reads. */
const FIXTURES = path.join(__dirname, "..", "__fixtures__");
const INDEX = fs.readFileSync(path.join(FIXTURES, "zoopla-index-grimaud.html"), "utf8");
const LISTING = fs.readFileSync(path.join(FIXTURES, "zoopla-listing.html"), "utf8");
const LISTING_URL = "https://www.zoopla.co.uk/overseas/details/74412384/";
const NO_RESULTS = `<html><body><h2 class="NoResultsBanner_title">No results found</h2></body></html>`;

async function discoverWith(pageFor: (url: string) => string, communes = ["83068"], config: Record<string, unknown> = { maxPages: 1 }) {
  const asked: string[] = [];
  const out: { externalId: string; url: string; communeHint?: string }[] = [];
  const incomplete: [string, string][] = [];
  const ctx = {
    fetch: async (url: string) => {
      asked.push(url);
      return pageFor(url);
    },
    communeInsee: communes,
    config,
    incomplete: (i: string, r: string) => incomplete.push([i, r]),
  };
  for await (const d of zooplaAdapter.discover(ctx)) out.push(d);
  return { out, asked, incomplete };
}

test("a result page gives its listings and the total it states", () => {
  const index = readIndex(INDEX);
  assert.equal(index.total, 104);
  assert.equal(index.empty, false);
  assert.equal(index.items.length, 25);
  assert.equal(new Set(index.items.map((i) => i.id)).size, 25);
  for (const i of index.items) assert.equal(i.url, listingUrl(i.id));
});

test("discovery asks their commune page and reports the shortfall against their total", async () => {
  const { out, asked, incomplete } = await discoverWith(() => INDEX);
  assert.equal(
    asked[0],
    "https://www.zoopla.co.uk/overseas/property/france/provence-alpes-cote-dazur/var/draguignan/grimaud/grimaud-commune/",
  );
  assert.equal(asked[0], indexUrl("grimaud/grimaud-commune", 1));
  assert.equal(out.length, 25);
  assert.equal(out[0].communeHint, "83068");
  assert.deepEqual(incomplete, [["83068", "read 25 of the 104 they state"]]);
});

test("'No results found' is an empty commune, not a failure", async () => {
  const { out, incomplete } = await discoverWith(() => NO_RESULTS, ["83079"]);
  assert.equal(out.length, 0);
  assert.deepEqual(incomplete, []);
});

test("a page with neither listings nor a total is one we could not read", async () => {
  const { out, incomplete } = await discoverWith(() => "<html><body>Just a moment…</body></html>");
  assert.equal(out.length, 0);
  assert.match(incomplete[0][1], /neither listings nor a total/);
});

test("a refused page marks the commune incomplete", async () => {
  const { incomplete } = await discoverWith(() => {
    throw new Error("HTTP 403");
  });
  assert.match(incomplete[0][1], /index page 1 failed: HTTP 403/);
});

test("Les Issambres keeps only what names it: their page is all of Roquebrune-sur-Argens", async () => {
  // The Grimaud page stands in for Roquebrune's: nothing on it mentions Les Issambres.
  const { out, asked } = await discoverWith(() => INDEX, ["83107"]);
  assert.match(asked[0], /le-muy\/roquebrune-sur-argens\/$/);
  assert.equal(out.length, 0);
});

test("the town is read out of their free-form address", () => {
  assert.equal(townOf("Clos De La Tour, Le Plan-De-La-Tour, Fr"), "Le Plan-De-La-Tour");
  assert.equal(townOf("Grimaud, 83310, France"), "Grimaud");
  assert.equal(townOf("Port Grimaud, 83, France"), "Port Grimaud");
  assert.equal(townOf("83310 Cogolin"), "Cogolin");
  assert.equal(townOf("651 Chemin Des Vivards, Cavalaire-Sur-Mer, France"), "Cavalaire-Sur-Mer");
  assert.equal(townOf("Avenue Girard, Sainte-Maxime, Provence-Alpes-Côte D'azur"), "Sainte-Maxime");
  assert.equal(townOf("Les Issambres, St Raphaël, Ste Maxime Area, French Riviera"), "Les Issambres");
  assert.equal(townOf("Provence Coast (Cassis To Cavalaire)"), null);
});

test("a listing: the euro price, never the sterling headline", () => {
  const r = zooplaAdapter.parse(LISTING, LISTING_URL);
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.status, "ok");
  const l = r.listing;
  assert.equal(l.externalId, "74412384");
  assert.equal(l.priceEur, 1_098_000); // the page leads with £935,830
  assert.equal((l.raw as Record<string, unknown>).priceGbp, 935_830);
  assert.equal((l.raw as Record<string, unknown>).currency, "EUR");
});

test("a listing in another currency gets no price", () => {
  const usd = LISTING.replaceAll('"currencyCode":"EUR"', '"currencyCode":"USD"');
  assert.notEqual(usd, LISTING);
  const r = zooplaAdapter.parse(usd, LISTING_URL);
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.priceEur, null);
});

test("square feet become square metres", () => {
  const r = zooplaAdapter.parse(LISTING, LISTING_URL);
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.areaM2, 125); // "1,345 sq. ft"
  assert.equal(r.listing.bedrooms, 4);
  assert.equal(r.listing.bathrooms, 2);
  assert.equal(r.listing.rooms, null); // pièces are not published here
});

test("the syndicator is not stored as an agency", () => {
  const r = zooplaAdapter.parse(LISTING, LISTING_URL);
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.agencyName, null);
  const raw = r.listing.raw as Record<string, unknown>;
  assert.equal(raw.advertiser, "Properstar");
  assert.equal(raw.syndicated, true);
});

test("place, photographs and date as they state them", () => {
  const r = zooplaAdapter.parse(LISTING, LISTING_URL);
  if (r.status === "failed") return assert.fail(r.error);
  const l = r.listing;
  assert.equal(l.communeRaw, "Le Plan-De-La-Tour");
  assert.equal(l.lat, 43.342073);
  assert.equal(l.imageUrls.length, 5);
  assert.match(l.imageUrl ?? "", /^https:\/\/lid\.zoocdn\.com\/1024\/768\/[\w.]+\.jpg$/);
  // "2026-10-03T07:08:19" is UK time (BST, UTC+1).
  assert.equal(l.publishedAt?.toISOString(), "2026-10-03T06:08:19.000Z");
  assert.ok((l.description ?? "").length > 500);
});

test("a page for another listing, or with no data, is refused", () => {
  assert.equal(zooplaAdapter.parse(LISTING, "https://www.zoopla.co.uk/overseas/details/11111111/").status, "failed");
  assert.equal(zooplaAdapter.parse("<html><body>Just a moment…</body></html>", LISTING_URL).status, "failed");
  assert.equal(zooplaAdapter.parse(LISTING, "https://www.zoopla.co.uk/overseas/").status, "failed");
});
