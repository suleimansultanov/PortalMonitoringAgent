import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { luxuryEstateAdapter } from "./luxuryestate";
import { resolveCommune } from "../communes";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../__fixtures__/luxuryestate-132837599.html");
const URL_ = "https://www.luxuryestate.com/p132837599-luxury-home-for-sale-saint-tropez";

function parseFixture() {
  const html = fs.readFileSync(FIXTURE, "utf8");
  const res = luxuryEstateAdapter.parse(html, URL_);
  assert.notEqual(res.status, "failed", `parse failed: ${"error" in res ? res.error : ""}`);
  assert.ok("listing" in res);
  return res.listing;
}

test("the id comes from the URL", () => {
  assert.equal(parseFixture().externalId, "132837599");
});

test("price arrives as a string in the markup and comes out a number", () => {
  assert.equal(parseFixture().priceEur, 19_600_000);
});

test("size and rooms come from structured fields, not from prose", () => {
  const l = parseFixture();
  assert.equal(l.areaM2, 600);
  assert.equal(l.rooms, 7);
});

test("bedrooms and bathrooms are read out of amenityFeature", () => {
  const l = parseFixture();
  assert.equal(l.bedrooms, 6);
  assert.equal(l.bathrooms, 6);
});

test("the commune comes from the breadcrumb, not from 'Var - Department'", () => {
  const l = parseFixture();
  // The last crumb is the property itself; the one before it is the commune.
  // Higher levels carry a suffix and must not be mistaken for one.
  assert.equal(l.communeRaw, "Saint-Tropez");
  assert.equal(resolveCommune(l.communeRaw, l.postalCode, l.title)?.insee, "83119");
});

test("the agency is recovered from the page — offeredBy points at the portal itself", () => {
  // offers.offeredBy is LuxuryEstate's own organisation node, not the listing
  // agent. This is the one field here that depends on their markup.
  assert.equal(parseFixture().agencyName, "Excellence Real Estate");
});

test("floorSize in a unit other than square metres is refused, not converted blindly", () => {
  const html = fs
    .readFileSync(FIXTURE, "utf8")
    .replace('"unitCode":"MTK"', '"unitCode":"FTK"');
  const res = luxuryEstateAdapter.parse(html, URL_);
  assert.ok("listing" in res);
  // 6,458 ft² silently stored as 6,458 m² would put a villa on a plot the size
  // of a village, and every price-per-m² figure would be nonsense.
  assert.equal(res.listing.areaM2, null);
});

test("a page without a RealEstateListing node fails loudly", () => {
  const res = luxuryEstateAdapter.parse("<html><body>nothing</body></html>", URL_);
  assert.equal(res.status, "failed");
});
