/**
 * Ingest against a real Postgres — the races and retries a mock cannot show.
 *
 * OPT-IN, AND LOCAL ONLY. Runs when `PMA_TEST_DATABASE_URL` points at a
 * loopback database with the migrations applied, and is skipped otherwise:
 *
 *   initdb -D /tmp/pg --locale=C -U postgres --auth=trust
 *   pg_ctl -D /tmp/pg -o "-p 54329 -k ''" start
 *   createdb -h 127.0.0.1 -p 54329 -U postgres pma_test
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/pma_test npx tsx src/lib/db/migrate.ts
 *   PMA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/pma_test \
 *     node --import tsx --test src/lib/portals/runner/ingest.db.test.ts
 *
 * It refuses any other host, because it writes, and the only remote database
 * this project has is the client's.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const url = process.env.PMA_TEST_DATABASE_URL;
const local = !!url && /^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url);
if (url && !local) throw new Error("PMA_TEST_DATABASE_URL must point at a loopback database — this test writes.");
// Set before anything opens the pool, so `.env.local` (production) is never loaded.
if (local) process.env.DATABASE_URL = url;

const SOURCE_KEY = "dbtest-ingest";
const skip = !local && "PMA_TEST_DATABASE_URL not set — the database tests are opt-in";

type Mods = {
  db: typeof import("@/lib/db/client").db;
  schema: typeof import("@/lib/db/schema");
  ingest: typeof import("./ingest");
  sql: typeof import("drizzle-orm").sql;
};
let m: Mods;
let sourceId: string;

before(async () => {
  if (!local) return;
  const { db } = await import("@/lib/db/client");
  const schema = await import("@/lib/db/schema");
  const ingest = await import("./ingest");
  const { sql } = await import("drizzle-orm");
  m = { db, schema, ingest, sql };
  await db.execute(sql`delete from portal_sources where key = ${SOURCE_KEY}`);
  const [row] = await db
    .insert(schema.portalSources)
    .values({ key: SOURCE_KEY, name: "DB test", discoveryMode: "index", baseUrl: "https://example.test" })
    .returning({ id: schema.portalSources.id });
  sourceId = row.id;
});

after(async () => {
  if (!local || process.env.PMA_TEST_KEEP) return;
  await m.db.execute(m.sql`delete from portal_sources where key = ${SOURCE_KEY}`);
  await fs.rm(path.resolve(process.cwd(), ".pages", SOURCE_KEY), { recursive: true, force: true });
});

/** The page is the listing as JSON; the adapter reads it back. */
const adapter = {
  key: SOURCE_KEY,
  parse: (html: string) => {
    const l = JSON.parse(html) as { price: number; title?: string; agency?: string };
    return {
      status: "ok" as const,
      listing: {
        externalId: "x",
        url: "https://example.test/x",
        title: l.title ?? "Villa",
        description: null,
        priceEur: l.price,
        areaM2: 120,
        landM2: null,
        rooms: 5,
        bedrooms: 3,
        bathrooms: null,
        propertyType: "house",
        communeRaw: "Gassin",
        postalCode: "83580",
        lat: null,
        lon: null,
        agencyName: l.agency ?? null,
        agencyAddress: null,
        agencyPostalCode: null,
        agencyCity: null,
        agencyPhone: null,
        agencyRef: null,
        availability: null,
        publishedAt: null,
        sourceUpdatedAt: null,
        imageUrl: null,
        imageUrls: [],
        raw: {},
      },
    };
  },
} as unknown as Parameters<typeof import("./ingest").ingestListing>[0]["adapter"];

function deps(departing?: ReadonlySet<string>) {
  return {
    departing,
    fetch: async () => {
      throw new Error("no fetching in this test — every page is handed over as `document`");
    },
    adapter,
    sourceId,
    sourceKey: SOURCE_KEY,
    runId: null,
  };
}

/** Sorted by name, not time: a test writes two events inside one millisecond often enough to flake. */
async function eventsOf(externalId: string): Promise<string[]> {
  const r = await m.db.execute<{ type: string }>(m.sql`
    select e.type from portal_listing_events e join portal_listings l on l.id = e.listing_id
    where l.source_id = ${sourceId}::uuid and l.external_id = ${externalId} order by e.type`);
  return r.rows.map((x) => x.type);
}

test("two passes reaching the same NEW listing at once log one `listed`, not two", { skip }, async () => {
  const page = JSON.stringify({ price: 1_000_000 });
  const t = { externalId: "new-1", url: "https://example.test/new-1", document: page };
  const [a, b] = await Promise.all([m.ingest.ingestListing(deps(), t), m.ingest.ingestListing(deps(), t)]);
  assert.equal(a.listingId, b.listingId);
  assert.deepEqual(await eventsOf("new-1"), ["listed"]);
});

test("two passes seeing the same price cut at once log one `price_changed`", { skip }, async () => {
  const t = { externalId: "cut-1", url: "https://example.test/cut-1" };
  await m.ingest.ingestListing(deps(), { ...t, document: JSON.stringify({ price: 2_000_000 }) });
  const cut = JSON.stringify({ price: 1_800_000 });
  await Promise.all([
    m.ingest.ingestListing(deps(), { ...t, document: cut }),
    m.ingest.ingestListing(deps(), { ...t, document: cut }),
  ]);
  assert.deepEqual(await eventsOf("cut-1"), ["listed", "price_changed"]);
});

test("a page that changed only in its bytes logs nothing new", { skip }, async () => {
  const t = { externalId: "stale-1", url: "https://example.test/stale-1" };
  await m.ingest.ingestListing(deps(), { ...t, document: JSON.stringify({ price: 900_000 }) });
  await m.ingest.ingestListing(deps(), { ...t, document: JSON.stringify({ price: 850_000 }) });
  // Same new price again, different bytes so the hash shortcut does not take it.
  await m.ingest.ingestListing(deps(), { ...t, document: JSON.stringify({ price: 850_000, title: "Villa " }) });
  assert.deepEqual(await eventsOf("stale-1"), ["listed", "price_changed"]);
});

test("delisting twice at once logs one `delisted` per listing", { skip }, async () => {
  const ids = ["gone-1", "gone-2", "gone-3"];
  for (const id of ids) {
    await m.ingest.ingestListing(deps(), { externalId: id, url: `https://example.test/${id}`, document: JSON.stringify({ price: 500_000 }) });
  }
  const [a, b] = await Promise.all([
    m.ingest.delistListings(sourceId, ids, null),
    m.ingest.delistListings(sourceId, ids, null),
  ]);
  assert.equal(a + b, 3);
  for (const id of ids) assert.deepEqual(await eventsOf(id), ["delisted", "listed"]);
  // And again, later: nothing left to flip, nothing logged.
  assert.equal(await m.ingest.delistListings(sourceId, ids, null), 0);
});

test("the same bytes coming back after a delisting are a `relisted`, not a silent resurrection", { skip }, async () => {
  const t = { externalId: "back-1", url: "https://example.test/back-1", document: JSON.stringify({ price: 700_000 }) };
  await m.ingest.ingestListing(deps(), t);
  await m.ingest.delistListings(sourceId, ["back-1"], null);
  const out = await m.ingest.ingestListing(deps(), t);
  assert.deepEqual(out.events, ["relisted"]);
  const [row] = await m.db.execute<{ status: string; delisted_at: string | null }>(m.sql`
    select status, delisted_at from portal_listings where source_id = ${sourceId}::uuid and external_id = 'back-1'`).then((r) => r.rows);
  assert.equal(row.status, "active");
  assert.equal(row.delisted_at, null);
});

async function placeOf(externalId: string) {
  const r = await m.db.execute<{ commune_insee: string | null; property_id: string | null; abroad: string | null; status: string }>(m.sql`
    select commune_insee, property_id, raw->>'abroad' as abroad, status from portal_listings
    where source_id = ${sourceId}::uuid and external_id = ${externalId}`);
  return r.rows[0];
}

test("an advert for a home abroad is kept, but in no commune and on no property", { skip }, async () => {
  // Immocenter's Phuket villas, filed by the portals under Le Plan-de-la-Tour (2026-10-27).
  const t = { externalId: "abroad-new", url: "https://example.test/vente/-phuket/1328-kamala/abroad-new" };
  await m.ingest.ingestListing(deps(), { ...t, document: JSON.stringify({ price: 625_000 }) });
  assert.deepEqual(await placeOf("abroad-new"), { commune_insee: null, property_id: null, abroad: "phuket", status: "active" });
});

test("a stored advert recognised as abroad leaves its commune and its card", { skip }, async () => {
  const t = { externalId: "abroad-old", url: "https://example.test/abroad-old" };
  await m.ingest.ingestListing(deps(), { ...t, document: JSON.stringify({ price: 677_000, title: "Penthouse" }) });
  const [card] = await m.db.insert(m.schema.properties).values({ communeInsee: "83065" }).returning({ id: m.schema.properties.id });
  await m.db.execute(m.sql`update portal_listings set property_id = ${card.id}::uuid where source_id = ${sourceId}::uuid and external_id = 'abroad-old'`);
  assert.equal((await placeOf("abroad-old")).commune_insee, "83065");

  await m.ingest.ingestListing(deps(), { ...t, document: JSON.stringify({ price: 677_000, title: "Penthouse de luxe à Kamala – Phuket" }) });
  assert.deepEqual(await placeOf("abroad-old"), { commune_insee: null, property_id: null, abroad: "phuket", status: "active" });
  // Nothing for the client's feed: no delisting, no relisting — it simply is not in the market.
  assert.deepEqual(await eventsOf("abroad-old"), ["listed"]);
});

async function rowsOf(externalIds: string[]) {
  const r = await m.db.execute<{ id: string; external_id: string; status: string; prev: string | null }>(m.sql`
    select id, external_id, status, raw->'previousExternalIds'->>0 as prev from portal_listings
    where source_id = ${sourceId}::uuid order by external_id`);
  return r.rows.filter((x) => externalIds.includes(x.external_id));
}

test("an advert re-issued under a new id takes over the row it repeats, as a `relisted`", { skip }, async () => {
  // BONAPARTE PROMOTION TOULON on Bien'ici: one lot, eight ids between 1 Oct and 8 Nov 2026.
  const page = JSON.stringify({ price: 2_450_000, title: "L’ART DE VIVRE TROPEZIEN", agency: "Bonaparte Promotion Toulon" });
  const first = await m.ingest.ingestListing(deps(), { externalId: "mgc-1", url: "https://example.test/mgc-1", document: page });
  await m.ingest.delistListings(sourceId, ["mgc-1"], null);
  const again = await m.ingest.ingestListing(deps(), { externalId: "mgc-2", url: "https://example.test/mgc-2", document: page });

  assert.equal(again.listingId, first.listingId);
  assert.deepEqual(again.events, ["relisted"]);
  assert.deepEqual(await rowsOf(["mgc-1", "mgc-2"]), [{ id: first.listingId!, external_id: "mgc-2", status: "active", prev: "mgc-1" }]);
  const ev = await m.db.execute<{ repost_of: string | null }>(m.sql`
    select payload->>'repostOf' as repost_of from portal_listing_events where listing_id = ${first.listingId}::uuid and type = 'relisted'`);
  assert.equal(ev.rows[0].repost_of, "mgc-1");
});

test("a new advert at another price is a new listing, whoever the agency", { skip }, async () => {
  const at = (price: number) => JSON.stringify({ price, title: "Appartement T2", agency: "Bonaparte Promotion Toulon" });
  const first = await m.ingest.ingestListing(deps(), { externalId: "lot-a", url: "https://example.test/lot-a", document: at(300_000) });
  await m.ingest.delistListings(sourceId, ["lot-a"], null);
  const other = await m.ingest.ingestListing(deps(), { externalId: "lot-b", url: "https://example.test/lot-b", document: at(310_000) });
  assert.notEqual(other.listingId, first.listingId);
  assert.deepEqual(other.events, ["listed"]);
});

test("a listing still active is not taken over: a swap inside one night stays a delisting and a listing", { skip }, async () => {
  const page = JSON.stringify({ price: 990_000, title: "Villa vue mer", agency: "Agence du Golfe" });
  const first = await m.ingest.ingestListing(deps(), { externalId: "swap-1", url: "https://example.test/swap-1", document: page });
  const second = await m.ingest.ingestListing(deps(), { externalId: "swap-2", url: "https://example.test/swap-2", document: page });
  assert.notEqual(second.listingId, first.listingId);
  assert.deepEqual(second.events, ["listed"]);
});

test("a swap inside one night takes over the advert this pass is about to delist, and nothing is delisted", { skip }, async () => {
  // Bonaparte drops yesterday's ids in the same pass that brings today's.
  const page = JSON.stringify({ price: 1_250_000, title: "T4 vue mer, programme neuf", agency: "Bonaparte Promotion Toulon" });
  const older = await m.ingest.ingestListing(deps(), { externalId: "bp-1", url: "https://example.test/bp-1", document: page });
  await m.ingest.delistListings(sourceId, ["bp-1"], null);
  const yesterday = await m.ingest.ingestListing(deps(), { externalId: "bp-2", url: "https://example.test/bp-2", document: JSON.stringify({ price: 1_250_000, title: "T4 vue mer, programme neuf", agency: "Bonaparte Promotion Toulon", v: 2 }) });
  assert.equal(yesterday.listingId, older.listingId, "bp-2 took over bp-1, delisted the day before");

  const tonight = await m.ingest.ingestListing(deps(new Set(["bp-2"])), { externalId: "bp-3", url: "https://example.test/bp-3", document: JSON.stringify({ price: 1_250_000, title: "T4 vue mer, programme neuf", agency: "Bonaparte Promotion Toulon", v: 3 }) });
  assert.equal(tonight.listingId, older.listingId);
  assert.deepEqual(tonight.events, []);
  assert.equal(await m.ingest.delistListings(sourceId, ["bp-2"], null), 0, "nothing left under the old id to delist");
  const [row] = await m.db.execute<{ external_id: string; status: string; prev: string }>(m.sql`
    select external_id, status, raw->>'previousExternalIds' as prev from portal_listings where id = ${older.listingId}::uuid`).then((r) => r.rows);
  assert.deepEqual(row, { external_id: "bp-3", status: "active", prev: '["bp-1", "bp-2"]' });
});

test("the ids a row answered to before survive its next refresh", { skip }, async () => {
  const page = (v: number) => JSON.stringify({ price: 640_000, title: "T3 terrasse, programme neuf", agency: "Bonaparte Promotion Toulon", v });
  const first = await m.ingest.ingestListing(deps(), { externalId: "keep-1", url: "https://example.test/keep-1", document: page(1) });
  await m.ingest.delistListings(sourceId, ["keep-1"], null);
  await m.ingest.ingestListing(deps(), { externalId: "keep-2", url: "https://example.test/keep-2", document: page(2) });
  // A later refresh of the same row, different bytes so it is parsed and written again.
  await m.ingest.ingestListing(deps(), { externalId: "keep-2", url: "https://example.test/keep-2", document: page(3) });
  const [row] = await m.db.execute<{ prev: string; type_raw: string | null; type: string | null }>(m.sql`
    select raw->>'previousExternalIds' as prev, raw->>'propertyTypeRaw' as type_raw, property_type as type from portal_listings where id = ${first.listingId}::uuid`).then((r) => r.rows);
  assert.equal(row.prev, '["keep-1"]');
  // The test adapter says "house": stored as the client's word, the portal's kept beside it.
  assert.equal(row.type, "Maison");
  assert.equal(row.type_raw, "house");
});

test("what a model read survives the next refresh, and its type is not overwritten by a generic title", { skip }, async () => {
  const page = (v: number) => JSON.stringify({ price: 900_000, title: "Achat : Maison (83120)", v });
  const first = await m.ingest.ingestListing(deps(), { externalId: "ai-1", url: "https://example.test/ai-1", document: page(1) });
  // What aiFactsRun writes for a beach restaurant behind V1's generic title.
  await m.db.execute(m.sql`update portal_listings set property_type = 'Commerce',
    raw = raw || '{"ai": {"model": "claude-haiku-5-5", "accepted": {"propertyType": "Commerce"}, "quotes": {"propertyType": "ce restaurant de plage"}}}'::jsonb
    where id = ${first.listingId}::uuid`);
  await m.ingest.ingestListing(deps(), { externalId: "ai-1", url: "https://example.test/ai-1", document: page(2) });
  const [row] = await m.db.execute<{ type: string; ai_type: string | null }>(m.sql`
    select property_type as type, raw->'ai'->'accepted'->>'propertyType' as ai_type from portal_listings where id = ${first.listingId}::uuid`).then((r) => r.rows);
  assert.deepEqual(row, { type: "Commerce", ai_type: "Commerce" });
});
