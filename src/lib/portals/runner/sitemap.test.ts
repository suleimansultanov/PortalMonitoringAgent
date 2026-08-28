import { test } from "node:test";
import assert from "node:assert/strict";
import {
  communeSlugMatcher,
  isSitemapIndex,
  parseSitemap,
  parseSitemapIndex,
  walkSitemap,
  type SitemapEntry,
} from "./sitemap";

const INDEX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
 <sitemap><loc>https://x.test/en_1.xml.gz</loc><lastmod>2026-08-24</lastmod></sitemap>
 <sitemap><loc>https://x.test/fr_1.xml.gz</loc><lastmod>2026-08-24</lastmod></sitemap>
</sitemapindex>`;

const LEAF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
 <url><loc>https://x.test/p1-villa-for-sale-ramatuelle</loc><lastmod>2026-08-25</lastmod></url>
 <url><loc>https://x.test/p2-villa-for-sale-cannes</loc><lastmod>2026-08-20</lastmod></url>
 <url><loc>https://x.test/p3-house-for-sale-saint-tropez</loc></url>
</urlset>`;

test("an index is told apart from a leaf", () => {
  assert.equal(isSitemapIndex(INDEX_XML), true);
  assert.equal(isSitemapIndex(LEAF_XML), false);
});

test("child sitemaps come out of an index with their dates", () => {
  const kids = parseSitemapIndex(INDEX_XML);
  assert.equal(kids.length, 2);
  assert.equal(kids[0].loc, "https://x.test/en_1.xml.gz");
  assert.equal(kids[0].lastmod?.toISOString().slice(0, 10), "2026-08-24");
});

test("urls come out of a leaf, with lastmod optional", () => {
  const urls = parseSitemap(LEAF_XML);
  assert.equal(urls.length, 3);
  assert.equal(urls[2].lastmod, null);
});

test("a sitemap without url wrappers still yields its locs", () => {
  // Some portals emit bare <loc> tags. Returning nothing would report the
  // portal as empty, which is indistinguishable from a market with no stock.
  const bare = `<urlset><loc>https://x.test/p9-villa-for-sale-gassin</loc></urlset>`;
  assert.equal(parseSitemap(bare).length, 1);
});

test("escaped ampersands are decoded", () => {
  const xml = `<urlset><url><loc>https://x.test/a?b=1&amp;c=2</loc></url></urlset>`;
  assert.equal(parseSitemap(xml)[0].loc, "https://x.test/a?b=1&c=2");
});

test("commune matching is bounded by separators", () => {
  const match = communeSlugMatcher(["ramatuelle", "la-mole"]);
  assert.equal(match({ loc: "https://x.test/p1-villa-for-sale-ramatuelle", lastmod: null }), true);
  assert.equal(match({ loc: "https://x.test/p2-villa-la-mole", lastmod: null }), true);
  assert.equal(match({ loc: "https://x.test/p3-villa-cannes", lastmod: null }), false);
  // Without boundaries this would match, and a neighbouring commune's stock
  // would quietly appear in the client's numbers.
  assert.equal(match({ loc: "https://x.test/p4-villa-la-molere", lastmod: null }), false);
});

test("the walk follows an index, filters shards, and filters urls", async () => {
  const fetched: string[] = [];
  const fetcher = async (url: string) => {
    fetched.push(url);
    if (url.endsWith("root.xml")) return INDEX_XML;
    return LEAF_XML;
  };

  const out: SitemapEntry[] = [];
  for await (const entry of walkSitemap({
    fetch: fetcher,
    root: "https://x.test/root.xml",
    // Opening every shard of a worldwide index to find one French commune is
    // the load we promised these sites we would not create.
    keepSitemap: (s) => s.loc.includes("fr_"),
    keepUrl: communeSlugMatcher(["ramatuelle"]),
  })) {
    out.push(entry);
  }

  assert.deepEqual(fetched, ["https://x.test/root.xml", "https://x.test/fr_1.xml.gz"]);
  assert.equal(out.length, 1);
  assert.match(out[0].loc, /ramatuelle/);
});

test("an unreadable shard does not abandon the rest of the walk", async () => {
  const fetcher = async (url: string) => {
    if (url.endsWith("root.xml")) return INDEX_XML;
    if (url.includes("en_1")) throw new Error("403");
    return LEAF_XML;
  };

  const out: SitemapEntry[] = [];
  for await (const e of walkSitemap({
    fetch: fetcher,
    root: "https://x.test/root.xml",
    keepUrl: () => true,
  })) {
    out.push(e);
  }

  assert.equal(out.length, 3, "the readable shard still yielded");
});

test("the limit stops the walk", async () => {
  const fetcher = async () => LEAF_XML;
  const out: SitemapEntry[] = [];
  for await (const e of walkSitemap({
    fetch: fetcher,
    root: "https://x.test/leaf.xml",
    keepUrl: () => true,
    limit: 2,
  })) {
    out.push(e);
  }
  assert.equal(out.length, 2);
});
