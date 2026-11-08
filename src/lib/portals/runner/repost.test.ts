import { test } from "node:test";
import assert from "node:assert/strict";
import { REPOST_WINDOW_DAYS, repostIdentity } from "./repost";

// One of BONAPARTE PROMOTION TOULON's lots, as Bien'ici re-issued it on 2026-11-08 (its eighth id since 1 Oct).
const lot = {
  agencyId: "0b0e6f4e-0000-0000-0000-000000000001",
  title: "L’ART DE VIVRE TROPEZIEN AVEC JARDIN & TERRASSES X",
  priceEur: 2_450_000,
  areaM2: "101",
  communeInsee: "83119",
};

test("a repost is recognised by agency, title, price, area and commune", () => {
  assert.deepEqual(repostIdentity(lot), lot);
  assert.deepEqual(repostIdentity({ ...lot, areaM2: null, communeInsee: null }), { ...lot, areaM2: null, communeInsee: null });
});

test("without the agency, the title or the price there is no repost to find, only a guess", () => {
  assert.equal(repostIdentity({ ...lot, agencyId: null }), null);
  assert.equal(repostIdentity({ ...lot, title: null }), null);
  assert.equal(repostIdentity({ ...lot, title: "   " }), null);
  assert.equal(repostIdentity({ ...lot, priceEur: null }), null);
});

test("the window covers the cadence seen: reposts every two to five days, at most eight days apart", () => {
  assert.ok(REPOST_WINDOW_DAYS >= 8 && REPOST_WINDOW_DAYS <= 31);
});
