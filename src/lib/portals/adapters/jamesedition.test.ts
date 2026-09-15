import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { jameseditionAdapter } from "./jamesedition";

/**
 * Against pages the collector actually fetched on 10 September 2026, not
 * against markup anyone imagined. That distinction is not pedantry: a size
 * parser written from invented sentences passed its own tests and ate the first
 * digit of every real number — 1010 m² became 10 — and had to be reverted.
 */
const FIXTURES = path.resolve(process.cwd(), "src/lib/portals/__fixtures__");
const listing = fs.readFileSync(path.join(FIXTURES, "jamesedition-listing.html"), "utf8");
const index = fs.readFileSync(
  path.join(FIXTURES, "jamesedition-index-saint-tropez.html"),
  "utf8",
);

const URL_ =
  "https://www.jamesedition.com/real_estate/saint-tropez-france/" +
  "saint-tropez-magnificent-charming-property-with-sea-view-18071317";

test("the real listing parses, and every field is the one on the page", () => {
  const r = jameseditionAdapter.parse(listing, URL_);
  assert.ok(r.status !== "failed", `parse failed: ${r.status === "failed" ? r.error : ""}`);
  const l = r.listing;

  assert.equal(l.externalId, "18071317");
  assert.equal(l.priceEur, 8_900_000);
  assert.equal(l.agencyName, "Berti & Sons");
  assert.match(l.title ?? "", /SAINT-TROPEZ - MAGNIFICENT CHARMING PROPERTY/);
  assert.match(l.description ?? "", /BERTI AND SONS real estate group/);
  assert.equal(l.communeRaw, "Saint-Tropez");
  assert.equal(l.availability, "available");
  assert.ok((l.imageUrl ?? "").startsWith("https://img.jamesedition.com/"));
});

test("the floor area is the house and not the garden", () => {
  /**
   * The strip reads "8 Beds 8 Baths 389 Sqm 2,666 Sqm lot". Both figures are
   * "<number> Sqm" and the lot comes second, so the naive first match returns
   * the plot. 389 against 2666 is not a rounding error — it is a different
   * property — and it is the same class of fault as the 236 listings whose plot
   * size had to be cleared out of the floor-area column by hand.
   */
  const r = jameseditionAdapter.parse(listing, URL_);
  assert.ok(r.status !== "failed");
  assert.equal(r.listing.areaM2, 389);
  assert.equal(r.listing.landM2, 2_666);
  assert.equal(r.listing.bedrooms, 8);
  assert.equal(r.listing.bathrooms, 8);
});

test("a comma is a thousands separator here, not a decimal point", () => {
  // Their pages are English. Reading "2,666" the French way gives 2.666 m².
  const r = jameseditionAdapter.parse(listing, URL_);
  assert.ok(r.status !== "failed");
  assert.ok((r.listing.landM2 ?? 0) > 1000, `got ${r.listing.landM2}`);
});

test("the similar-properties strip does not get parsed as the property", () => {
  /**
   * The page carries TEN `House` blocks — the strip at the bottom — and one
   * `Product`. Taking the first structured block would return a neighbour's
   * bedroom count under this property's price, and nothing downstream could
   * tell. The subject is found by shape: the single RealEstate Product.
   */
  const houses = [...listing.matchAll(/"@type":\s*"House"/g)].length;
  assert.ok(houses >= 5, `expected a similar-properties strip, found ${houses} House blocks`);

  const r = jameseditionAdapter.parse(listing, URL_);
  assert.ok(r.status !== "failed");
  // The strip's first entry is a 3-bedroom apartment; the subject has 8 beds.
  assert.equal(r.listing.bedrooms, 8);
});

test("a price in another currency is recorded as missing, never converted", () => {
  /**
   * JamesEdition prices in several currencies. A dollar figure written into
   * `price_eur` is invisible — plausible number, typed column, no error — and
   * every median and every match built on it is quietly wrong. Inventing a rate
   * would be a second fiction on top of the first.
   */
  const usd = listing.replace(/"priceCurrency":\s*"EUR"/, '"priceCurrency": "USD"');
  const r = jameseditionAdapter.parse(usd, URL_);
  assert.ok(r.status === "partial", `expected partial, got ${r.status}`);
  assert.equal(r.listing.priceEur, null);
  assert.ok(
    r.missing.some((m) => m.includes("USD")),
    `the reason should name the currency: ${r.missing.join(", ")}`,
  );
});

test("square feet are converted, not taken as metres", () => {
  const sqft = listing.replace(/389\s*Sqm/i, "4187 Sqft");
  const r = jameseditionAdapter.parse(sqft, URL_);
  assert.ok(r.status !== "failed");
  // 4187 sqft is 389 m². Within a metre is close enough for a display figure.
  assert.ok(
    Math.abs((r.listing.areaM2 ?? 0) - 389) <= 1,
    `expected about 389 m², got ${r.listing.areaM2}`,
  );
});

/* ── The two faults the 50-listing trial found on 2026-09-10 ─────────────── */

test("a number in the TITLE never becomes the floor area", () => {
  /**
   * Listing 18727889: "Exceptional Domain with tennis court and 3 guest
   * pavilions • 23,500 sqm of…". The first parser read the page's whole text
   * and stored 23 500 m² as the house. The strip is now the only source, so a
   * page whose strip carries no area reports one missing instead.
   */
  const noAreaInStrip = listing.replace(/<li>\s*389 Sqm<\/li>/i, "");
  const r = jameseditionAdapter.parse(noAreaInStrip, URL_);
  assert.ok(r.status === "partial", `expected partial, got ${r.status}`);
  assert.equal(r.listing.areaM2, null, "the title's square metres are not the house");
  assert.ok(r.missing.includes("area"));
});

test("an impossible floor area is refused, not stored", () => {
  /**
   * Listing 18251481 came back as a 1.66 m² property beside a 1 661 m² lot.
   * Nothing has a floor area of one and a half square metres, and a plausible
   * wrong number outlives an obvious one.
   */
  const tiny = jameseditionAdapter.parse(
    listing.replace(/<li>\s*389 Sqm<\/li>/i, "<li>1.66 Sqm</li>"),
    URL_,
  );
  assert.ok(tiny.status !== "failed");
  assert.equal(tiny.listing.areaM2, null, "1.66 m² is not a property");

  const vast = jameseditionAdapter.parse(
    listing.replace(/<li>\s*389 Sqm<\/li>/i, "<li>23,500 Sqm</li>"),
    URL_,
  );
  assert.ok(vast.status !== "failed");
  assert.equal(vast.listing.areaM2, null);
});

test("the commune is the property's own, not the list it was found under", () => {
  /**
   * Their Saint-Tropez index carries a villa titled "– Gassin", one in
   * Beauvallon, and an estate the portal describes as "40 km from St-Tropez".
   * Taking the commune from `/real_estate/saint-tropez-france/` filed all three
   * in Saint-Tropez. It now comes from the map button's own label, and `raw`
   * keeps what the list claimed so a mismatch can be audited without a recrawl.
   */
  const r = jameseditionAdapter.parse(listing, URL_);
  assert.ok(r.status !== "failed");
  assert.equal(r.listing.communeRaw, "Saint-Tropez");

  const elsewhere = listing.replace(
    /aria-label="Zone Ouest Urbaine, Saint-Tropez, France"/,
    'aria-label="Gassin, France"',
  );
  const g = jameseditionAdapter.parse(elsewhere, URL_);
  assert.ok(g.status !== "failed");
  assert.equal(g.listing.communeRaw, "Gassin", "the label wins over the URL");
  assert.equal(
    (g.listing.raw as Record<string, unknown>).listedUnder,
    "Saint-Tropez",
    "and what the list claimed is kept for auditing",
  );
});

test("the postcode reaches the runner as a second signal", () => {
  /**
   * GLOBAL, and whitespace-tolerant, and both for reasons this test learnt the
   * hard way in two goes:
   *
   *   1. it looked for `"name": "` with a space; the fixture writes `"name":"`,
   *      so the replace was a no-op and the assertion ran against an untouched
   *      page;
   *   2. with that fixed it still failed, because the page carries the Product
   *      JSON TWICE and a non-global replace edited the copy the parser does
   *      not read.
   *
   * A mutation that quietly changes nothing, or changes the wrong copy, is
   * worse than no test: it reports green about a code path it never reached.
   */
  const withCode = listing.replace(
    /("name"\s*:\s*")SAINT-TROPEZ - MAGNIFICENT/g,
    "$183990 SAINT-TROPEZ - MAGNIFICENT",
  );
  assert.notEqual(withCode, listing, "the mutation has to actually change the page");
  const c = jameseditionAdapter.parse(withCode, URL_);
  assert.ok(c.status !== "failed");
  assert.equal(c.listing.postalCode, "83990");
});

test("a page with no RealEstate Product fails loudly rather than half-parsing", () => {
  const stripped = listing.replace(/"category":\s*"RealEstate"/, '"category": "Something"');
  const r = jameseditionAdapter.parse(stripped, URL_);
  assert.equal(r.status, "failed");
});

test("the index yields listing ids, and states its own total", () => {
  /**
   * 32 cards a page, "456 listings" stated, `?page=2..15` in the pagination.
   * The stated total is what lets discovery notice it stopped early instead of
   * reporting a short commune as a quiet one.
   */
  const ids = [
    ...new Set(
      [...index.matchAll(/href="\/real_estate\/[a-z0-9-]+\/[a-z0-9-]+-(\d{6,})"/g)].map(
        (m) => m[1],
      ),
    ),
  ];
  assert.ok(ids.length >= 20, `expected a page of cards, found ${ids.length}`);
  assert.match(index.replace(/<[^>]+>/g, " "), /456\s*listings/i);
  assert.match(index, /\?page=2/);
});

test("their area slugs are on their own page — eleven of our twelve", () => {
  /**
   * Read off the nearby-areas block rather than guessed. `la-mole-france` is
   * exactly the guess this project has been punished for: an unknown slug
   * answers 200 with other stock, which reads as a commune with nothing for
   * sale and delists everything previously collected there.
   */
  for (const slug of [
    "saint-tropez-france",
    "sainte-maxime-france",
    "grimaud-france",
    "ramatuelle-france",
    "gassin-france",
    "cogolin-france",
    "la-garde-freinet-france",
    "la-croix-valmer-france",
    "cavalaire-sur-mer-france",
    "le-plan-de-la-tour-france",
    "roquebrune-sur-argens-france",
  ]) {
    assert.match(index, new RegExp(`/real_estate/${slug}"`), `no link for ${slug}`);
  }
  // And the one that is genuinely absent, so nobody "fixes" it by guessing.
  assert.doesNotMatch(index, /\/real_estate\/la-mole-france"/);
});

/* ── What an unknown area slug actually does, measured 2026-09-15 ─────────── */

/**
 * Run `discover` against pages supplied here, and record what came back.
 *
 * No network: the adapter is handed its `fetch`, which is the whole point of
 * the contract in `types.ts`.
 */
async function discoverAgainst(
  pages: Record<string, string>,
  communes: { insee: string; slug: string; label: string }[],
): Promise<{ ids: string[]; incomplete: { insee: string; reason: string }[]; asked: string[] }> {
  const ids: string[] = [];
  const incomplete: { insee: string; reason: string }[] = [];
  const asked: string[] = [];

  const ctx = {
    fetch: async (url: string) => {
      asked.push(url);
      const body = pages[url];
      if (body === undefined) throw new Error(`HTTP 404 at ${url}`);
      return body;
    },
    communeInsee: communes.map((c) => c.insee),
    config: { host: "https://www.jamesedition.com", communes },
    incomplete: (insee: string, reason: string) => incomplete.push({ insee, reason }),
  };

  for await (const l of jameseditionAdapter.discover(ctx)) ids.push(l.externalId);
  return { ids, incomplete, asked };
}

test("an area slug they do not know is refused, not collected", async () => {
  /**
   * `la-mole-france` answers 200 with "Luxury Homes for Sale in France" and the
   * whole country's stock — no 404, no redirect. Measured 2026-09-15 against
   * their live site while looking for the twelfth commune's slug.
   *
   * The failure this guards is not that one missing commune, which is simply
   * absent from the config. It is the day they retire an area we DO use: the
   * same page comes back, and without this check the run fetches several
   * hundred Paris listings at four seconds each and files them under a Gulf
   * commune, while the commune itself reads as empty.
   */
  const nationalFallback =
    "<html><body><h1>Luxury Homes for Sale in France</h1>" +
    '<a href="/real_estate/paris-france/some-apartment-11111111"></a>' +
    '<a href="/real_estate/nice-france/some-villa-22222222"></a>' +
    "</body></html>";

  const { ids, incomplete } = await discoverAgainst(
    { "https://www.jamesedition.com/real_estate/la-mole-france": nationalFallback },
    [{ insee: "83079", slug: "la-mole-france", label: "La Môle" }],
  );

  assert.deepEqual(ids, [], "nothing on a page that is not this commune's may be yielded");
  assert.equal(incomplete.length, 1, "and the commune is reported incomplete, so nothing is delisted");
  assert.match(incomplete[0].reason, /not an area they know/);
});

test("the real page passes the same check", async () => {
  /**
   * The guard has to let the eleven good slugs through, and their heading is
   * not spelled the way ours is: "Saint-Tropez" prints as "Saint Tropez", with
   * no hyphen. A check that rejected that would delist every commune on the
   * portal — a far larger fault than the one it was written to prevent.
   */
  const { ids, incomplete } = await discoverAgainst(
    { "https://www.jamesedition.com/real_estate/saint-tropez-france": index },
    [{ insee: "83119", slug: "saint-tropez-france", label: "Saint-Tropez" }],
  );

  assert.ok(ids.length >= 20, `expected a page of listings, got ${ids.length}`);
  assert.ok(
    !incomplete.some((i) => /not an area they know/.test(i.reason)),
    `the guard rejected a genuine page: ${incomplete.map((i) => i.reason).join("; ")}`,
  );
});
