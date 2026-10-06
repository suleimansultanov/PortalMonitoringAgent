import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { searchBody, streamEstateAdapter, type StreamRecord } from "./streamestate";

/**
 * Thirty Saint-Tropez properties as the V2 API answered on 2026-10-06, with
 * everything they link to (listings, sources, publishers), and no next page.
 */
const PAGE = fs.readFileSync(path.join(__dirname, "..", "__fixtures__", "stream-estate-v2-saint-tropez.json"), "utf8");

type Asked = { url: string; init?: { method?: string; body?: string; headers?: Record<string, string>; json?: boolean } };

async function discoverWith(answer: (n: number) => string, config: Record<string, unknown> = {}, communes = ["83119"]) {
  const asked: Asked[] = [];
  const out: { externalId: string; url: string; document?: string; communeHint?: string }[] = [];
  const incomplete: [string, string][] = [];
  const ctx = {
    fetch: async (url: string, init?: Asked["init"]) => {
      asked.push({ url, init });
      return answer(asked.length);
    },
    communeInsee: communes,
    config,
    incomplete: (i: string, r: string) => incomplete.push([i, r]),
  };
  for await (const d of streamEstateAdapter.discover(ctx)) out.push(d);
  return { out, asked, incomplete };
}

process.env.STREAM_ESTATE_V2_API_KEY = "test-key";
const records = async () => (await discoverWith(() => PAGE)).out.map((d) => JSON.parse(d.document!) as StreamRecord);

test("the search is a POST of their criteria, with the key from the environment", async () => {
  const { asked } = await discoverWith(() => PAGE);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, "https://api-v2.stream.estate/properties");
  assert.equal(asked[0].init?.method, "POST");
  assert.equal(asked[0].init?.json, true);
  assert.equal(asked[0].init?.headers?.["x-api-key"], "test-key");
  const body = JSON.parse(asked[0].init!.body!);
  assert.deepEqual(body, JSON.parse(searchBody("83119", 100, null)));
  assert.equal(body.criteria.property.transaction.type, "SELL");
  assert.deepEqual(body.criteria.property.locations.in.uniqueCodes, ["83119"]);
  assert.equal(body.paginationType, "CURSOR");
});

test("no key, no pass: said once, not twelve times", async () => {
  const saved = process.env.STREAM_ESTATE_V2_API_KEY;
  delete process.env.STREAM_ESTATE_V2_API_KEY;
  await assert.rejects(discoverWith(() => PAGE), /STREAM_ESTATE_V2_API_KEY is not set/);
  process.env.STREAM_ESTATE_V2_API_KEY = saved;
});

test("only properties we do not already collect are taken", async () => {
  const recs = await records();
  assert.equal(recs.length, 4); // of 30: 17 only on Vizzit/Bien'ici, 9 only on held-back or unnamed sources
  for (const r of recs) {
    const sources = r.listings.map((l) => l.source);
    assert.ok(sources.some((s) => !["vizzit", "bienici", "luxuryestate"].includes(s)), sources.join(","));
  }
});

test("Leboncoin and unnamed listings are not stored, only counted", async () => {
  for (const r of await records()) {
    assert.equal(r.listings.some((l) => l.source === "leboncoin" || l.source === "unnamed"), false);
    for (const l of r.listings) assert.match(l.url, /^https:\/\//);
  }
  const withHeld = (await records()).find((r) => Object.keys(r.heldBack).length > 0);
  assert.ok(withHeld, "the fixture has a property whose held-back listings were counted");
});

test("once the licence question is answered, the config lets them in", async () => {
  const strict = (await discoverWith(() => PAGE)).out.length;
  const open = (await discoverWith(() => PAGE, { heldBack: [], takeUnnamed: true })).out.length;
  assert.ok(open > strict, `${open} > ${strict}`);
});

test("the stored record leaves out what moves on every re-crawl", async () => {
  for (const r of await records()) {
    assert.equal("updatedAt" in r.property, false);
    assert.equal("changes" in r.property, false);
  }
});

test("a locality keeps only what names it", async () => {
  const { out, incomplete } = await discoverWith(() => PAGE, { localities: { "83119": ["nowhere-at-all"] } });
  assert.equal(out.length, 0);
  assert.deepEqual(incomplete, []);
});

test("a refused or malformed page marks the commune incomplete", async () => {
  const refused = await discoverWith(() => {
    throw new Error("HTTP 403");
  });
  assert.match(refused.incomplete[0][1], /page 1 failed: HTTP 403/);
  const odd = await discoverWith(() => JSON.stringify({ hello: "world" }));
  assert.match(odd.incomplete[0][1], /not the answer expected/);
});

test("pages are followed by their cursor", async () => {
  const p = JSON.parse(PAGE);
  const first = JSON.stringify({ ...p, meta: { ...p.meta, totalItems: 60, hasNextPage: true, cursor: "abc" } });
  const second = JSON.stringify({ ...p, data: [], meta: { ...p.meta, totalItems: 60, hasNextPage: false, cursor: null } });
  const { asked } = await discoverWith((n) => (n === 1 ? first : second));
  assert.equal(asked.length, 2);
  assert.equal(JSON.parse(asked[1].init!.body!).cursor, "abc");
});

test("a record parses into a listing: price, surfaces, agency reference, photos, the portal it links to", async () => {
  const { out } = await discoverWith(() => PAGE);
  const besse = out.find((d) => JSON.parse(d.document!).listings.some((l: { source: string }) => l.source === "bellesdemeures"));
  assert.ok(besse);
  const r = streamEstateAdapter.parse(besse!.document!, besse!.url);
  if (r.status === "failed") return assert.fail(r.error);
  const l = r.listing;
  assert.equal(l.priceEur, 995_000);
  assert.equal(l.areaM2, 89);
  assert.equal(l.landM2, 74);
  assert.equal(l.propertyType, "Maison");
  assert.equal(l.agencyName, "PATRICE BESSE");
  assert.equal(l.agencyRef, "553710");
  assert.ok(l.imageUrls.length >= 5);
  assert.equal(l.communeRaw, "Saint-Tropez");
  assert.equal(l.postalCode, "83990");
  assert.equal(l.url, besse!.url);
  assert.deepEqual((l.raw as { heldBack: Record<string, number> }).heldBack, { unnamed: 1, leboncoin: 1 });
});

test("a word where an agency name should be is not taken as one", async () => {
  const { out } = await discoverWith(() => PAGE);
  for (const d of out) {
    const r = streamEstateAdapter.parse(d.document!, d.url);
    if (r.status === "failed") continue;
    assert.notEqual(r.listing.agencyName?.toLowerCase(), "transaction");
  }
});

test("a city-level position is a centre and is not stored", async () => {
  const { out } = await discoverWith(() => PAGE);
  for (const d of out) {
    const rec = JSON.parse(d.document!) as StreamRecord;
    const r = streamEstateAdapter.parse(d.document!, d.url);
    if (r.status === "failed") continue;
    const accuracy = (rec.property.location as { accuracy?: string }).accuracy;
    if (accuracy !== "PRECISE") assert.equal(r.listing.lat, null);
  }
});
