import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { indexUrl, vizzitAdapter } from "./vizzit";
import { greenAcresAdapter } from "./greenacres";

/** Real pages, trimmed: the Saint-Tropez index (2026-10-04) and a listing as a US runner was served it. */
const FIXTURES = path.join(__dirname, "..", "__fixtures__");
const INDEX = fs.readFileSync(path.join(FIXTURES, "vizzit-index-saint-tropez.html"), "utf8");
const LISTING = fs.readFileSync(path.join(FIXTURES, "vizzit-listing-usd.html"), "utf8");
const LISTING_URL = "https://www.vizzit.fr/fr/property/appartement/saint-tropez/Ag0fd0cn96pi96t3";

const COMMUNES = [{ insee: "83119", slug: "saint-tropez", label: "Saint-Tropez" }];

async function discoverWith(pageFor: (url: string) => string, config: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const out: { externalId: string; url: string }[] = [];
  const incomplete: [string, string][] = [];
  const ctx = {
    fetch: async (url: string) => {
      asked.push(url);
      return pageFor(url);
    },
    communeInsee: ["83119"],
    config: { communes: COMMUNES, maxPages: 3, ...config },
    incomplete: (i: string, r: string) => incomplete.push([i, r]),
  };
  for await (const d of vizzitAdapter.discover(ctx)) out.push(d);
  return { out, asked, incomplete };
}

/** The fixture's own page, relabelled as page `n` with ids made distinct, so pagination can be walked. */
const pageN = (n: number) =>
  INDEX.replace('data-current-page="1"', `data-current-page="${n}"`).replace(
    /data-advertid="([^"]+)"/g,
    (_m, id: string) => `data-advertid="${id}${n > 1 ? `p${n}` : ""}"`,
  );

test("the index is read: obfuscated cards become listing URLs, each id once", async () => {
  const { out, asked } = await discoverWith(() => INDEX, { maxPages: 1 });
  assert.equal(asked[0], indexUrl("https://www.vizzit.fr", "saint-tropez", 1));
  assert.equal(asked[0], "https://www.vizzit.fr/acheter/saint-tropez");
  assert.ok(out.length >= 20, `expected a page of cards, got ${out.length}`);
  assert.equal(new Set(out.map((d) => d.externalId)).size, out.length);
  for (const d of out) {
    // Listings are `A…` ids; new-build programmes are `P…` under /neuf/, as on Green-Acres.
    assert.match(d.url, /^https:\/\/www\.vizzit\.fr\/fr\/property\/[a-z-]+\/[a-z-]+\/[A-Za-z0-9]{6,}$/);
    assert.ok(d.url.endsWith(d.externalId));
  }
});

test("a commune is graded against the total the portal states", async () => {
  // 510 stated, one page read: that is a hole, not the end of the market.
  const { incomplete } = await discoverWith(() => INDEX, { maxPages: 1 });
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0][1], /ceiling|of the 510/);
});

test("pagination that does not move is caught by their own page counter", async () => {
  // `p_n` ignored: page one again under a 200, its counter still saying 1.
  const { asked, incomplete } = await discoverWith(() => INDEX);
  assert.equal(asked.length, 2);
  assert.equal(asked[1], "https://www.vizzit.fr/acheter/saint-tropez?p_n=2");
  assert.match(incomplete[0][1], /asked for page 2, they served page 1/);
});

test("pages are walked while they bring new listings", async () => {
  const { out, asked } = await discoverWith((url) => pageN(Number(new URL(url).searchParams.get("p_n") ?? 1)));
  assert.equal(asked.length, 3);
  const perPage = out.length / 3;
  assert.equal(Number.isInteger(perPage) && perPage >= 20, true);
});

test("a refused index page marks the commune incomplete instead of reading as empty", async () => {
  const { out, incomplete } = await discoverWith(() => {
    throw new Error("HTTP 403");
  });
  assert.equal(out.length, 0);
  assert.match(incomplete[0][1], /index page 1 failed: HTTP 403/);
});

test("a listing is read by Green-Acres' parser: it is Green-Acres' page", () => {
  assert.equal(vizzitAdapter.parse, greenAcresAdapter.parse);
  const r = vizzitAdapter.parse(LISTING, LISTING_URL);
  if (r.status === "failed") return assert.fail(r.error);
  const l = r.listing;
  assert.equal(l.externalId, "Ag0fd0cn96pi96t3"); // no `.htm` on this site
  assert.equal(l.propertyType, "Appartement");
  assert.equal(l.communeRaw, "Saint Tropez");
  assert.equal(l.areaM2, 101);
  assert.equal(l.rooms, 4);
  assert.equal(l.bedrooms, 3);
  assert.equal(l.agencyName, "GUILLEC");
  assert.equal(l.agencyRef, "2319");
  assert.equal(l.imageUrls.length, 8);
});

test("a page served in dollars to the US runner still gives the euro price", () => {
  const r = vizzitAdapter.parse(LISTING, LISTING_URL);
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.priceEur, 1_390_000); // headline: 1 564 723 $
  const raw = r.listing.raw as Record<string, unknown>;
  assert.deepEqual(raw.foreignPrice, { currency: "USD", shown: "1 564 723 $" });
  assert.deepEqual(raw.priceEurFrom, { where: "euro-line" });
});
