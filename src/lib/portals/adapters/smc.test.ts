import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { smcAdapter } from "./smc";
import { resolveCommune } from "../communes";

/**
 * Golden-file test against a real page.
 *
 * The point is not that parsing works today — it is that when SMC redesign,
 * this fails in CI instead of in production three weeks later, quietly, as
 * nulls in a report.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../__fixtures__/smc-ramatuelle-4241469.html");
const URL_ = "https://www.maisonsetappartements.fr/fr/83/annonce-vente-maison-ramatuelle-4241469.html";

function parseFixture() {
  const html = fs.readFileSync(FIXTURE, "utf8");
  const res = smcAdapter.parse(html, URL_);
  assert.notEqual(res.status, "failed", `parse failed: ${"error" in res ? res.error : ""}`);
  assert.ok("listing" in res);
  return res.listing;
}

test("reads identity from the URL, not from sku", () => {
  const l = parseFixture();
  assert.equal(l.externalId, "4241469");
  // 21897 is the AGENCY id. If this ever equals the sku, every BARNES listing
  // is about to collapse into one row.
  assert.notEqual(l.externalId, "21897");
});

test("price is euros, taken from the offer", () => {
  const l = parseFixture();
  assert.equal(l.priceEur, 9_500_000);
});

test("rooms, area and commune come out of the structured title", () => {
  const l = parseFixture();
  assert.equal(l.rooms, 10);
  assert.equal(l.areaM2, 320);
  assert.equal(l.communeRaw, "Ramatuelle");
  assert.equal(l.propertyType, "Maison");
});

test("agency arrives with a postal address and phone", () => {
  const l = parseFixture();
  assert.equal(l.agencyName, "BARNES SAINT-TROPEZ");
  assert.equal(l.agencyPostalCode, null); // address is a bare string here
  assert.match(l.agencyAddress ?? "", /9 avenue du 8 mai 1945/);
  assert.equal(l.agencyPhone, "0494433247");
});

test("agency mandate reference is picked up — the cross-portal key", () => {
  const l = parseFixture();
  assert.equal(l.agencyRef, "86836462");
});

test("availability is captured so a sold transition can be noticed", () => {
  const l = parseFixture();
  assert.match(l.availability ?? "", /InStock/);
});

test("commune resolves to Ramatuelle's INSEE code", () => {
  const l = parseFixture();
  const commune = resolveCommune(l.communeRaw, l.postalCode, l.title);
  assert.equal(commune?.insee, "83101");
  assert.equal(commune?.label, "Ramatuelle");
});

test("Port Grimaud stays distinct from Grimaud", () => {
  const pg = resolveCommune("Grimaud", "83310", "Appartement Port Grimaud vue port");
  assert.equal(pg?.label, "Port Grimaud");
  assert.equal(pg?.localityOf, "Grimaud");

  const g = resolveCommune("Grimaud", "83310", "Villa dans le village de Grimaud");
  assert.equal(g?.label, "Grimaud");
});

test("a listing outside the watched communes resolves to nothing", () => {
  assert.equal(resolveCommune("Nice", "06000", "Appartement à Nice"), null);
});
