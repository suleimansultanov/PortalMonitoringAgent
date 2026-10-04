import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { figaroImmobilierAdapter, indexUrl, listingUrl, readIndex } from "./figaroimmobilier";

/**
 * Golden-file tests against a real Saint-Tropez index page, saved by the access
 * test from GitHub Actions on 2026-10-04 (trimmed to its Nuxt payload).
 */
const INDEX = fs.readFileSync(
  path.join(__dirname, "..", "__fixtures__", "figaro-immobilier-index-saint-tropez.html"),
  "utf8",
);

async function discoverWith(pageFor: (url: string) => string, communes = ["83119"]) {
  const asked: string[] = [];
  const out: { externalId: string; url: string; document?: string; communeHint?: string; sourceUpdatedAt?: Date | null }[] = [];
  const incomplete: [string, string][] = [];
  const ctx = {
    fetch: async (url: string) => {
      asked.push(url);
      return pageFor(url);
    },
    communeInsee: communes,
    config: { maxPages: 1 },
    incomplete: (i: string, r: string) => incomplete.push([i, r]),
  };
  for await (const d of figaroImmobilierAdapter.discover(ctx)) out.push(d);
  return { out, asked, incomplete };
}

test("the index payload is read: 31 records, the stated total and page count", () => {
  const index = readIndex(INDEX);
  assert.ok(index);
  assert.equal(index.classifieds.length, 31);
  assert.equal(index.total, 238);
  assert.equal(index.totalPages, 8);
});

test("discovery hands over this site's records whole, and leaves other sites' to them", async () => {
  const { out, asked } = await discoverWith(() => INDEX);
  assert.equal(asked.length, 1);
  assert.equal(asked[0], indexUrl("saint+tropez+83990", 1));
  // 31 on the page: 10 Propriétés Le Figaro and 1 explorimmoneuf are not this portal's.
  assert.equal(out.length, 20);
  for (const d of out) {
    assert.ok(d.document);
    assert.equal(d.url, listingUrl(d.externalId));
    assert.equal(d.communeHint, "83119");
    assert.notEqual(figaroImmobilierAdapter.parse(d.document!, d.url).status, "failed");
  }
});

test("the page cap is reported as incompleteness, never as the end of the market", async () => {
  const { incomplete } = await discoverWith(() => INDEX);
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0][1], /read 31 of the 238/);
});

test("a token they do not recognise is caught on page one, not filed as this commune", async () => {
  // Saint-Tropez's page asked for as if it were Ramatuelle.
  const { out, incomplete } = await discoverWith(() => INDEX, ["83101"]);
  assert.equal(out.length, 0);
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0][1], /not this commune/);
});

test("a refused or empty page marks the commune incomplete instead of reading as empty", async () => {
  const refused = await discoverWith(() => {
    throw new Error("HTTP 403");
  });
  assert.equal(refused.out.length, 0);
  assert.match(refused.incomplete[0][1], /failed: HTTP 403/);

  const shell = await discoverWith(() => "<html><body>Just a moment…</body></html>");
  assert.equal(shell.out.length, 0);
  assert.match(shell.incomplete[0][1], /no listing data/);
});

test("a record arrives complete: price, surfaces, rooms, agency, reference, photos, dates", async () => {
  const { out } = await discoverWith(() => INDEX);
  const first = out[0];
  const r = figaroImmobilierAdapter.parse(first.document!, first.url);
  if (r.status === "failed") return assert.fail(r.error);
  const l = r.listing;
  assert.equal(l.externalId, first.externalId);
  assert.ok(l.priceEur && l.priceEur > 10_000);
  assert.ok(l.agencyName);
  assert.ok(l.agencyRef);
  assert.ok(l.imageUrls.length > 0);
  assert.equal(l.imageUrl, l.imageUrls[0]);
  assert.match(l.communeRaw ?? "", /^Saint-Tropez/);
  assert.equal(l.postalCode, "83990");
  assert.ok(l.publishedAt instanceof Date);
  assert.ok((l.description ?? "").length > 200);
  assert.match(l.title ?? "", /à Saint-Tropez$/);
});

test("their zone-less dates are Paris time, not UTC", () => {
  const doc = JSON.stringify({
    id: "1",
    transaction: "vente",
    price: 1_000_000,
    firstPublicationDate: "2026-09-29T05:16:04", // CEST, UTC+2
    updatedAt: "2026-01-15T12:00:00", // CET, UTC+1
  });
  const r = figaroImmobilierAdapter.parse(doc, listingUrl("1"));
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.publishedAt?.toISOString(), "2026-09-29T03:16:04.000Z");
  assert.equal(r.listing.sourceUpdatedAt?.toISOString(), "2026-01-15T11:00:00.000Z");
});

test("a two-decimal position is the commune's centre and is not stored", () => {
  const at = (lat: number, lon: number) =>
    figaroImmobilierAdapter.parse(
      JSON.stringify({ id: "2", transaction: "vente", location: { city: "Saint-Tropez (83)", latitude: lat, longitude: lon } }),
      listingUrl("2"),
    );
  const centre = at(43.27, 6.63);
  const point = at(43.26772, 6.6402297);
  if (centre.status === "failed" || point.status === "failed") return assert.fail("parse failed");
  assert.equal(centre.listing.lat, null);
  assert.equal(point.listing.lat, 43.26772);
});

test("a plot's surface is land, and a rental is refused", () => {
  const plot = figaroImmobilierAdapter.parse(
    JSON.stringify({ id: "3", transaction: "vente", type: "terrain", area: 2875 }),
    listingUrl("3"),
  );
  if (plot.status === "failed") return assert.fail(plot.error);
  assert.equal(plot.listing.areaM2, null);
  assert.equal(plot.listing.landM2, 2875);

  const rental = figaroImmobilierAdapter.parse(JSON.stringify({ id: "4", transaction: "location" }), listingUrl("4"));
  assert.equal(rental.status, "failed");
});

test("a withheld price is recorded as on request, not as a parse failure", () => {
  const r = figaroImmobilierAdapter.parse(
    JSON.stringify({ id: "5", transaction: "vente", price: 0, priceLabel: "Prix NC" }),
    listingUrl("5"),
  );
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.priceEur, null);
  assert.equal(r.listing.raw.priceOnRequest, true);
});

test("promotion flags do not change the stored document", async () => {
  const { out } = await discoverWith(() => INDEX);
  for (const d of out) {
    const doc = JSON.parse(d.document!);
    assert.equal("isBoosted" in doc, false);
    assert.equal("isPolePosition" in doc, false);
  }
});
