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
    const l = JSON.parse(html) as { price: number; title?: string };
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
        agencyName: null,
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

function deps() {
  return {
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
