import { test } from "node:test";
import assert from "node:assert/strict";
import { communeSliceForDay } from "./communes";

/**
 * The rotation, tested for the one property that matters: over a full cycle
 * every commune comes round, and none comes round twice.
 *
 * A rotation that sticks is invisible. It produces a fast, green, successful
 * night — the same three communes collected, the other eight quietly frozen —
 * and nothing in the output asks to be looked at. Superimmo spent 2026-09-06
 * demonstrating the neighbouring version of exactly that.
 */

const ELEVEN = [
  "83119", "83101", "83065", "83068", "83042", "83115",
  "83048", "83036", "83079", "83063", "83094",
];

test("every commune comes round exactly once per cycle", () => {
  const perNight = 3;
  const slices = Math.ceil(ELEVEN.length / perNight); // 4
  const seen = new Map<string, number>();

  for (let day = 1; day <= slices; day++) {
    for (const c of communeSliceForDay(ELEVEN, perNight, day)) {
      seen.set(c, (seen.get(c) ?? 0) + 1);
    }
  }

  assert.equal(seen.size, ELEVEN.length, `missed: ${ELEVEN.filter((c) => !seen.has(c))}`);
  for (const [commune, times] of seen) {
    assert.equal(times, 1, `${commune} came round ${times} times in one cycle`);
  }
});

test("it keeps covering everything over many cycles", () => {
  const counts = new Map<string, number>();
  for (let day = 1; day <= 4 * 10; day++) {
    for (const c of communeSliceForDay(ELEVEN, 3, day)) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  assert.equal(counts.size, ELEVEN.length);
  // Ten cycles, so every commune ten times — nothing starved, nothing favoured.
  for (const [commune, times] of counts) assert.equal(times, 10, `${commune}: ${times}`);
});

test("the order does not depend on how the communes arrived", () => {
  // Subscriptions come back in whatever order the rows do. A rotation over an
  // unstable order revisits some communes twice a cycle and others never.
  const shuffled = [...ELEVEN].reverse();
  for (let day = 1; day <= 8; day++) {
    assert.deepEqual(
      communeSliceForDay(ELEVEN, 3, day),
      communeSliceForDay(shuffled, 3, day),
      `day ${day} differed`,
    );
  }
});

test("a list that fits in one night is never split", () => {
  assert.deepEqual(communeSliceForDay(["83119", "83101"], 3, 7), ["83119", "83101"]);
  assert.deepEqual(communeSliceForDay(ELEVEN, 0, 7), ELEVEN);
  assert.deepEqual(communeSliceForDay([], 3, 7), []);
});
