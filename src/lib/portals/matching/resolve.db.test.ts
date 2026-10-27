/**
 * resolve against a real Postgres. Opt-in and local only — see
 * runner/ingest.db.test.ts for how to start the database it needs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.PMA_TEST_DATABASE_URL;
const local = !!url && /^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url);
if (url && !local) throw new Error("PMA_TEST_DATABASE_URL must point at a loopback database — this test writes.");
if (local) process.env.DATABASE_URL = url;
const skip = !local && "PMA_TEST_DATABASE_URL not set — the database tests are opt-in";

const COMMUNE = "83999"; // no real commune: the test owns everything in it
let m: {
  db: typeof import("@/lib/db/client").db;
  schema: typeof import("@/lib/db/schema");
  resolve: typeof import("./resolve");
  sql: typeof import("drizzle-orm").sql;
};

before(async () => {
  if (!local) return;
  m = {
    db: (await import("@/lib/db/client")).db,
    schema: await import("@/lib/db/schema"),
    resolve: await import("./resolve"),
    sql: (await import("drizzle-orm")).sql,
  };
  await cleanup();
});
after(async () => {
  if (local) await cleanup();
});

async function cleanup() {
  await m.db.execute(m.sql`delete from portal_sources where key in ('dbtest-on', 'dbtest-off')`);
  await m.db.execute(m.sql`delete from properties where commune_insee = ${COMMUNE}`);
  await m.db.execute(m.sql`delete from portal_agencies where name_normalized = 'dbtest agency'`);
}

test("a property speaks with the voice of a source still collected, not a switched-off one", { skip }, async () => {
  const src = async (key: string, enabled: boolean) =>
    (await m.db.insert(m.schema.portalSources)
      .values({ key, name: key, discoveryMode: "index", baseUrl: "https://example.test", enabled })
      .returning({ id: m.schema.portalSources.id }))[0].id;
  const on = await src("dbtest-on", true);
  const off = await src("dbtest-off", false);
  /**
   * One agency, one mandate on both rows. A switched-off source's row may join
   * only that way since 2026-10-26 (`staleSourceIds` in clusterCandidates):
   * matched by size, at the price it had when its collector stopped, it glued
   * homes now at other prices into one card.
   */
  const [agency] = await m.db
    .insert(m.schema.portalAgencies)
    .values({ name: "DB test agency", nameNormalized: "dbtest agency" })
    .returning({ id: m.schema.portalAgencies.id });

  const listing = (sourceId: string, externalId: string, title: string, description: string) => ({
    sourceId, externalId, url: `https://example.test/${externalId}`, status: "active", parseStatus: "ok",
    communeInsee: COMMUNE, priceEur: 3_000_000, areaM2: "250", landM2: "2000", propertyType: "Maison",
    agencyId: agency.id, agencyRef: "70880", title, description,
  });
  // The switched-off row is the fuller one, so it would win on completeness alone.
  await m.db.insert(m.schema.portalListings).values([
    listing(off, "old", "September title", "x ".repeat(2000)),
    listing(on, "new", "Last night's title", "short"),
  ]);

  await m.resolve.resolveCommuneIdentities(COMMUNE);

  const props = await m.db.execute<{ title: string; source_count: number }>(
    m.sql`select title, source_count from properties where commune_insee = ${COMMUNE} and status = 'active'`,
  );
  assert.equal(props.rows.length, 1, "one villa, one property");
  assert.equal(props.rows[0].title, "Last night's title");
  assert.equal(props.rows[0].source_count, 1, "counted from what is served");
});
