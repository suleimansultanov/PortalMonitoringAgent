import { test } from "node:test";
import assert from "node:assert/strict";
import { diffListings, shouldAbort } from "./diff";

test("splits discovered ids into added and present", () => {
  const r = diffListings({ known: ["a", "b"], discovered: ["b", "c"], complete: true });
  assert.deepEqual(r.added, ["c"]);
  assert.deepEqual(r.present, ["b"]);
  assert.deepEqual(r.removed, ["a"]);
});

test("an interrupted crawl adds but never removes", () => {
  const r = diffListings({ known: ["a", "b", "c"], discovered: ["a", "d"], complete: false });
  assert.deepEqual(r.added, ["d"]);
  assert.deepEqual(r.removed, [], "nothing may be delisted on a partial crawl");
  assert.deepEqual(r.suppressedRemovals.sort(), ["b", "c"]);
});

test("stale entries are queued for refresh, not treated as new", () => {
  const r = diffListings({
    known: ["a", "b"],
    discovered: ["a", "b"],
    stale: ["b"],
    complete: true,
  });
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.refresh, ["b"]);
});

test("first run: everything is an addition, nothing is removed", () => {
  const r = diffListings({ known: [], discovered: ["a", "b"], complete: true });
  assert.deepEqual(r.added.sort(), ["a", "b"]);
  assert.deepEqual(r.removed, []);
});

test("a source that genuinely emptied is still reported when the crawl finished", () => {
  const r = diffListings({ known: ["a", "b"], discovered: [], complete: true });
  assert.deepEqual(r.removed.sort(), ["a", "b"]);
});

// ── the abort guard ────────────────────────────────────────────────────────

test("a collapse against a real baseline aborts", () => {
  const v = shouldAbort({ discovered: 40, baseline: 400, threshold: 0.5 });
  assert.equal(v.abort, true);
  assert.match(v.reason ?? "", /blocked crawl/);
});

test("a normal day passes", () => {
  assert.equal(shouldAbort({ discovered: 380, baseline: 400, threshold: 0.5 }).abort, false);
});

test("first run is never aborted — there is nothing to protect", () => {
  assert.equal(shouldAbort({ discovered: 0, baseline: 0, threshold: 0.5 }).abort, false);
});

test("small baselines are left alone: 6 to 2 in a quiet commune is ordinary", () => {
  assert.equal(shouldAbort({ discovered: 2, baseline: 6, threshold: 0.5 }).abort, false);
});

test("the same ratio at scale is not ordinary", () => {
  assert.equal(shouldAbort({ discovered: 200, baseline: 600, threshold: 0.5 }).abort, true);
});

test("growth never trips the guard", () => {
  assert.equal(shouldAbort({ discovered: 5000, baseline: 400, threshold: 0.5 }).abort, false);
});

test("exactly at the threshold is allowed through", () => {
  assert.equal(shouldAbort({ discovered: 200, baseline: 400, threshold: 0.5 }).abort, false);
});
