import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJsonLd,
  firstOffer,
  nodesOfType,
  num,
  primaryOfferNode,
  readAddress,
  str,
  typesOf,
} from "./jsonld";

const page = (...blocks: string[]) =>
  `<html><head>${blocks.map((b) => `<script type="application/ld+json">${b}</script>`).join("")}</head><body></body></html>`;

// ── num() ────────────────────────────────────────────────────────────────────

test("English thousands are thousands: '9,500,000' was null and '2,666' was 2.666 until 2026-10-15", () => {
  assert.equal(num("9,500,000"), 9_500_000);
  assert.equal(num("2,666"), 2_666);
  assert.equal(num("1,234,567"), 1_234_567);
  assert.equal(num("€9,500,000"), 9_500_000);
  assert.equal(num("2,666 sq ft"), 2_666);
});

test("English thousands with a decimal point keep both", () => {
  assert.equal(num("9,500,000.00"), 9_500_000);
  assert.equal(num("1,234.5"), 1_234.5);
});

test("the French decimal comma stays decimal", () => {
  assert.equal(num("12,5"), 12.5);
  assert.equal(num("240,62 m²"), 240.62);
  assert.equal(num("1,1 ha"), 1.1);
  assert.equal(num("2,47 acres"), 2.47);
  // A leading zero cannot open a thousands group: this is half of something.
  assert.equal(num("0,500"), 0.5);
});

test("spaces of every width are thousands separators", () => {
  assert.equal(num("1 900 000 €"), 1_900_000);
  assert.equal(num("1 900 000 €"), 1_900_000); // non-breaking
  assert.equal(num("1 900 000 €"), 1_900_000); // narrow non-breaking, as French locales print it
  assert.equal(num("1 900 000"), 1_900_000); // thin
  assert.equal(num("2 067 sq ft"), 2_067);
  assert.equal(num("1 900 000,50 €"), 1_900_000.5);
});

test("dots that group thousands are grouping; a lone dot is a decimal point", () => {
  assert.equal(num("1.900.000"), 1_900_000);
  assert.equal(num("1.900.000,50"), 1_900_000.5);
  assert.equal(num("1.900,50"), 1_900.5);
  assert.equal(num("1.900"), 1.9);
  assert.equal(num("19600000.0"), 19_600_000);
});

test("markup numbers pass through; prices as strings come out as numbers", () => {
  assert.equal(num(19_600_000), 19_600_000);
  assert.equal(num("19600000"), 19_600_000);
  assert.equal(num(0), 0);
  assert.equal(num("-3"), -3);
});

test("nothing numeric is null, never zero", () => {
  assert.equal(num(""), null);
  assert.equal(num("Prix sur demande"), null);
  assert.equal(num(","), null);
  assert.equal(num("."), null);
  assert.equal(num("-"), null);
  assert.equal(num(NaN), null);
  assert.equal(num(Infinity), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num({ value: 5 }), null);
});

// ── str() ────────────────────────────────────────────────────────────────────

test("str trims, treats blank as absent, and reads numbers as text", () => {
  assert.equal(str("  Saint-Tropez "), "Saint-Tropez");
  assert.equal(str("   "), null);
  assert.equal(str(83990), "83990");
  assert.equal(str(null), null);
  assert.equal(str({}), null);
});

// ── extractJsonLd() ──────────────────────────────────────────────────────────

test("one script per node, an array, and @graph all flatten to the same list", () => {
  const product = { "@type": "Product", name: "Villa" };
  const agent = { "@type": "RealEstateAgent", name: "Agence" };
  const separate = extractJsonLd(page(JSON.stringify(product), JSON.stringify(agent)));
  const array = extractJsonLd(page(JSON.stringify([product, agent])));
  const graph = extractJsonLd(page(JSON.stringify({ "@context": "https://schema.org", "@graph": [product, agent] })));
  for (const nodes of [separate, array, graph]) {
    assert.deepEqual(
      nodes.map((n) => n["@type"]),
      ["Product", "RealEstateAgent"],
    );
  }
});

test("a malformed block is skipped, not fatal: the useful one is usually another block", () => {
  const nodes = extractJsonLd(page("{ not json", JSON.stringify({ "@type": "Product", name: "Villa" }), ""));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Villa");
});

test("SMC's agency, buried in ItemList → itemListElement → item, is reached", () => {
  const nodes = extractJsonLd(
    page(
      JSON.stringify({
        "@type": "ItemList",
        itemListElement: [{ "@type": "ListItem", item: { "@type": "RealEstateAgent", telephone: "04 94 00 00 00" } }],
      }),
    ),
  );
  const agent = nodesOfType(nodes, "RealEstateAgent")[0];
  assert.equal(agent?.telephone, "04 94 00 00 00");
  // The wrapper is kept too: it may carry a count somebody wants.
  assert.equal(nodesOfType(nodes, "ItemList").length, 1);
});

// ── types and the primary node ───────────────────────────────────────────────

test("@type as a string or an array, matched without regard to case", () => {
  const node = { "@type": ["Product", "SingleFamilyResidence"] };
  assert.deepEqual([...typesOf(node)], ["product", "singlefamilyresidence"]);
  assert.equal(nodesOfType([node, { "@type": "Offer" }], "product").length, 1);
  assert.deepEqual([...typesOf({})], []);
});

test("anonymous House blocks are the similar-listings widget, never the listing (JamesEdition)", () => {
  const phantoms = Array.from({ length: 10 }, (_, i) => ({ "@type": "House", numberOfBedrooms: i + 2 }));
  assert.equal(primaryOfferNode(phantoms), null);

  const real = { "@type": "Product", offers: { "@type": "Offer", price: "4500000", priceCurrency: "EUR" } };
  assert.equal(primaryOfferNode([...phantoms, real]), real);

  // A node with a URL but no offer is identified; one with an offer still wins.
  const linked = { "@type": "Residence", url: "https://example.org/villa" };
  assert.equal(primaryOfferNode([...phantoms, linked]), linked);
  assert.equal(primaryOfferNode([linked, real]), real);
});

test("offers may be one object or an array of them", () => {
  const offer = { "@type": "Offer", price: "100" };
  assert.equal(firstOffer({ offers: offer }), offer);
  assert.equal(firstOffer({ offers: [null, offer] }), offer);
  assert.equal(firstOffer({ offers: "100" }), null);
  assert.equal(firstOffer({}), null);
});

// ── readAddress() ────────────────────────────────────────────────────────────

test("a PostalAddress object is read field by field", () => {
  assert.deepEqual(
    readAddress({ streetAddress: "1 rue Allard", postalCode: "83990", addressLocality: "Saint-Tropez" }),
    { full: "1 rue Allard, 83990, Saint-Tropez", street: "1 rue Allard", locality: "Saint-Tropez", postalCode: "83990" },
  );
});

test("an address in prose still yields its postcode — agency identity depends on it", () => {
  assert.deepEqual(readAddress("12 avenue du Général Leclerc, 83990 Saint-Tropez"), {
    full: "12 avenue du Général Leclerc, 83990 Saint-Tropez",
    street: "12 avenue du Général Leclerc",
    locality: "Saint-Tropez",
    postalCode: "83990",
  });
  // No five-digit run, no postcode: a house number is not one.
  assert.equal(readAddress("12 avenue Foch, Saint-Tropez").postalCode, null);
  assert.equal(readAddress("  ").full, null);
  assert.equal(readAddress(null).full, null);
});
