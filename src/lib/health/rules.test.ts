import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, median, priceJump, share, threshold, volume, worst } from "./rules";

/**
 * The sentences are asserted word for word on purpose. They are copied from the
 * client's Data health screen of 2026-11-03: a copy that says something else, or
 * draws its line elsewhere, cannot be checked against the original.
 */

test("a volume far below its median: the client's Etreproprio row", () => {
  const v = volume(9, [23, 31, 30, 15, 13, 34, 23]);
  assert.equal(v.status, "red");
  assert.equal(v.message, "9 a night, 61 % below the usual 23.");
  assert.equal(v.expected, "about 23 a night (median of the last 7 days); red below 13.8");
});

test("a volume a third down is amber, and a small source is not judged on a drop", () => {
  assert.equal(volume(4, [6, 6, 6, 6, 6, 6, 6]).status, "amber");
  assert.equal(volume(1, [4, 4, 4, 4]).status, "green");
  assert.equal(volume(0, [4, 4, 4, 4]).status, "amber");
  assert.equal(volume(0, [20, 20, 20]).status, "red");
  assert.equal(volume(5, [20, 20]).status, "unknown");
});

test("a share against the source's own baseline: the client's Bien'ici row", () => {
  const v = share(41, 86, 0.099, "without bedrooms");
  assert.equal(v.status, "red");
  assert.equal(v.message, "41 of 86 without bedrooms (47.7 %).");
  assert.equal(v.expected, "about 9.9 % (this source's usual); red above 34.9 %");
});

test("a share is amber ten points above its baseline, and too few records are not judged", () => {
  assert.equal(share(8, 35, 0.067, "without bedrooms").status, "amber");
  assert.equal(share(4, 13, 0.112, "without an area").status, "amber");
  assert.equal(share(2, 13, 0.112, "without an area").status, "green");
  assert.equal(share(5, 9, 0, "without a price").status, "unknown");
  assert.match(share(9, 20, null).expected, /no baseline/);
});

test("a count of anomalies", () => {
  assert.equal(threshold(0, { amber: 1, red: 50, what: "x" }).status, "green");
  assert.equal(threshold(49, { amber: 1, red: 50, what: "x" }).status, "amber");
  const v = threshold(50, { amber: 1, red: 50, what: "values" });
  assert.equal(v.status, "red");
  assert.equal(v.expected, "none; red from 50");
});

test("freshness in minutes, and never is red", () => {
  assert.equal(fresh(60, 26 * 60, 30 * 60, "Run").status, "green");
  assert.equal(fresh(28 * 60, 26 * 60, 30 * 60, "Run").status, "amber");
  assert.equal(fresh(31 * 60, 26 * 60, 30 * 60, "Run").status, "red");
  assert.equal(fresh(null, 26 * 60, 30 * 60, "Run").status, "red");
});

test("a price move of five times, either way", () => {
  assert.equal(priceJump(100_000, 500_000), true);
  assert.equal(priceJump(500_000, 100_000), true);
  assert.equal(priceJump(100_000, 400_000), false);
  assert.equal(priceJump(null, 100_000), false);
});

test("median and worst", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(worst(["green", "red", "amber"]), "red");
  assert.equal(worst([]), "unknown");
});
