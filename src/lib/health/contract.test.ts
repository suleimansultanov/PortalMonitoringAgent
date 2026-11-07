import { test } from "node:test";
import assert from "node:assert/strict";
import { bedroomsFromLabels, contractIssues, hasMojibake, leadSource, repairMojibake, sqftAsM2, unrepairable, type FeedListing, type FeedProperty } from "./contract";

const listing = (over: Partial<FeedListing> = {}): FeedListing => ({
  source: "seloger",
  via: "stream-estate",
  url: "https://www.seloger.com/1",
  priceEur: 500_000,
  areaM2: 100,
  bedrooms: 3,
  firstSeenAt: "2026-10-01T00:00:00.000Z",
  lastSeenAt: "2026-11-01T00:00:00.000Z",
  sourceUpdatedAt: null,
  characteristics: [],
  ...over,
});

const property = (over: Partial<FeedProperty> = {}): FeedProperty => ({
  id: "p1",
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

test("a clean property has nothing to refuse", () => {
  assert.deepEqual(contractIssues(property()), []);
});

test("Etreproprio's widget photos are refused, and filed under whichever portal was seen last", () => {
  const proxied = "/_ipx/f_webp&s_800x600/https://storage.etreproprio.com/classified/image/thumb/b/m/d/c59156ce_ptw0.jpeg";
  const issues = contractIssues(
    property({
      imageUrls: ["https://img.example/a.jpg", proxied],
      listings: [listing({ source: "etreproprio", via: null, lastSeenAt: "2026-10-30T00:00:00.000Z" }), listing({ lastSeenAt: "2026-11-02T00:00:00.000Z" })],
    }),
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, "photos");
  assert.equal(issues[0].action, "dropped");
  assert.equal(issues[0].reportedAs, "seloger");
  assert.equal(issues[0].bad, proxied);
});

test("a cover not on https is repaired when the gallery has one, dropped when it has none", () => {
  const repaired = contractIssues(property({ imageUrl: "http://x/a.jpg", imageUrls: ["http://x/a.jpg", "https://x/b.jpg"] }));
  assert.equal(repaired.find((i) => i.field === "cover")?.action, "repaired");
  const dropped = contractIssues(property({ imageUrl: "http://x/a.jpg", imageUrls: ["http://x/a.jpg"] }));
  assert.equal(dropped.find((i) => i.field === "cover")?.action, "dropped");
});

test("impossible figures are refused; a missing one is not this contract's business", () => {
  assert.equal(contractIssues(property({ priceEur: 500 }))[0].field, "price");
  assert.equal(contractIssues(property({ areaM2: 3 }))[0].field, "area");
  assert.deepEqual(contractIssues(property({ priceEur: null, areaM2: null })), []);
  const l = contractIssues(property({ listings: [listing({ priceEur: 900_000_000 })] }));
  assert.deepEqual(l.map((i) => [i.field, i.reportedAs]), [["listing.price", "seloger"]]);
});

test("square feet stored as square metres, on the listing and on the property", () => {
  assert.equal(sqftAsM2(1324, [{ label: "Surface", value: "1 324 sq ft" }]), true);
  assert.equal(sqftAsM2(123, [{ label: "Surface", value: "1 324 sq ft" }]), false);
  assert.equal(sqftAsM2(null, [{ label: "Surface", value: "1 324 sq ft" }]), false);
  const issues = contractIssues(property({ areaM2: 1324, listings: [listing({ areaM2: 1324, characteristics: [{ label: "Surface", value: "1 324 sq ft" }] })] }));
  assert.deepEqual(issues.map((i) => i.field).sort(), ["area", "listing.area"]);
  assert.ok(issues.every((i) => i.action === "repaired"));
});

test("garbled text is mended character by character, the rest untouched", () => {
  assert.equal(repairMojibake("SAINT-TROPEZ â€“ AU CÅ’UR"), "SAINT-TROPEZ – AU CŒUR");
  assert.equal(repairMojibake("DÃ©couvrez cette villa Ã  Gassin"), "Découvrez cette villa à Gassin");
  assert.equal(repairMojibake("Déjà une villa"), "Déjà une villa");
  assert.equal(hasMojibake("Déjà une villa"), false);
  assert.equal(hasMojibake("DÃ©couvrez"), true);
  assert.equal(contractIssues(property({ title: "DÃ©couvrez" }))[0].action, "repaired");
});

test("text that stays garbled after the repair is flagged, and is the client's count of garbled text", () => {
  const stuck = "â€ orphan";
  assert.equal(unrepairable(stuck), true);
  assert.equal(unrepairable("DÃ©couvrez"), false);
  assert.equal(unrepairable(null), false);
  assert.equal(contractIssues(property({ description: stuck }))[0].action, "flagged");
});

test("the lead source is the listing seen most recently, the first on a tie", () => {
  assert.equal(leadSource([listing({ source: "a", lastSeenAt: "2026-10-01" }), listing({ source: "b", lastSeenAt: "2026-11-01" })]), "b");
  assert.equal(leadSource([listing({ source: "a" }), listing({ source: "b" })]), "a");
  assert.equal(leadSource([]), null);
});

test("bedrooms read off the portal's own label", () => {
  assert.equal(bedroomsFromLabels([listing({ characteristics: [{ label: "Chambres", value: "4 chambres" }] })]), 4);
  assert.equal(bedroomsFromLabels([listing({ characteristics: [{ label: "bedrooms", value: "Studio" }] })]), 1);
  assert.equal(bedroomsFromLabels([listing({ characteristics: [{ label: "Pièces", value: "5" }] })]), null);
});
