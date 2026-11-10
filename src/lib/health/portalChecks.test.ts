import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeedListing, FeedProperty } from "./contract";
import { historyFromFeed, runPortalChecks, tally, type CheckResult, type HealthInput, type HistoryRow } from "./portalChecks";

const NOW = new Date("2026-11-03T09:15:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const listing = (over: Partial<FeedListing> = {}): FeedListing => ({
  source: "seloger",
  via: "stream-estate",
  url: "https://www.seloger.com/1",
  priceEur: 500_000,
  areaM2: 100,
  bedrooms: 3,
  firstSeenAt: daysAgo(60).toISOString(),
  lastSeenAt: daysAgo(1).toISOString(),
  sourceUpdatedAt: null,
  characteristics: [],
  ...over,
});

const property = (id: string, over: Partial<FeedProperty> = {}): FeedProperty => ({
  id,
  title: "Villa",
  description: "Belle villa",
  priceEur: 500_000,
  areaM2: 100,
  bedrooms: 3,
  propertyType: "Maison",
  communeInsee: "83119",
  imageUrl: "https://img.example/a.jpg",
  imageUrls: ["https://img.example/a.jpg"],
  listings: [listing()],
  ...over,
});

const history = (portal: string, ageDays: number, over: Partial<HistoryRow> = {}): HistoryRow => ({
  portal,
  propertyId: "p",
  firstSeenAt: new Date(daysAgo(ageDays).getTime() - 3_600_000),
  hasPrice: true,
  hasArea: true,
  hasBedrooms: true,
  propertyHasBedrooms: true,
  propertyType: "Maison",
  hasPhoto: true,
  hasCommune: true,
  ...over,
});

function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    now: NOW,
    properties: [],
    history: [],
    status: [],
    lastCollectionAt: daysAgo(0.2).toISOString(),
    closedByAge: new Map(),
    priceJumps: 0,
    hiddenDuplicates: new Set(),
    origins: new Map(),
    activeBySource: new Map(),
    meter: null,
    previous: () => [],
    previousPortals: null,
    ...over,
  };
}

/** A portal is only judged once it has live stock or the collector reports on it. */
const reports = (key: string) => [{ key, lastRunAt: daysAgo(0.3).toISOString(), lastOutcome: "done" }];

const find = (rs: CheckResult[], key: string, source = "") => rs.find((r) => r.key === key && r.source === source);

test("V1's rows read as stale to the client's rule and as by design to ours", () => {
  const properties = Array.from({ length: 30 }, (_, i) =>
    property(`p${i}`, { listings: [listing({ source: "figaro-immobilier", via: "stream-estate-v1", lastSeenAt: daysAgo(19).toISOString() })] }),
  );
  const r = find(runPortalChecks(input({ properties })), "market.stale_active", "figaro-immobilier");
  assert.equal(r?.vault, "amber");
  assert.equal(r?.ours, "green");
  assert.match(r?.message ?? "", /30 of 30 active listings not seen for 14 days \(100 %\)/);
  assert.match(r?.note ?? "", /by design/);
});

test("a directly collected portal not re-read is stale to both", () => {
  const properties = Array.from({ length: 30 }, (_, i) =>
    property(`p${i}`, { listings: [listing({ source: "vizzit", via: null, lastSeenAt: daysAgo(19).toISOString() })] }),
  );
  const r = find(runPortalChecks(input({ properties })), "market.stale_active", "vizzit");
  assert.equal(r?.vault, "amber");
  assert.equal(r?.ours, "amber");
});

test("a portal date excuses a row for 30 days, no longer", () => {
  const stale = (age: number) =>
    Array.from({ length: 30 }, (_, i) =>
      property(`p${i}`, { listings: [listing({ source: "bienici", via: null, lastSeenAt: daysAgo(age).toISOString(), sourceUpdatedAt: daysAgo(90).toISOString() })] }),
    );
  assert.equal(find(runPortalChecks(input({ properties: stale(20) })), "market.stale_active", "bienici")?.ours, "green");
  assert.equal(find(runPortalChecks(input({ properties: stale(31) })), "market.stale_active", "bienici")?.ours, "amber");
});

test("one bad night is red to the client's rule, three ordinary nights are not to ours", () => {
  const nights = [9, 23, 31, 30, 15, 13, 34, 23, 19, 25];
  const rows = nights.flatMap((n, age) => Array.from({ length: n }, () => history("etreproprio", age)));
  const r = find(runPortalChecks(input({ history: rows, status: reports("etreproprio") })), "market.new_listings", "etreproprio");
  assert.equal(r?.vault, "red");
  assert.equal(r?.value, 9);
  assert.equal(r?.ours, "green");
});

test("a real fall over three nights stays visible to ours", () => {
  const nights = [32, 21, 26, 70, 58, 30, 63, 91, 52, 87];
  const rows = nights.flatMap((n, age) => Array.from({ length: n }, () => history("vizzit", age)));
  const r = find(runPortalChecks(input({ history: rows, status: reports("vizzit") })), "market.new_listings", "vizzit");
  assert.equal(r?.vault, "red");
  assert.equal(r?.ours, "amber");
  assert.match(r?.note ?? "", /last 3 nights 79/);
});

test("a small portal's lean three nights are amber to ours; a large portal's are red", () => {
  const judge = (portal: string, nights: number[]) =>
    find(runPortalChecks(input({ history: nights.flatMap((n, age) => Array.from({ length: n }, () => history(portal, age))), status: reports(portal) })), "market.new_listings", portal)?.ours;
  assert.equal(judge("bellesdemeures", [4, 2, 0, 6, 8, 8, 8, 4, 6, 5]), "amber");
  assert.equal(judge("seloger", [5, 4, 6, 40, 42, 38, 45, 41, 39, 44]), "red");
  assert.equal(judge("seloger", [0, 0, 0, 40, 42, 38, 45, 41, 39, 44]), "red");
});

test("a programme has no bedroom count: red to the client's list, not to ours", () => {
  const recent = [
    ...Array.from({ length: 54 }, () => history("bienici", 1, { propertyType: "Programme neuf", hasBedrooms: false, propertyHasBedrooms: false })),
    ...Array.from({ length: 32 }, () => history("bienici", 1)),
    ...Array.from({ length: 7 }, () => history("bienici", 1, { hasBedrooms: false, propertyHasBedrooms: false })),
  ];
  const base = Array.from({ length: 200 }, (_, i) => history("bienici", 20, { hasBedrooms: i > 20, propertyHasBedrooms: i > 20 }));
  const r = find(runPortalChecks(input({ history: [...recent, ...base], status: reports("bienici") })), "market.missing_bedrooms", "bienici");
  assert.equal(r?.vault, "red");
  assert.equal(r?.ours, "green");
  assert.match(r?.note ?? "", /54 are types with no bedroom count/);
});

test("judged as of a past moment, what arrived after it has not arrived", () => {
  const later = Array.from({ length: 40 }, () => history("pap", -1, { hasBedrooms: false, propertyHasBedrooms: false }));
  const rs = runPortalChecks(input({ history: [...later, history("pap", 30)], status: reports("pap") }));
  assert.equal(find(rs, "market.missing_bedrooms", "pap"), undefined);
  assert.equal(find(rs, "market.new_listings", "pap")?.value, 0);
});

test("a value the portal itself printed counts as stated", () => {
  const recent = Array.from({ length: 20 }, () => history("pap", 1, { hasBedrooms: false, propertyHasBedrooms: true }));
  const r = find(runPortalChecks(input({ history: recent, status: reports("pap") })), "market.missing_bedrooms", "pap");
  assert.equal(r?.vault, "green");
});

test("the contract: filed under the portal seen last by the client's rule, under its real supplier by ours", () => {
  const bad = "/_ipx/f_webp&s_800x600/https://storage.etreproprio.com/a.jpeg";
  const properties = Array.from({ length: 60 }, (_, i) => property(`p${i}`, { imageUrls: ["https://img.example/a.jpg", bad] }));
  const origins = new Map(properties.map((p) => [p.id, new Map([["photos", ["etreproprio"]]])]));
  const rs = runPortalChecks(input({ properties, origins, activeBySource: new Map([["etreproprio", 100]]) }));

  const filed = find(rs, "market.quarantine", "seloger");
  assert.equal(filed?.vault, "red");
  assert.equal(filed?.ours, null);
  assert.match(filed?.message ?? "", /60 values refused or mended in the last read \(60 dropped; photos\)/);

  const real = find(rs, "ours.value_origin", "etreproprio");
  assert.equal(real?.vault, null);
  assert.equal(real?.ours, "red");
  assert.equal(real?.value, 60);
  assert.equal(real?.detail.sample, bad);
  assert.equal(find(rs, "ours.value_origin", "seloger"), undefined);
});

test("a large portal is not red for being large: mended titles as a share of the source", () => {
  const properties = Array.from({ length: 40 }, (_, i) => property(`p${i}`, { title: "DÃ©couvrez" }));
  const origins = new Map(properties.map((p) => [p.id, new Map([["title", ["stream-estate"]]])]));
  const rs = runPortalChecks(input({ properties, origins, activeBySource: new Map([["stream-estate", 4806]]) }));
  assert.equal(find(rs, "ours.value_origin", "stream-estate")?.ours, "green");
});

test("price per m²: a raw label for a plot counts for the client's rule, not for ours", () => {
  const homes = Array.from({ length: 40 }, (_, i) => property(`h${i}`, { priceEur: 1_000_000, areaM2: 100 }));
  const plots = Array.from({ length: 3 }, (_, i) => property(`l${i}`, { propertyType: "Landform", priceEur: 200_000, areaM2: 2000 }));
  const r = find(runPortalChecks(input({ properties: [...homes, ...plots] })), "market.ppm_outliers");
  assert.equal(r?.vault, "red");
  assert.equal(r?.ours, "green");
  assert.equal(r?.detail.low, 3);
});

test("the duplicates the client hides leave the price check and are reported", () => {
  const homes = Array.from({ length: 40 }, (_, i) => property(`h${i}`));
  const odd = property("odd", { priceEur: 10_000, areaM2: 100 });
  const without = runPortalChecks(input({ properties: [...homes, odd], hiddenDuplicates: new Set(["odd"]) }));
  assert.equal(find(without, "market.ppm_outliers")?.detail.low, 0);
  assert.match(find(without, "market.duplicates")?.message ?? "", /1 of 41 active listings/);
});

test("a run that errored or aborted is red, and the first check only records the portals", () => {
  const status = [
    { key: "vizzit", lastRunAt: daysAgo(0.3).toISOString(), lastOutcome: "aborted" },
    { key: "bienici", lastRunAt: daysAgo(0.3).toISOString(), lastOutcome: "done" },
  ];
  const rs = runPortalChecks(input({ status }));
  assert.equal(find(rs, "market.source_run", "vizzit")?.vault, "red");
  assert.equal(find(rs, "market.source_run", "bienici")?.vault, "green");
  assert.equal(find(rs, "market.sources_changed")?.vault, "green");
  assert.deepEqual(find(rs, "market.sources_changed")?.detail.portals, ["bienici", "vizzit"]);
  assert.equal(find(runPortalChecks(input({ status, previousPortals: ["bienici", "vizzit", "pap"] })), "market.sources_changed")?.vault, "red");
});

test("a smaller feed than usual is a partial read", () => {
  const properties = Array.from({ length: 50 }, (_, i) => property(`p${i}`));
  const rs = runPortalChecks(input({ properties, previous: (key) => (key === "market.sync_run" ? [100, 100, 100] : []) }));
  assert.equal(find(rs, "market.sync_run")?.vault, "red");
});

test("the V1 meter is ours alone, amber from 80 % of the cap", () => {
  const meter = (items: number) => ({ items, cap: 14_000, periodStart: new Date("2026-10-14") });
  assert.equal(find(runPortalChecks(input({ meter: meter(8_344) })), "ours.v1_meter", "stream-estate-v1")?.ours, "green");
  assert.equal(find(runPortalChecks(input({ meter: meter(11_500) })), "ours.v1_meter", "stream-estate-v1")?.ours, "amber");
  const full = find(runPortalChecks(input({ meter: meter(13_500) })), "ours.v1_meter", "stream-estate-v1");
  assert.equal(full?.ours, "red");
  assert.equal(full?.vault, null);
});

test("a live property's history is the feed's own listings, one row each", () => {
  const rows = historyFromFeed([
    property("a", {
      bedrooms: null,
      imageUrl: "/_ipx/x.jpeg",
      imageUrls: ["/_ipx/x.jpeg"],
      listings: [listing({ source: "seloger", bedrooms: null, characteristics: [{ label: "Chambres", value: "4 chambres" }] }), listing({ source: "pap", priceEur: null, areaM2: null, firstSeenAt: null })],
    }),
  ]);
  assert.equal(rows.length, 1, "a listing with no first sighting has nothing to say about when it arrived");
  assert.equal(rows[0].portal, "seloger");
  assert.equal(rows[0].hasBedrooms, false);
  assert.equal(rows[0].propertyHasBedrooms, true);
  assert.equal(rows[0].hasPhoto, false);
});

test("each tally counts only the rows its side judged", () => {
  const rs = runPortalChecks(input({ meter: { items: 1, cap: 10, periodStart: NOW } }));
  const vault = tally(rs, "vault");
  const ours = tally(rs, "ours");
  assert.equal(ours.checks, vault.checks + 1);
});

test("new listings are judged against the same nights of earlier weeks once two are known", () => {
  // Green-Acres, five weeks to 2026-11-10: quiet on the nights after Saturday and Sunday, busy midweek.
  const week = [6, 5, 7, 30, 35, 28, 25]; // ages 0..6: tonight Tuesday's, then Monday's, Sunday's, ...
  const quietStart = [...week, ...week, ...week, ...week];
  const judge = (nights: number[]) =>
    find(runPortalChecks(input({ history: nights.flatMap((n, age) => Array.from({ length: n }, () => history("green-acres", age))), status: reports("green-acres") })), "market.new_listings", "green-acres");
  const ordinary = judge(quietStart);
  assert.equal(ordinary?.vault, "red", "the client's rule sees 6 against a weekly median of 25");
  assert.equal(ordinary?.ours, "green", "the same three nights were 18 the weeks before too");
  assert.match(ordinary?.note ?? "", /same nights/);
  // The same start of the week, but the collector brought nothing on a week that used to bring plenty.
  const busyWeek = [30, 28, 32, 30, 35, 28, 25];
  const fell = judge([0, 1, 0, 30, 35, 28, 25, ...busyWeek, ...busyWeek, ...busyWeek]);
  assert.equal(fell?.ours, "red");
});

