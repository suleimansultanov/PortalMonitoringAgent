import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { superimmoAdapter } from "./superimmo";
import { resolveCommune } from "../communes";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../__fixtures__/superimmo-x10ewng.html");
const URL_ = "https://www.superimmo.com/annonces/achat-maison-160m-saint-tropez-83990-x10ewng";

function parseFixture() {
  const html = fs.readFileSync(FIXTURE, "utf8");
  const res = superimmoAdapter.parse(html, URL_);
  assert.notEqual(res.status, "failed", `parse failed: ${"error" in res ? res.error : ""}`);
  assert.ok("listing" in res);
  return res.listing;
}

test("the id comes from the URL", () => {
  assert.equal(parseFixture().externalId, "x10ewng");
});

test("price is read from the labelled field, not from the price per m² beside it", () => {
  assert.equal(parseFixture().priceEur, 20_900_000);
});

test("living area and land area are told apart", () => {
  const l = parseFixture();
  // "160 m² - 4 chambres - ter. 2 250 m²" is one string. Taken naively the
  // land figure becomes the living area, fourteen times too large.
  assert.equal(l.areaM2, 160);
  assert.equal(l.landM2, 2250);
  assert.equal(l.bedrooms, 4);
});

test("'0 pièces' is not recorded as zero rooms", () => {
  // They print 0 when the agency supplied no count. Storing it would put a
  // nought into every average and make a villa look like it has no rooms.
  assert.equal(parseFixture().rooms, null);
});

/**
 * The two fields that make this portal worth its fragility. Nowhere else
 * publishes them, and without them days-on-market and price cuts need weeks of
 * our own observation before they mean anything.
 */
test("publication and update dates are captured", () => {
  const l = parseFixture();
  assert.equal(l.publishedAt?.toISOString().slice(0, 10), "2026-02-06");
  assert.equal(l.sourceUpdatedAt?.toISOString().slice(0, 10), "2026-08-21");
});

test("French dates are not read as American ones", () => {
  // 06/02/2026 is 6 February. Read the other way round it becomes 2 June, and
  // every days-on-market figure is silently wrong by up to eleven months.
  assert.equal(parseFixture().publishedAt?.getUTCMonth(), 1);
});

test("the agency reference is taken, not Superimmo's own id", () => {
  // "Réf. agence : 746 - Réf Superimmo : ANVX10EWNG" sit side by side. Their
  // internal id means nothing on any other portal, so a key built from it
  // would simply never match — silently.
  assert.equal(parseFixture().agencyRef, "746");
});

test("agency name, phone and postcode arrive", () => {
  const l = parseFixture();
  assert.match(l.agencyName ?? "", /Fiedler/);
  assert.equal(l.agencyPhone, "0648761798");
  assert.equal(l.agencyPostalCode, "83990");
});

test("commune resolves to Saint-Tropez", () => {
  const l = parseFixture();
  assert.equal(resolveCommune(l.communeRaw, l.postalCode, l.title)?.insee, "83119");
});

test("a page with no body fails rather than returning an empty listing", () => {
  const res = superimmoAdapter.parse("<html><body></body></html>", URL_);
  assert.equal(res.status, "failed");
});
