import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cardsOnPage, figaroAdapter, indexUrl, readPayload, singlePrice, statedCount } from "./figaro";
import { FetchFailedError } from "../runner/fetcher";
import type { DiscoverContext, DiscoveredListing } from "../types";

/**
 * Three fixtures, three jobs.
 *
 *  - `figaro-ramatuelle` is a commune page: what a healthy pass looks like.
 *  - `figaro-var-maison` is a DEPARTMENT page, which is exactly what Figaro
 *    serves when it does not recognise a `ville` token. It stands in for the
 *    failure that has no error attached to it.
 *  - `figaro-listing` is one property, for parsing.
 *
 * Several tests run with the Nuxt payload stripped out. That is not a
 * hypothetical: it is their private hydration state, it will change shape one
 * day without notice, and the whole safety argument for reading it is that
 * everything still works when it is gone.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "../__fixtures__");
const HOST = "https://proprietes.lefigaro.fr";
const REGION = "var-provence+alpes+cote+d+azur-france";
const LISTING_URL = `${HOST}/annonces/villa-${REGION}/103041455/`;

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.html`), "utf8");
/** The page as it will look the day Nuxt changes and our reader returns nothing. */
const withoutPayload = (html: string) =>
  html.replace(/<script[^>]*id="__NUXT_DATA__"[\s\S]*?<\/script>/, "");

type Commune = { insee: string; ville: string; label: string };

async function discover(html: string, communes: Commune[]) {
  const requested: string[] = [];
  const incomplete: { insee: string; reason: string }[] = [];
  const found: DiscoveredListing[] = [];

  const ctx: DiscoverContext = {
    fetch: async (url: string) => {
      requested.push(url);
      // Only page one exists in a fixture; 404 is how Figaro says so.
      if (url.includes("page=")) throw new FetchFailedError(url, 404, "404 Not Found");
      return html;
    },
    communeInsee: communes.map((c) => c.insee),
    config: { host: HOST, region: REGION, communes, maxPages: 5 },
    incomplete: (insee, reason) => incomplete.push({ insee, reason }),
  };

  for await (const listing of figaroAdapter.discover(ctx)) found.push(listing);
  return { requested, incomplete, found };
}

// ── URLs ────────────────────────────────────────────────────────────────────

test("the ville token is joined with + and never percent-encoded", () => {
  // `st%20tropez` is answered with a department-wide page and a 200, which
  // reads as a commune with nothing for sale.
  assert.equal(
    indexUrl(HOST, "immobilier", REGION, "st tropez", 1),
    `${HOST}/annonces/immobilier-${REGION}/?ville=st+tropez`,
  );
  assert.equal(
    indexUrl(HOST, "immobilier", REGION, "la croix valmer", 3),
    `${HOST}/annonces/immobilier-${REGION}/?ville=la+croix+valmer&page=3`,
  );
});

// ── Reading an index page ───────────────────────────────────────────────────

test("cards carry the portal's own INSEE code, so nothing has to be spelled right", () => {
  const cards = cardsOnPage(fixture("figaro-ramatuelle"), HOST);
  assert.ok(cards.length >= 30, `expected at least 30 cards, got ${cards.length}`);
  assert.equal(cards.filter((c) => c.insee !== "83101").length, 0);
});

test("without the payload, cards still arrive — with a name instead of a code", () => {
  const cards = cardsOnPage(withoutPayload(fixture("figaro-ramatuelle")), HOST);
  assert.ok(cards.length > 0);
  assert.equal(cards.filter((c) => c.insee).length, 0);
  assert.equal(cards.filter((c) => !c.locality).length, 0);
  assert.equal(cards[0].locality, "Ramatuelle");
});

test("the payload is found by shape — its top-level key is a per-request hash", () => {
  const payload = readPayload(fixture("figaro-ramatuelle"));
  assert.equal(payload.searchInsee, "83101");
  const villa = payload.records.find((r) => r.id === "103041455");
  assert.ok(villa);
  assert.equal(villa.priceEur, 4_700_000);
  assert.equal(villa.reference, "CA9-1070");
  assert.equal(villa.pictures.length, 8);
});

test("an unrecognised commune shows up as an EMPTY code, not as a missing one", () => {
  // The distinction is the whole guard: "" is Figaro saying "the whole
  // department", null is Figaro not saying anything.
  assert.equal(readPayload(fixture("figaro-var-maison")).searchInsee, "");
  assert.equal(readPayload(fixture("figaro-ramatuelle")).searchInsee, "83101");
});

test("the portal's own count is read off the AggregateOffer", () => {
  assert.equal(statedCount(fixture("figaro-ramatuelle")), 167);
  assert.equal(statedCount(fixture("figaro-var-maison")), 3989);
});

// ── Discovery ───────────────────────────────────────────────────────────────

test("a healthy commune page yields every listing on it", async () => {
  const { found } = await discover(fixture("figaro-ramatuelle"), [
    { insee: "83101", ville: "ramatuelle", label: "Ramatuelle" },
  ]);
  assert.ok(found.length >= 30);
  assert.equal(new Set(found.map((f) => f.externalId)).size, found.length);
});

test("a ville token Figaro does not know is caught on page one", async () => {
  // This is the failure with no error attached: a 200, a full page of
  // properties, and none of them here. Unreported it reads as an empty market,
  // and everything collected there before gets delisted on the strength of it.
  const { found, incomplete, requested } = await discover(fixture("figaro-var-maison"), [
    { insee: "83079", ville: "la mole", label: "La Môle" },
  ]);
  assert.equal(found.length, 0);
  assert.equal(requested.length, 1, "it should stop rather than page through the department");
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0].reason, /not one they know/);
});

test("falling short of the portal's own count is reported, not ignored", async () => {
  // The fixture serves one page of the six Ramatuelle has.
  const { incomplete } = await discover(fixture("figaro-ramatuelle"), [
    { insee: "83101", ville: "ramatuelle", label: "Ramatuelle" },
  ]);
  assert.equal(incomplete[0].insee, "83101");
  assert.match(incomplete[0].reason, /of the 167/);
});

test("promoted listings from other communes are left behind", async () => {
  // Read as a commune page, the department fixture is thirty strangers and one
  // local. Only the local should be yielded.
  const { found } = await discover(withoutPayload(fixture("figaro-var-maison")), [
    { insee: "83101", ville: "ramatuelle", label: "Ramatuelle" },
  ]);
  assert.deepEqual(
    found.map((f) => f.externalId),
    ["103041455"],
  );
});

// ── Parsing a listing ───────────────────────────────────────────────────────

function parsed(html: string) {
  const res = figaroAdapter.parse(html, LISTING_URL);
  assert.notEqual(res.status, "failed", `parse failed: ${"error" in res ? res.error : ""}`);
  assert.ok("listing" in res);
  return res.listing;
}

test("identity comes from the URL", () => {
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.externalId, "103041455");
});

test("price is the euro figure, not the currency the visitor last chose", () => {
  // Their page has a EUR/USD/GBP switch and the payload carries all three.
  // 5 445 461 is the dollar figure; reading it would turn every exchange-rate
  // move into a price change.
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.priceEur, 4_700_000);
});

test("size, rooms and land all come out separately", () => {
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.areaM2, 210);
  assert.equal(l.landM2, 2806);
  assert.equal(l.rooms, 9);
  assert.equal(l.bedrooms, 7);
  assert.equal(l.bathrooms, 6);
});

test("the commune arrives with a postcode, and the department stays out of the name", () => {
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.communeRaw, "Ramatuelle");
  assert.equal(l.postalCode, "83350");
});

test("coordinates are deliberately not stored", () => {
  // The payload publishes them and they are the commune's centre, not the
  // property's — every Ramatuelle listing reads 43.22 / 6.62, and the record
  // says hideCity. Stored, they would merge every villa in the commune the
  // first time anything compared distances.
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.lat, null);
  assert.equal(l.lon, null);
});

test("the agency reference is the ADVERTISER's, never Figaro's own id", () => {
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.agencyRef, "CA9-1070");
  assert.notEqual(l.agencyRef, "103041455");
});

test("the agency is the one selling, not the portal publishing", () => {
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.agencyName, "Côte d'Azur Sotheby's International Realty");
  assert.notEqual(l.agencyName, "Propriétés Le Figaro");
  assert.equal(l.agencyPostalCode, "83990");
});

test("dates arrive from the portal, so days-on-market works from the first pass", () => {
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.publishedAt?.toISOString().slice(0, 10), "2026-05-16");
  assert.equal(l.sourceUpdatedAt?.toISOString().slice(0, 10), "2026-08-10");
});

test("the gallery is this property's twenty photographs and nobody else's", () => {
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.imageUrls.length, 20);
  assert.equal(new Set(l.imageUrls).size, 20);
});

test("energy certificate is captured — in France a G cannot be let", () => {
  const l = parsed(fixture("figaro-listing"));
  assert.equal(l.raw.dpe, "D");
  assert.equal(l.raw.ges, "B");
  assert.equal(l.raw.energyKwhM2Year, 240);
});

test("with the payload gone, the page still parses off its own markup", () => {
  const l = parsed(withoutPayload(fixture("figaro-listing")));
  assert.equal(l.priceEur, 4_700_000);
  assert.equal(l.areaM2, 210);
  assert.equal(l.communeRaw, "Ramatuelle");
  assert.equal(l.agencyName, "Côte d'Azur Sotheby's International Realty");
  assert.equal(l.agencyRef, "CA9-1070");
  // Five of twenty: the rest load on click. Fewer photographs is the right
  // failure — the alternative is thirty, of which twenty-five are neighbours'.
  assert.equal(l.imageUrls.length, 5);
  assert.equal(l.raw.payload, "missing");
});

test("a price RANGE is refused, not flattened into a number", () => {
  // Met on a live page: listing 108245945 in Saint-Tropez publishes
  // "De 2000000 à 5000000" because the agency sells it prix nous consulter.
  // Stripping the non-digits gives 20 000 005 000 000, and that number reached
  // the database on 2026-08-30 — where Postgres refused the row and the throw
  // killed a 2104-listing pass at number fifty.
  assert.equal(singlePrice("De 2000000 à 5000000"), null);
  assert.equal(singlePrice("De 5000000 a 10000000"), null);
  assert.equal(singlePrice("2000000 - 5000000"), null);
  assert.equal(singlePrice("prix nous consulter"), null);
  // A single figure, in the shapes they actually publish, still reads.
  assert.equal(singlePrice(4_700_000), 4_700_000);
  assert.equal(singlePrice("4700000"), 4_700_000);
  assert.equal(singlePrice("4 700 000"), 4_700_000);
});

/* ── The index carries dates, and the index is NOT sorted by them ─────────── */

/** The freshest index capture available; both are commune page one. */
const INDEX_FIXTURE = ["figaro-index-0915", "figaro-ramatuelle"].find((n) =>
  fs.existsSync(path.join(FIXTURES, `${n}.html`)),
)!;

test("every card on the index states when the portal last edited it", () => {
  /**
   * This is what pays for the refresh skip in `runner/diff.ts`. The date sits
   * in the payload of a page discovery reads anyway, so a listing this portal
   * calls unchanged costs nothing to leave alone — see `needsRefresh`.
   */
  const cards = cardsOnPage(fixture(INDEX_FIXTURE), "https://proprietes.lefigaro.fr");

  assert.ok(cards.length > 10, `expected a page of cards, got ${cards.length}`);
  const dated = cards.filter((c) => c.sourceUpdatedAt instanceof Date);
  assert.equal(dated.length, cards.length, "every card should carry a date");
  for (const c of dated) {
    const y = c.sourceUpdatedAt!.getFullYear();
    assert.ok(
      y >= 2015 && y <= 2100,
      `${c.externalId} has an implausible date: ${String(c.sourceUpdatedAt)}`,
    );
  }
});

test("their index is not in date order, so no delta stop belongs here", () => {
  /**
   * MEASURED 2026-09-16 on two index captures taken two weeks apart, and kept
   * as a test so nobody adds `discoveryOrder: "newest-first"` to this source on
   * the strength of it feeling likely.
   *
   * Ramatuelle page one came back with publication dates running 2026-05-16,
   * 2026-06-22, 2026-05-21, 2026-04-16 … — 14 of 32 steps going UP, and
   * `updatedAt` is no better. Figaro exposes no sort parameter in its URLs
   * either; the "Trier par" control is client-side and never reaches the query
   * string, so there is nothing to ask for and nothing to verify.
   *
   * A delta stop is the claim that everything after a run of listings we
   * already hold is older still. Here the claim is false, and what it buys is
   * silent: a new listing sitting in the middle of an unordered list, never
   * reached, on a night that reports success. Superimmo earned its delta stop
   * by having its sort parameter checked against its own card dates. This
   * source cannot.
   *
   * If this test ever fails, Figaro has started ordering its index — re-measure
   * across several communes and several days before believing it, and only then
   * is a delta stop on the table.
   */
  const dates = cardsOnPage(fixture(INDEX_FIXTURE), "https://proprietes.lefigaro.fr")
    .map((c) => c.sourceUpdatedAt)
    .filter((d): d is Date => d instanceof Date);

  assert.ok(dates.length > 10);
  let ascending = 0;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i].getTime() > dates[i - 1].getTime()) ascending++;
  }
  assert.ok(ascending > 0, "the index came back newest-first — see the note above before acting on it");
});

test("discovery hands the date on to the runner", async () => {
  /**
   * The field is useless unless it survives the trip out of the adapter. It
   * travels on `DiscoveredListing`, which is what `run.ts` keeps and what the
   * refresh queue consults.
   */
  const html = fixture(INDEX_FIXTURE);
  const out: DiscoveredListing[] = [];
  const ctx: DiscoverContext = {
    fetch: async () => html,
    communeInsee: ["83101"],
    config: {
      host: "https://proprietes.lefigaro.fr",
      communes: [{ insee: "83101", ville: "ramatuelle", label: "Ramatuelle" }],
      maxPages: 1,
    },
    incomplete: () => {},
  };
  for await (const l of figaroAdapter.discover(ctx)) out.push(l);

  assert.ok(out.length > 10, `expected listings, got ${out.length}`);
  assert.ok(
    out.every((l) => l.sourceUpdatedAt instanceof Date),
    "every discovered listing should carry the portal's own date",
  );
});

test("their holiday-rental branch never becomes a card, on either discovery path", () => {
  /**
   * CLAUDE.md has asked for `/location-vacances/` to be kept out since day
   * one; measured 2026-09-24 the sale index payload carries none (0 of 42), and
   * the eleven mentions on the page are all navigation. So the payload path is
   * cheap insurance, and the anchor fallback — which reads every
   * `a[href*="/annonces/"]` when the payload is missing — is where a nav link
   * could be mistaken for a listing. Both are covered here.
   */
  const html = fixture(INDEX_FIXTURE);
  const HOST = "https://proprietes.lefigaro.fr";

  // Payload path: real page, must contain no rental cards.
  for (const c of cardsOnPage(html, HOST)) {
    assert.doesNotMatch(c.url, /\/location-vacances\//);
  }

  // Anchor fallback. cardsOnPage reads the payload, then the JSON-LD graph, and
  // only then the anchors — so BOTH structured sources must be gone before a
  // planted <a> is read at all. Stripping the payload alone left the JSON-LD
  // path answering, and this test never reached the code it was written for.
  const noPayload = html
    .replace(/<script[^>]*id="__NUXT_DATA__"[^>]*>[\s\S]*?<\/script>/, "")
    .replace(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, "");
  const planted =
    noPayload +
    '<a href="/location-vacances/villa-var-provence+alpes+cote+d+azur-france/900000001/">x</a>' +
    '<a href="/annonces/villa-var-provence+alpes+cote+d+azur-france/900000002/">y</a>';
  const ids = cardsOnPage(planted, HOST).map((c) => c.externalId);
  assert.ok(!ids.includes("900000001"), "the rental link must not become a card");
  assert.ok(ids.includes("900000002"), "and the sale link beside it still does");
});
