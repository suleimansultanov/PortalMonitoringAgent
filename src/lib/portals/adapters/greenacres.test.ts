import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { greenAcresAdapter } from "./greenacres";
import { FetchFailedError } from "../runner/fetcher";

/**
 * Golden-file tests against pages captured from the live site with the real
 * collector (`npm run fixture`).
 *
 * The point is not to prove the parser works today — the collector run does
 * that. It is to make a redesign fail here, in CI, in a diff someone reads,
 * rather than silently in three weeks' Reports where a missing area column
 * looks like a quiet market.
 */

const FIXTURES = path.join(import.meta.dirname, "..", "__fixtures__");

function fixture(name: string): string {
  const file = path.join(FIXTURES, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing fixture ${name}. Capture it with:\n` +
        `  npm run fixture -- --url=<url> --name=${name.replace(/\.html$/, "")}`,
    );
  }
  return fs.readFileSync(file, "utf8");
}

const DETAIL_URL =
  "https://www.green-acres.fr/fr/properties/maison/ramatuelle/Amfhgmt9hjtzqghr.htm";

/** Parse the detail fixture, failing loudly with the reason rather than a null. */
function parsedDetail() {
  const res = greenAcresAdapter.parse(fixture("green-acres-detail.html"), DETAIL_URL);
  if (res.status === "failed") throw new Error(`parse failed: ${res.error}`);
  return res;
}

test("a real listing page yields every field we depend on", () => {
  const res = parsedDetail();
  // "partial" would mean one of price, area or agency came back null — worth
  // knowing which, so the message carries it.
  assert.equal(
    res.status,
    "ok",
    res.status === "partial" ? `missing: ${res.missing.join(", ")}` : "",
  );

  const l = res.listing;
  assert.equal(l.externalId, "Amfhgmt9hjtzqghr");

  // The asking price, NOT the price per m² sitting next to it. 41 736 here
  // would be the per-m² figure — plausible enough to survive a review, which
  // is exactly why it is asserted.
  assert.equal(l.priceEur, 25_000_000);

  assert.equal(l.areaM2, 599);
  assert.equal(l.landM2, 2_730);
  assert.equal(l.rooms, 8);
  assert.equal(l.bedrooms, 7);

  assert.equal(l.communeRaw, "Ramatuelle");
  assert.equal(l.propertyType, "Maison");

  assert.match(l.agencyName ?? "", /Savills/);
  // The agency's own mandate number — the cross-portal dedup key.
  assert.equal(l.agencyRef, "stz260427");

  assert.ok(l.title && l.title.length > 10, "title from og:title");
  assert.ok(l.description && l.description.length > 10, "description from og:description");
});

test("dates stay null rather than being filled with the crawl time", () => {
  // Green-Acres publishes neither. A crawl timestamp here would masquerade as a
  // publication date and make every listing look new on the day we first saw
  // it — which is precisely the number Reports is meant to answer.
  const res = parsedDetail();
  assert.equal(res.listing.publishedAt, null);
  assert.equal(res.listing.sourceUpdatedAt, null);
});

test("approximated coordinates are recorded as approximated", () => {
  const res = parsedDetail();
  assert.equal(typeof res.listing.lat, "number");
  // Their own flag says the point is not exact; storing it as exact would put
  // map pins in the wrong field.
  assert.equal(res.listing.raw.coordinatesPrecise, false);
});

test("values are read from the block the icon labels, not from the icon", () => {
  // The <em> carrying the icon class is an empty glyph; the number lives in a
  // sibling block. Reading the em, or its immediate parent, returns nothing —
  // which is how rooms came back null for 56% of the first live run while
  // looking like a parser that worked.
  const l = parsedDetail().listing;
  assert.equal(l.rooms, 8);
  assert.equal(l.bedrooms, 7);
  assert.equal(l.areaM2, 599);
  // Land must not be read as living area: both are "N m²" on the same page.
  assert.equal(l.landM2, 2_730);
});

test("land given in hectares is converted, not read as square metres", () => {
  // Green-Acres switches unit above a hectare: "6 600 m² de terrain" but
  // "1,1 ha". Read naively that is 1.1 m² — a ten-thousand-fold error on the
  // listings where land matters most, and invisible to a missing-field report
  // because the column is populated.
  const html = `<html><body>${"x".repeat(600)}
    <meta property="og:title" content="Villa" />
    <span class="tag"><em class="icons icon-landsurface xs"></em><span>1,1 ha</span></span>
    <div class="price-detail">19 500 000 €</div>
  </body></html>`;
  const res = greenAcresAdapter.parse(html, DETAIL_URL);
  if (res.status === "failed") throw new Error(res.error);
  assert.equal(res.listing.landM2, 11_000);
});

test("'habitable' is not mistaken for the hectare unit", () => {
  // The multiplier keys on "ha" — which is also the first two letters of
  // "habitable", a word that appears beside every surface on the page.
  const html = `<html><body>${"x".repeat(600)}
    <meta property="og:title" content="Villa" />
    <span class="tag" title="Surface habitable"><em class="icons icon-habitablesurface xs"></em><span>599 m²</span></span>
    <div class="price-detail">25 000 000 €</div>
  </body></html>`;
  const res = greenAcresAdapter.parse(html, DETAIL_URL);
  if (res.status === "failed") throw new Error(res.error);
  assert.equal(res.listing.areaM2, 599);
});

test("the agency comes with its address, from the block every listing has", () => {
  /**
   * The first version read the agency name from the alt text of its logo. That
   * markup is on 82 of 159 real pages: agency was null for 48% of a full
   * commune, and the null read as "this listing has no agency" rather than as
   * "the parser was written against one example".
   */
  const l = parsedDetail().listing;
  assert.match(l.agencyName ?? "", /Savills/);
  assert.equal(l.agencyPostalCode, "83900");
  assert.match(l.agencyCity ?? "", /Saint Tropez/i);
  assert.match(l.agencyAddress ?? "", /Mermoz/);
});

test("'Agence' is not mistaken for a street address", () => {
  // It is the seller TYPE, printed on every agency listing. Taken as a street
  // it would give every agency in the Var the same address.
  const html = `<html><body>${"x".repeat(600)}
    <meta property="og:title" content="Villa" />
    <div class="price-detail">2 000 000 €</div>
    <div class="agency-detail">
      <span class="seller-name">BARNES ST TROPEZ</span>
      <p>Agence</p><p></p><p></p>
    </div>
  </body></html>`;
  const res = greenAcresAdapter.parse(html, DETAIL_URL);
  if (res.status === "failed") throw new Error(res.error);
  assert.equal(res.listing.agencyName, "BARNES ST TROPEZ");
  assert.equal(res.listing.agencyAddress, null);
});

test("a seller name of '-' is not stored as an agency", () => {
  // One real listing has exactly this. Stored, it becomes an agency called "-"
  // that every other nameless listing merges into — inventing a competitor with
  // a portfolio.
  const html = `<html><body>${"x".repeat(600)}
    <meta property="og:title" content="Villa" />
    <div class="price-detail">2 000 000 €</div>
    <div class="agency-detail"><span class="seller-name">-</span><p>Agence</p></div>
  </body></html>`;
  const res = greenAcresAdapter.parse(html, DETAIL_URL);
  if (res.status === "failed") throw new Error(res.error);
  assert.equal(res.listing.agencyName, null);
});

test("'Prix sur demande' is recorded as withheld, not as a parse failure", () => {
  // Nine of 159 in Ramatuelle withhold the price. Both cases leave priceEur
  // null, but one is the agency choosing not to publish and the other is our
  // bug — and the screen should print "on request", not "—".
  const html = `<html><body>${"x".repeat(600)}
    <meta property="og:title" content="Villa" />
    <div class="price-detail">Prix sur demande</div>
    <div class="agency-detail"><span class="seller-name">BARNES</span><p>Agence</p></div>
  </body></html>`;
  const res = greenAcresAdapter.parse(html, DETAIL_URL);
  if (res.status === "failed") throw new Error(res.error);
  assert.equal(res.listing.priceEur, null);
  assert.equal(res.listing.raw.priceOnRequest, true);
});

test("a published price is not flagged as withheld", () => {
  assert.equal(parsedDetail().listing.raw.priceOnRequest, false);
});

test("the agency slug is kept so a reconstructed name can be audited", () => {
  // Two listings in five have no logo, and the name is only in the logo's alt
  // text. Those fall back to the slug — lossy, so the slug itself is stored
  // and the reconstruction is flagged rather than passed off as read.
  const l = parsedDetail().listing;
  assert.match(String(l.raw.agencySlug), /savills/);
  assert.equal(l.raw.agencyNameFromSlug, false, "this one has a logo, so no fallback");
});

test("the agency's stable page id is captured, not just its display name", () => {
  // "Savills French Riviera" and "Savills French Riviera & French Alps" are one
  // office spelled two ways; the id is not.
  const res = parsedDetail();
  assert.equal(res.listing.raw.agencyPageId, "UiqpGAqTFAiN");
});

test("a page with no body is a failure, not an empty listing", () => {
  const res = greenAcresAdapter.parse("<html><body></body></html>", DETAIL_URL);
  assert.equal(res.status, "failed");
});

test("a URL that is not a listing is refused rather than guessed at", () => {
  const res = greenAcresAdapter.parse(
    fixture("green-acres-detail.html"),
    "https://www.green-acres.fr/immobilier/ramatuelle",
  );
  assert.equal(res.status, "failed");
});

/**
 * Discovery is exercised through a fake fetch over the two captured index
 * pages. No network, so this runs in CI.
 */
async function discover(
  pages: Record<string, string>,
  maxPages = 3,
  /**
   * What a page we did not stub answers with. The default is a 500, because
   * most of these tests are about something going wrong; the 410 case gets
   * passed in explicitly, since on this portal it means the opposite.
   */
  onMissing: (url: string) => Error = (url) =>
    new FetchFailedError(url, 500, "server error 500"),
): Promise<{ urls: string[]; incomplete: Record<string, string> }> {
  const urls: string[] = [];
  const incomplete: Record<string, string> = {};
  for await (const item of greenAcresAdapter.discover({
    fetch: async (url: string) => {
      const html = pages[url];
      if (!html) throw onMissing(url);
      return html;
    },
    communeInsee: ["83101"],
    config: {
      host: "https://www.green-acres.fr",
      communes: [{ insee: "83101", slug: "ramatuelle", label: "Ramatuelle" }],
      maxPages,
    },
    incomplete: (insee, reason) => {
      incomplete[insee] ??= reason;
    },
  })) {
    urls.push(item.url);
  }
  return { urls, incomplete };
}

async function discovered(pages: Record<string, string>): Promise<string[]> {
  return (await discover(pages)).urls;
}

test("obfuscated cards are read, and pagination advances", async () => {
  const urls = await discovered({
    "https://www.green-acres.fr/immobilier/ramatuelle": fixture("green-acres-ramatuelle.html"),
    "https://www.green-acres.fr/immobilier/ramatuelle?p_n=2": fixture(
      "green-acres-ramatuelle-p2b.html",
    ),
  });

  // 24 per page, two pages, no overlap.
  assert.equal(urls.length, 48);
  assert.equal(new Set(urls).size, 48);
  assert.ok(
    urls.every((u) => /\/fr\/properties\/[^/]+\/[^/]+\/[A-Za-z0-9]+\.htm$/.test(u)),
    "every discovered URL is a listing URL",
  );
  assert.ok(urls.includes(DETAIL_URL), "the detail page we parsed is among them");
});

test("a repeated page stops the crawl instead of looping", async () => {
  // `?page=2` is ignored by their server and returns page one. If the parameter
  // name ever changes under us, the failure mode is silent truncation — every
  // commune capped at 24 listings, looking like a thin market. So a repeat has
  // to end the loop rather than spin through maxPages.
  const page1 = fixture("green-acres-ramatuelle.html");
  const urls = await discovered({
    "https://www.green-acres.fr/immobilier/ramatuelle": page1,
    "https://www.green-acres.fr/immobilier/ramatuelle?p_n=2": page1,
  });
  assert.equal(urls.length, 24);
});

test("the whole characteristics list is kept, not just the four typed fields", () => {
  // The icon list carries more than area, land, rooms and bedrooms, and the
  // rest was being dropped on the floor.
  const raw = parsedDetail().listing.raw as { characteristics?: Record<string, string> };

  assert.equal(raw.characteristics?.["Type de bien"], "Villa");
  assert.equal(raw.characteristics?.["Surface"], "599 m²");
  assert.equal(raw.characteristics?.["Terrain"], "2 730 m²");
  assert.equal(raw.characteristics?.["Pièces"], "8");
  assert.equal(raw.characteristics?.["Chambres"], "7");
});

test("DPE and GES are read from the marked letter, not from the text", () => {
  /**
   * All seven letters are in the markup whatever the rating — only one carries
   * `active`. Reading the text would return "A" for every property on the site.
   */
  const raw = parsedDetail().listing.raw as { dpe?: string | null; ges?: string | null };
  assert.equal(raw.dpe, "A");
  assert.equal(raw.ges, "A");
});

test("the unlabelled amenities are kept too — there are more of them than of the labelled ones", () => {
  /**
   * Green-Acres prints two lists: labelled pairs (Surface, Terrain, Pièces) and
   * then a longer run of bare amenities. The second list is where most of what
   * a buyer actually asks about lives, and none of it was being stored.
   */
  const raw = parsedDetail().listing.raw as { flags?: string[] };
  for (const flag of ["Piscine", "Cave", "Alarme", "Climatisation", "Gardien", "Digicode"]) {
    assert.ok(raw.flags?.includes(flag), `missing amenity: ${flag}`);
  }
});

/**
 * Truncated discovery.
 *
 * Three ways this crawl can stop short of the end of a commune, and all three
 * used to look identical to a finished one from the outside — which is what
 * turned a portal's bad afternoon into a commune full of false delistings.
 */

const P1 = "https://www.green-acres.fr/immobilier/ramatuelle";
const P2 = "https://www.green-acres.fr/immobilier/ramatuelle?p_n=2";
const P3 = "https://www.green-acres.fr/immobilier/ramatuelle?p_n=3";
const EMPTY = "<html><body></body></html>";

test("a failing index page marks the commune incomplete and keeps what it got", async () => {
  // Page two answers 500 — something went wrong mid-pagination.
  const { urls, incomplete } = await discover({ [P1]: fixture("green-acres-ramatuelle.html") });

  assert.equal(urls.length, 24, "page one's listings are still real and still ours");
  assert.match(incomplete["83101"], /page 2 failed/);
});

test("410 past the last page is an ending, not a failure", async () => {
  /**
   * Green-Acres answers 410 for the page after the last one rather than
   * serving an empty result set. Measured on the first re-run of an already
   * collected market: reading that as a failure marked eleven of twelve
   * communes incomplete and suppressed every delisting on a healthy pass.
   *
   * Protection that fires on every normal ending is not protection — it is
   * delisting quietly switched off, which is the thing it was built to prevent.
   */
  const gone = (url: string) => new FetchFailedError(url, 410, "not found (410)");
  const { urls, incomplete } = await discover(
    { [P1]: fixture("green-acres-ramatuelle.html") },
    3,
    gone,
  );

  assert.equal(urls.length, 24);
  assert.deepEqual(incomplete, {}, "an ordinary end of pagination reports nothing");
});

test("410 on page one is the opposite — the commune URL itself is wrong", async () => {
  // A bad slug produces no listings and no error anyone would notice. It has
  // to be loud, because an empty commune reads as a quiet market.
  const gone = (url: string) => new FetchFailedError(url, 410, "not found (410)");
  const { urls, incomplete } = await discover({}, 3, gone);

  assert.equal(urls.length, 0);
  assert.match(incomplete["83101"], /commune URL is missing/);
});

test("pagination that silently repeats itself is incompleteness, not an ending", async () => {
  // Their `p_n` parameter being renamed would look exactly like this: a second
  // page identical to the first. Every listing past the first 24 is invisible,
  // and delisting on that basis would empty most of the commune.
  const page = fixture("green-acres-ramatuelle.html");
  const { urls, incomplete } = await discover({ [P1]: page, [P2]: page });

  assert.equal(urls.length, 24);
  assert.match(incomplete["83101"], /not taking effect/);
});

test("the page ceiling is a crawl limit, not a statement about the market", async () => {
  const { incomplete } = await discover({ [P1]: fixture("green-acres-ramatuelle.html") }, 1);
  assert.match(incomplete["83101"], /ceiling/);
});

test("a commune that simply ran out of listings is reported as complete", async () => {
  // The negative case, and the one that matters most: if an ordinary ending
  // also flagged incomplete, nothing would ever be delisted again and the
  // protection would be indistinguishable from having no delisting at all.
  const { urls, incomplete } = await discover({
    [P1]: fixture("green-acres-ramatuelle.html"),
    [P2]: fixture("green-acres-ramatuelle-p2b.html"),
    [P3]: EMPTY,
  });

  assert.equal(urls.length, 48);
  assert.deepEqual(incomplete, {});
});
