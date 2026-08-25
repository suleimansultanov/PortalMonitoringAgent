import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEvents, mergeParsed, type ListingState } from "./events";

const state = (p: Partial<ListingState>): ListingState => ({
  priceEur: null,
  areaM2: null,
  rooms: null,
  availability: null,
  status: "active",
  ...p,
});

test("a listing seen for the first time produces one event", () => {
  const ev = computeEvents(null, state({ priceEur: 9_500_000 }));
  assert.deepEqual(ev.map((e) => e.type), ["listed"]);
  assert.equal(ev[0].priceTo, 9_500_000);
});

test("a price cut records delta, percent and direction", () => {
  const ev = computeEvents(state({ priceEur: 9_500_000 }), state({ priceEur: 8_900_000 }));
  assert.equal(ev[0].type, "price_changed");
  assert.deepEqual(ev[0].payload, { delta: -600_000, percent: -6.32, direction: "down" });
});

test("an unchanged listing produces nothing", () => {
  assert.equal(computeEvents(state({ priceEur: 9_500_000 }), state({ priceEur: 9_500_000 })).length, 0);
});

/**
 * The two that matter most. A parser that breaks keeps returning rows — with
 * holes. If a hole counted as a change we would write hundreds of false price
 * events into an append-only log with no clean way back.
 */
test("a null from a degraded parse is not a price change", () => {
  assert.equal(computeEvents(state({ priceEur: 9_500_000 }), state({ priceEur: null })).length, 0);
});

test("a price becoming known for the first time is not a price change either", () => {
  assert.equal(computeEvents(state({ priceEur: null }), state({ priceEur: 9_500_000 })).length, 0);
});

test("delisting is terminal for the pass and remembers the last price", () => {
  const ev = computeEvents(
    state({ priceEur: 9_500_000, status: "active" }),
    state({ priceEur: 9_500_000, status: "delisted" }),
  );
  assert.equal(ev.length, 1, "nothing else is worth saying about a listing that vanished");
  assert.equal(ev[0].type, "delisted");
  assert.equal(ev[0].priceFrom, 9_500_000);
});

test("a listing that comes back is relisted, not listed", () => {
  const ev = computeEvents(state({ status: "delisted" }), state({ priceEur: 8_000_000 }));
  assert.equal(ev[0].type, "relisted");
});

test("availability transitions are captured — the nearest thing to a sold signal", () => {
  const ev = computeEvents(state({ availability: "InStock" }), state({ availability: "SoldOut" }));
  assert.equal(ev[0].type, "availability_changed");
  assert.deepEqual(ev[0].payload, { from: "InStock", to: "SoldOut" });
});

test("a price cut alongside an agency edit yields two distinct events", () => {
  const ev = computeEvents(
    state({ priceEur: 1_000_000, areaM2: 100, rooms: 4 }),
    state({ priceEur: 900_000, areaM2: 120, rooms: 5 }),
  );
  assert.deepEqual(ev.map((e) => e.type), ["price_changed", "updated"]);
});

test("mergeParsed refuses to overwrite a known value with null", () => {
  assert.deepEqual(
    mergeParsed({ priceEur: 9_500_000, areaM2: 320 }, { priceEur: null, areaM2: 330 }),
    { areaM2: 330 },
  );
});

test("mergeParsed writes nothing when nothing differs", () => {
  assert.deepEqual(mergeParsed({ priceEur: 9_500_000 }, { priceEur: 9_500_000 }), {});
});
