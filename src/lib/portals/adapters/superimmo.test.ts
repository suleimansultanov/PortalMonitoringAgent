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

// ─────────────────────────────────────────────────────────────────────────────
// The characteristics block, the energy certificate and the coordinates.
//
// A second fixture, trimmed from a page the collector saved on 2026-08-26. The
// original detail fixture predates this markup, and a parser proved against an
// older capture proves nothing about what the site serves today.
// ─────────────────────────────────────────────────────────────────────────────

const CHARACTERISTICS_FIXTURE = path.join(
  HERE,
  "../__fixtures__/superimmo-characteristics.html",
);
const CHARACTERISTICS_URL =
  "https://www.superimmo.com/annonces/achat-maison-300m-saint-tropez-83990-x102eqg";

function parseCharacteristics() {
  const html = fs.readFileSync(CHARACTERISTICS_FIXTURE, "utf8");
  const res = superimmoAdapter.parse(html, CHARACTERISTICS_URL);
  assert.ok("listing" in res, `parse returned no listing: ${"error" in res ? res.error : ""}`);
  return res.listing;
}

test("coordinates are read from the map container", () => {
  // They were in the markup from the first run and nobody took them. Two
  // listings twenty metres apart are the same villa — a far steadier signal
  // than prose agencies copy between neighbouring properties.
  const l = parseCharacteristics();
  assert.equal(l.lat, 43.2153);
  assert.equal(l.lon, 6.61228);
});

test("the whole characteristics block is kept, labelled and unlabelled alike", () => {
  const raw = parseCharacteristics().raw as {
    characteristics?: Record<string, string>;
    flags?: string[];
  };

  assert.equal(raw.characteristics?.["Prix de vente"], "4 400 000 €");
  for (const flag of ["Piscine", "Vue sur campagne", "Climatisation", "Cheminée"]) {
    assert.ok(raw.flags?.includes(flag), `missing flag: ${flag}`);
  }
});

test("the energy certificate comes out as a letter and a figure", () => {
  const raw = parseCharacteristics().raw as {
    dpe?: string | null;
    ges?: string | null;
    energyKwhM2Year?: number | null;
    ghgCo2M2Year?: number | null;
  };

  assert.equal(raw.dpe, "C");
  assert.equal(raw.ges, "C");
  assert.equal(raw.energyKwhM2Year, 151);

  // The two graphs put their figure in different elements, so reading only the
  // first one silently loses emissions.
  assert.equal(raw.ghgCo2M2Year, 28);
});

test("only the leading number is taken out of an emissions figure", () => {
  // "28 kgeqCO2/m²/an" stripped of non-digits is 282 — wrong, and plausible
  // enough to survive a review.
  const raw = parseCharacteristics().raw as { ghgCo2M2Year?: number | null };
  assert.notEqual(raw.ghgCo2M2Year, 282);
});

/**
 * Discovery, over a fake fetch. What is being tested is the URLs we ask for,
 * which is the part a portal's redesign breaks and a unit test can still catch.
 */
async function discover(
  config: Record<string, unknown>,
): Promise<{ asked: string[]; incomplete: Record<string, string> }> {
  const asked: string[] = [];
  const incomplete: Record<string, string> = {};
  const card = (id: string) =>
    `<a href="https://www.superimmo.com/annonces/achat-maison-160m-ramatuelle-83350-${id}">x</a>`;

  for await (const _ of superimmoAdapter.discover({
    fetch: async (url: string) => {
      asked.push(url);
      // Page one has listings, page two is empty — an ordinary ending.
      return asked.length === 1 ? card("aaa111") + card("bbb222") : "<html></html>";
    },
    communeInsee: ["83101"],
    config: {
      host: "https://www.superimmo.com",
      communes: [{ insee: "83101", slug: "ramatuelle", postcode: "83350" }],
      maxPages: 5,
      ...config,
    },
    incomplete: (insee, reason) => {
      incomplete[insee] ??= reason;
    },
  })) {
    // The ids themselves are covered by the parse tests; this is about URLs.
  }
  return { asked, incomplete };
}

test("the sort parameter is carried on every page, not only the first", async () => {
  // Two orderings across one paginated set do not add up to the set: anything
  // falling outside both windows is never discovered, then delisted unseen.
  const { asked } = await discover({ sort: "created_at" });

  assert.ok(asked.length >= 2, "pagination should have asked for a second page");
  for (const url of asked) {
    assert.match(url, /\?sort=created_at$/, `no sort on ${url}`);
  }
  assert.match(asked[1], /\/p\/2\?sort=created_at$/);
});

test("a source configured without a sort asks for plain URLs", async () => {
  // Superimmo is the only portal that offers one. The others must not end up
  // requesting a parameter their site has never heard of.
  const { asked } = await discover({});
  for (const url of asked) assert.ok(!url.includes("?"), `unexpected query in ${url}`);
});
