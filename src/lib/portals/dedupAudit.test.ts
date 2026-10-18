import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDuplicates, type AuditListing, type AuditProperty } from "./dedupAudit";

/**
 * The audit is measured with the matcher's own rules, so every case here is a
 * pair the rules decide one way — and the audit has to agree with them.
 */

const VILLA = `Dans le secteur prisé de La Quessine, superbe bastide provençale nichée au cœur d'un parc paysager. En position dominante, elle offre une vue imprenable sur la mer, le Cap Taillat et la campagne environnante. La maison principale comprend un vaste salon, une cuisine, une salle à manger, le tout ouvert sur de grandes terrasses panoramiques.`;

function prop(over: Partial<AuditProperty> & { id: string }): AuditProperty {
  return {
    communeInsee: "83048",
    priceEur: 4_490_000,
    areaM2: 179,
    landM2: 1423,
    rooms: 6,
    bedrooms: 4,
    propertyType: "Maison",
    agencyId: null,
    agencyName: null,
    agencyRef: null,
    title: "Villa",
    description: VILLA,
    ...over,
  };
}

test("the client's villa, still two cards: same price, same plot, 179 against 210 m² — a twin by size", () => {
  const r = auditDuplicates({
    properties: [
      prop({ id: "ours", agencyName: "Med-Estates", description: VILLA }),
      prop({ id: "theirs", areaM2: 210, agencyName: "John Taylor", description: "Propriété de 4 chambres, domaine privé, vue mer." }),
    ],
    listings: [],
  });
  assert.equal(r.twins.length, 1);
  assert.equal(r.twins[0].by, "size");
  assert.equal(r.twins[0].wouldMerge, null, "no replay supplied");
});

test("the same agency's mandate on two properties is a twin whatever the prices say", () => {
  const r = auditDuplicates({
    properties: [
      prop({ id: "a", agencyId: "swixim", agencyRef: "70880", priceEur: 1_200_000, description: "x" }),
      prop({ id: "b", agencyId: "swixim", agencyRef: "70880", priceEur: 1_150_000, areaM2: 150, landM2: null, description: "y" }),
    ],
    listings: [],
  });
  assert.equal(r.twins.length, 1);
  assert.equal(r.twins[0].by, "mandate");
});

test("two flats at one price five per cent apart in size are two flats, not a twin", () => {
  const r = auditDuplicates({
    properties: [
      prop({ id: "a", propertyType: "Appartement", areaM2: 50, landM2: null, priceEur: 389_000, description: "x" }),
      prop({ id: "b", propertyType: "Appartement", areaM2: 55, landM2: null, priceEur: 389_000, description: "y" }),
    ],
    listings: [],
  });
  assert.equal(r.twins.length, 0);
});

test("properties in two communes are never compared", () => {
  const r = auditDuplicates({
    properties: [prop({ id: "a", communeInsee: "83048" }), prop({ id: "b", communeInsee: "83119" })],
    listings: [],
  });
  assert.equal(r.twins.length, 0);
});

test("a twin whose listings the replayed resolve puts in one group is an anomaly; one it splits is the guard's decision", () => {
  const listings: AuditListing[] = [
    { id: "la", propertyId: "a", source: "vizzit", priceEur: 4_490_000, areaM2: 200, landM2: null, propertyType: "Maison" },
    { id: "lb", propertyId: "b", source: "bienici", priceEur: 4_490_000, areaM2: 230, landM2: null, propertyType: "Maison" },
    { id: "lc", propertyId: "c", source: "etreproprio", priceEur: 4_490_000, areaM2: 270, landM2: null, propertyType: "Maison" },
  ];
  const group: Record<string, string> = { la: "g1", lb: "g1", lc: "g2" };
  const r = auditDuplicates({
    properties: [
      prop({ id: "a", areaM2: 200, landM2: null, description: "x" }),
      prop({ id: "b", areaM2: 230, landM2: null, description: "y" }),
      prop({ id: "c", areaM2: 270, landM2: null, description: "z" }),
    ],
    listings,
    groupOf: (id) => group[id],
  });
  const pairs = r.twins.map((t) => `${t.a.id}${t.b.id}:${t.wouldMerge ? "anomaly" : "guard"}`).sort();
  assert.deepEqual(pairs, ["ab:anomaly", "bc:guard"], "a–b and b–c score; a–c does not");
});

test("without a replay the question is left open, not answered", () => {
  const r = auditDuplicates({
    properties: [prop({ id: "a" }), prop({ id: "b", areaM2: 210, description: "other words entirely here" })],
    listings: [],
  });
  assert.equal(r.twins.length, 1);
  assert.equal(r.twins[0].wouldMerge, null);
});

test("a property whose listings disagree on price by more than the guard allows is welded", () => {
  const listings: AuditListing[] = [
    { id: "p1", propertyId: "p", source: "vizzit", priceEur: 1_000_000, areaM2: 200, landM2: null, propertyType: "Maison" },
    { id: "p2", propertyId: "p", source: "bienici", priceEur: 1_800_000, areaM2: 200, landM2: null, propertyType: "Maison" },
    { id: "q1", propertyId: "q", source: "vizzit", priceEur: 1_000_000, areaM2: 200, landM2: null, propertyType: "Maison" },
    { id: "q2", propertyId: "q", source: "bienici", priceEur: 1_000_000, areaM2: 205, landM2: null, propertyType: "Maison" },
    { id: "r1", propertyId: "r", source: "vizzit", priceEur: 2_000_000, areaM2: 300, landM2: 1000, propertyType: "Maison" },
    { id: "r2", propertyId: "r", source: "bienici", priceEur: 2_000_000, areaM2: 400, landM2: 1000, propertyType: "Maison" },
  ];
  const r = auditDuplicates({
    properties: [prop({ id: "p", priceEur: 1_000_000 }), prop({ id: "q", priceEur: 1_000_000, communeInsee: "83119" }), prop({ id: "r", priceEur: 2_000_000, communeInsee: "83068" })],
    listings,
  });
  assert.deepEqual(r.welded.map((w) => [w.property.id, w.on]), [["p", "price"], ["r", "area"]]);
});
