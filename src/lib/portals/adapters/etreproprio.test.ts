import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { etreproprioAdapter } from "./etreproprio";
import { resolveCommune } from "../communes";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../__fixtures__/etreproprio-26534913.html");
const URL_ =
  "https://www.etreproprio.com/immobilier-vente-saint-tropez-v83119/maison/immobilier-26534913-vente-saint-tropez-domaine-de-deux-villas-provencales-au-chemin-de-la-moutte-saint-tropez";

function parseFixture() {
  const html = fs.readFileSync(FIXTURE, "utf8");
  const res = etreproprioAdapter.parse(html, URL_);
  assert.notEqual(res.status, "failed", `parse failed: ${"error" in res ? res.error : ""}`);
  assert.ok("listing" in res);
  return res.listing;
}

test("the id comes from the URL, not from sku", () => {
  const l = parseFixture();
  assert.equal(l.externalId, "26534913");
  // sku here is "161366" and refers to something we cannot identify.
  assert.notEqual(l.externalId, "161366");
});

test("price and currency come from the offer", () => {
  const l = parseFixture();
  assert.equal(l.priceEur, 25_000_000);
});

test("the agency arrives with a structured postal address", () => {
  const l = parseFixture();
  assert.equal(l.agencyName, "Côte D'azur Sotheby's Int. Realty");
  assert.equal(l.agencyPostalCode, "83990");
  assert.equal(l.agencyCity, "Saint-Tropez");
});

test("area and rooms are recovered from the page — they are absent from the markup", () => {
  const l = parseFixture();
  assert.equal(l.areaM2, 412);
  assert.equal(l.rooms, 13);
  assert.equal(l.bedrooms, 8);
});

test("land area does not get mistaken for living area", () => {
  const l = parseFixture();
  // "Terrain 11 479 m²" sits next to "412 m²" in the same block.
  assert.equal(l.landM2, 11_479);
  assert.notEqual(l.areaM2, 11_479);
});

test("the commune is taken from the URL, which carries the INSEE code", () => {
  const l = parseFixture();
  // More reliable than the page: agencies write "Saint-Tropez" for Ramatuelle.
  const commune = resolveCommune(l.communeRaw, l.postalCode, l.title);
  assert.equal(commune?.insee, "83119");
});

test("availability is captured", () => {
  assert.match(parseFixture().availability ?? "", /InStock/);
});

test("a page with no Product node fails loudly rather than returning an empty listing", () => {
  const res = etreproprioAdapter.parse("<html><body>rien</body></html>", URL_);
  assert.equal(res.status, "failed");
});
