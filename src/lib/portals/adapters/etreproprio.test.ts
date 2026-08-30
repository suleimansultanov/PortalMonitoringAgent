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

// ─────────────────────────────────────────────────────────────────────────────
// The commune, from real listing URLs saved by the collector on 2026-08-29.
// The original pattern read their SEARCH url form and never matched a detail
// page, so every listing arrived with no commune — and a listing with no
// commune gets no property row and appears on no screen.
// ─────────────────────────────────────────────────────────────────────────────

const HTML = fs.readFileSync(FIXTURE, "utf8");

function communeOf(url: string): string | null {
  const res = etreproprioAdapter.parse(HTML, url);
  assert.ok("listing" in res, `parse returned no listing for ${url}`);
  return res.listing.communeRaw;
}

test("the commune is read off a real listing URL, where it is the last segment", () => {
  assert.equal(
    communeOf(
      "https://www.etreproprio.com/immobilier-24697579-vente-superbe-propriete-de-standing-neuve-a-vendre-a-ramatuelle-ramatuelle",
    ),
    "Ramatuelle",
  );
  assert.equal(
    communeOf("https://www.etreproprio.com/immobilier-25038707-vente-maison-178-m-a-ramatuelle-ramatuelle"),
    "Ramatuelle",
  );
});

test("their own office address is never mistaken for the property's", () => {
  // Every page carries addressLocality "Labège", postalCode 31670 — Etreproprio's
  // office near Toulouse. Structured, prominent, and four hundred miles wrong.
  const res = etreproprioAdapter.parse(
    HTML,
    "https://www.etreproprio.com/immobilier-25038707-vente-maison-178-m-a-ramatuelle-ramatuelle",
  );
  assert.ok("listing" in res);
  assert.notEqual(res.listing.communeRaw, "Labège");
  assert.equal(res.listing.postalCode, null);
});

test("the longest matching slug wins, so a commune is not read as part of another", () => {
  assert.equal(
    communeOf("https://www.etreproprio.com/immobilier-1-vente-villa-a-la-croix-valmer"),
    "La Croix-Valmer",
  );
});

test("a URL carrying no commune we watch leaves it null rather than guessing", () => {
  assert.equal(communeOf("https://www.etreproprio.com/immobilier-9-vente-maison-a-lyon"), null);
});

test("photographs come out of the DOM in the order the agency numbered them", () => {
  const l = parseFixture();
  assert.deepEqual(l.imageUrls, [
    "https://storage.etreproprio.com/classified/image/thumb/t/u/v/21a63042-b867-4198-8002-18b7f9ab048c_ptw0.webp",
    "https://storage.etreproprio.com/classified/image/thumb/i/d/m/66886831-d30f-44b3-a8b2-502b9fa3a3ea_ptw0.webp",
    "https://storage.etreproprio.com/classified/image/thumb/v/q/g/df46aca1-0790-4f5c-b933-67f60851c12a_ptw0.webp",
  ]);
  // The carousel lists photo 2 first. Document order is not the agency's order.
  assert.equal(l.imageUrl, l.imageUrls[0]);
});

test("each photograph appears once, though the page carries it twice", () => {
  const l = parseFixture();
  assert.equal(l.imageUrls.length, new Set(l.imageUrls).size);
});

test("the agency's logo is not one of the property's photographs", () => {
  const l = parseFixture();
  assert.ok(l.imageUrls.every((u) => !u.includes("/realtor/")));
});

test("a listing with no photographs is left without one rather than given a placeholder", () => {
  // Forty-eight of the 1437 pages we hold are like this — nearly all bare land.
  // Their JSON-LD still advertises an `image`, but it is a redirect that serves
  // Etreproprio's own "pas de photo" graphic, which is worse than an empty card.
  const html = fs.readFileSync(FIXTURE, "utf8").replace(/<img[^>]*classified[^>]*>/g, "");
  const res = etreproprioAdapter.parse(html, URL_);
  assert.ok("listing" in res);
  assert.deepEqual(res.listing.imageUrls, []);
  assert.equal(res.listing.imageUrl, null);
});

test("listings from communes we do not watch are dropped before they are fetched", async () => {
  /**
   * Their index pages append a "nearby" block, and 130 of the 1437 pages we
   * collected on 29 August came from it — Fréjus, Hyères, Moissac-Bellevue.
   * They were never filed wrongly, they simply cost a request each, every pass,
   * for stock in a market the client does not work in.
   */
  const page = [
    '<a href="/immobilier-1-vente-villa-a-ramatuelle-ramatuelle">ours</a>',
    '<a href="/immobilier-2-vente-appartement-frejus-plage-frejus">theirs</a>',
    '<a href="/immobilier-3-vente-maison-a-moissac-bellevue-moissac-bellevue">theirs</a>',
    '<a href="/immobilier-4-vente-terrain-la-croix-valmer">ours</a>',
  ].join("\n");

  const asked: string[] = [];
  const out: string[] = [];
  for await (const item of etreproprioAdapter.discover({
    fetch: async (url: string) => {
      asked.push(url);
      return asked.length === 1 ? page : "<html></html>";
    },
    communeInsee: ["83101"],
    config: {
      host: "https://www.etreproprio.com",
      communeSlugs: { "83101": "ramatuelle" },
      types: ["maison"],
      maxPages: 2,
    },
    incomplete: () => {},
  })) {
    out.push(item.url);
  }

  assert.equal(out.length, 2, "only the two in communes we watch");
  assert.ok(out.every((u) => !u.includes("frejus") && !u.includes("moissac")));
});

test("a page of nothing but neighbours does not read as the end of the commune", async () => {
  /**
   * The first version of the out-of-area filter tested end-of-pagination on the
   * KEPT links. A page whose listings all happened to be in neighbouring
   * communes then looked identical to an empty page, and the walk stopped
   * there — losing every later page of a commune, silently, because an
   * ordinary ending reports nothing.
   */
  const ours = (n: number) => `<a href="/immobilier-${n}-vente-villa-a-ramatuelle-ramatuelle">x</a>`;
  const theirs = (n: number) => `<a href="/immobilier-${n}-vente-appartement-frejus-plage-frejus">x</a>`;

  const pages: Record<number, string> = {
    1: ours(1),
    2: theirs(2) + theirs(3), // nothing for us — but the commune is not over
    3: ours(4),
    4: "<html></html>",
  };

  let n = 0;
  const out: string[] = [];
  for await (const item of etreproprioAdapter.discover({
    fetch: async () => pages[++n] ?? "<html></html>",
    communeInsee: ["83101"],
    config: {
      host: "https://www.etreproprio.com",
      communeSlugs: { "83101": "ramatuelle" },
      types: ["maison"],
      maxPages: 6,
    },
    incomplete: () => {},
  })) {
    out.push(item.url);
  }

  assert.equal(out.length, 2, "the listing on page three has to survive page two");
  assert.ok(out.some((u) => u.includes("immobilier-4-")));
});
