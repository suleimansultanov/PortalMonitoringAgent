import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeStreamEstateV1Adapter, toRecord } from "./streamestatev1";
import { BudgetError, type V1Client } from "../streamV1";

/**
 * Ten La Môle properties as the paid V1 API answered on 2026-10-14 (the
 * reconciliation page), agents' phone numbers and names redacted. The
 * questions here are the ones that cost money if answered wrong: what is
 * asked for, and how often.
 */
const PAGE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "__fixtures__", "stream-estate-v1-la-mole.json"), "utf8")) as {
  "hydra:totalItems": number;
  "hydra:member": Record<string, unknown>[];
};

/** A client that answers every paid page with the fixture and records what was asked. */
function fakeClient(opts: { cap?: number; refuseAfter?: number } = {}) {
  const asked: string[] = [];
  let paid = 0;
  const client: V1Client = {
    cap: opts.cap ?? 14_000,
    periodStart: new Date("2026-10-14T00:00:00Z"),
    totals: async () => ({ items: paid, uncertain: 0, paidRequests: 0, freeRequests: 0 }),
    remaining: async () => (opts.cap ?? 14_000) - paid,
    async call(q) {
      const canonical = [...q.entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
      asked.push(canonical);
      if (opts.refuseAfter !== undefined && asked.length > opts.refuseAfter) throw new BudgetError("refused before sending: the cap");
      // The "expired" query answers with the last three of the fixture; every other query with the first seven.
      const all = PAGE["hydra:member"];
      const items = canonical.includes("expired=true") ? all.slice(7) : all.slice(0, 7);
      paid += items.length;
      return { total: items.length, items, fromCache: false, spent: items.length };
    },
  };
  return { client, asked };
}

async function discoverWith(opts: {
  since: Date | null;
  cap?: number;
  refuseAfter?: number;
  communes?: string[];
  config?: Record<string, unknown>;
  /** Communes we already hold stock for; by default every commune once a pass has completed. */
  stocked?: string[];
}) {
  const { client, asked } = fakeClient(opts);
  const adapter = makeStreamEstateV1Adapter({
    client: () => client,
    lastPassAt: async () => opts.since,
    hasStock: async (insee) => (opts.stocked ? opts.stocked.includes(insee) : opts.since !== null),
    now: () => new Date("2026-10-15T00:00:00Z"),
  });
  const out: { externalId: string; url: string; document?: string }[] = [];
  const incomplete: [string, string][] = [];
  const gone: string[] = [];
  const ctx = {
    fetch: async () => {
      throw new Error("the V1 adapter must not use ctx.fetch: every request goes through the meter");
    },
    communeInsee: opts.communes ?? ["83079"],
    config: opts.config ?? {},
    incomplete: (i: string, r: string) => incomplete.push([i, r]),
    gone: (id: string) => gone.push(id),
  };
  for await (const d of adapter.discover(ctx as never)) out.push(d);
  return { out, asked, incomplete, gone, adapter };
}

test("with no completed pass, the stock is read once: not expired, updated in the last 30 days", async () => {
  const { asked, incomplete } = await discoverWith({ since: null });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /expired=false/);
  assert.match(asked[0], /fromUpdatedAt=2026-09-15/);
  assert.match(asked[0], /includedInseeCodes\[\]=83079/);
  assert.match(asked[0], /itemsPerPage=30/);
  assert.doesNotMatch(asked[0], /fromDate|eventPriceVariation|fromExpiredAt/);
  assert.deepEqual(incomplete, []);
});

test("after a pass, only what changed since it is asked for: created, re-priced, expired", async () => {
  const since = new Date("2026-10-14T03:00:00Z");
  const { asked, incomplete, gone, out } = await discoverWith({ since });
  assert.equal(asked.length, 3);
  // An hour's slack: their clock, their zone.
  assert.match(asked[0], /fromDate=2026-10-14 02:00:00/);
  assert.match(asked[0], /expired=false/);
  assert.match(asked[1], /eventPriceVariationFromCreatedAt=2026-10-14 02:00:00/);
  assert.match(asked[2], /expired=true/);
  assert.match(asked[2], /fromExpiredAt=2026-10-14 02:00:00/);
  for (const a of asked) assert.doesNotMatch(a, /fromUpdatedAt/);
  // The pass did not see the market: said so, so nothing is delisted for being unseen.
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0][1], /changes only/);
  // What the "expired" query returns is reported gone, by name, and never yielded.
  assert.equal(gone.length, 3);
  assert.equal(new Set([...out.map((o) => o.externalId), ...gone]).size, out.length + gone.length, "a property is yielded or reported gone, never both");
});

test("a commune with no stock takes the stock, even after a pass that reached the others", async () => {
  const since = new Date("2026-10-14T03:00:00Z");
  const { asked, incomplete } = await discoverWith({ since, communes: ["83079", "83065"], stocked: ["83079"] });
  // La Môle, stocked: three change queries. Gassin, never reached: one stock query.
  assert.equal(asked.length, 4);
  assert.match(asked[3], /includedInseeCodes\[\]=83065/);
  assert.match(asked[3], /fromUpdatedAt=/);
  assert.doesNotMatch(asked[3], /fromDate|fromExpiredAt/);
  assert.deepEqual(incomplete.map(([i]) => i), ["83079"], "only the changes-only commune is incomplete");
});

test("Les Issambres is asked for by its postcode, which replaces the INSEE code", async () => {
  const { asked } = await discoverWith({ since: null, communes: ["83107"] });
  assert.match(asked[0], /includedZipcodes\[\]=83380/);
  assert.doesNotMatch(asked[0], /includedInseeCodes/);
});

test("a property seen only on portals we collect ourselves is not taken", async () => {
  const { out } = await discoverWith({ since: null, config: { ownSources: ["vizzit", "bienici", "iadfrance", "leboncoin", "seloger", "paruvendu", "rightmove", "gensdeconfiance", "century21", "maisonsetappartements", "leapfrog-properties", "bellesdemeures", "idealista", "pap", "figaro-immobilier", "figaro", "superimmo"] } });
  const kept = out.length;
  const all = (await discoverWith({ since: null, config: { ownSources: [] } })).out.length;
  assert.ok(kept < all, `${kept} < ${all}`);
});

test("when the meter refuses, the pass stops, says so for every commune not asked, and throws nothing", async () => {
  const { asked, incomplete, out } = await discoverWith({ since: null, refuseAfter: 1, communes: ["83079", "83065", "83101"] });
  assert.equal(asked.length, 2, "the second request was the refused one; the third commune was never asked");
  assert.ok(out.length > 0, "what came back before the refusal is kept");
  assert.equal(incomplete.length, 2);
  for (const [, reason] of incomplete) assert.match(reason, /cap/);
});

test("a record keeps live adverts only, names each by the portal in its URL, and folds price events", () => {
  const p = PAGE["hydra:member"][0] as Parameters<typeof toRecord>[0];
  const rec = toRecord(p);
  assert.equal(rec.id, "27ff886f-f234-4600-b34c-042b3a250bb0");
  const adverts = p.adverts ?? [];
  const live = adverts.filter((a) => !a.expired && a.url);
  assert.equal(rec.listings.length, live.length);
  assert.ok(adverts.some((a) => a.expired), "the fixture's first property has an expired advert, and it is not a place the property is shown");
  for (const l of rec.listings) assert.match(l.source, /^[a-z0-9-]+$/);
  assert.ok(rec.priceEvents.length > 0);
  assert.equal("updatedAt" in rec.property, false);
  assert.equal("adverts" in rec.property, false);
});

test("a record parses: euro price, surfaces, type, the commune under the client's label, their date kept out of publishedAt", async () => {
  const { out, adapter } = await discoverWith({ since: null, config: { ownSources: [] } });
  const first = out.find((o) => o.externalId === "27ff886f-f234-4600-b34c-042b3a250bb0");
  assert.ok(first);
  const r = adapter.parse(first!.document!, first!.url);
  if (r.status === "failed") return assert.fail(r.error);
  const l = r.listing;
  assert.equal(l.priceEur, 567_000);
  assert.equal(l.areaM2, 157);
  assert.equal(l.rooms, 6);
  assert.equal(l.bedrooms, 3);
  assert.equal(l.propertyType, "Maison");
  assert.equal(l.communeRaw, "La Môle", "their name for it is 'Môle', which resolves to nothing");
  assert.equal(l.postalCode, "83310");
  assert.equal(l.publishedAt, null, "their createdAt is their first sighting, not the portal's publication");
  assert.ok(l.imageUrls.length > 0);
  for (const u of l.imageUrls) assert.match(u, /^https:\/\//);
  const raw = l.raw as { source: string; listings: { url: string; publishedAt: null; firstSeenByThem: string | null }[]; priceEvents: unknown[] };
  assert.equal(raw.source, "stream-estate-v1");
  assert.ok(raw.listings.length > 0);
  for (const x of raw.listings) assert.equal(x.publishedAt, null);
  assert.ok(raw.priceEvents.length > 0);
});

test("a land plot keeps its surface as land", () => {
  const { adapter } = (() => {
    const { client } = fakeClient();
    return { adapter: makeStreamEstateV1Adapter({ client: () => client, lastPassAt: async () => null, hasStock: async () => false }) };
  })();
  const doc = JSON.stringify({
    id: "x",
    property: { transactionType: 0, propertyType: 5, price: 200_000, surface: 1_200, landSurface: null, city: { insee: "83101", name: "Ramatuelle", zipcode: "83350" } },
    listings: [{ source: "seloger", url: "https://www.seloger.com/a/1.htm", firstSeenByThem: null, price: 200_000, agency: "X", reference: null }],
    priceEvents: [],
  });
  const r = adapter.parse(doc, "https://www.seloger.com/a/1.htm");
  if (r.status === "failed") return assert.fail(r.error);
  assert.equal(r.listing.propertyType, "Terrain");
  assert.equal(r.listing.areaM2, null);
  assert.equal(r.listing.landM2, 1_200);
  assert.equal(r.listing.communeRaw, "Ramatuelle");
});
