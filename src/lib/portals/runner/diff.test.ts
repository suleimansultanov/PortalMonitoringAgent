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

/**
 * Per-commune shielding. The scenario these describe is the one that cost a
 * real run elsewhere in this pipeline: discovery stops early, the short list
 * looks exactly like a market emptying out, and the delistings are written.
 */

test("a listing in an unfinished commune is spared, not delisted", () => {
  const r = diffListings({
    known: ["a", "b", "c"],
    discovered: ["a"],
    complete: true,
    incomplete: ["b"],
  });
  assert.deepEqual(r.removed, ["c"]);
  assert.deepEqual(r.suppressedRemovals, ["b"]);
});

test("shielding one commune does not shield the rest", () => {
  // The whole point of doing this per commune: Ramatuelle still delists while
  // Grimaud is being protected. Otherwise one flaky page freezes the portal.
  const r = diffListings({
    known: ["grimaud-1", "ramatuelle-1"],
    discovered: [],
    complete: true,
    incomplete: ["grimaud-1"],
  });
  assert.deepEqual(r.removed, ["ramatuelle-1"]);
  assert.deepEqual(r.suppressedRemovals, ["grimaud-1"]);
});

test("an incomplete pass still shields everything, shielded list or not", () => {
  const r = diffListings({
    known: ["a", "b"],
    discovered: [],
    complete: false,
    incomplete: ["a"],
  });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.suppressedRemovals, ["a", "b"]);
});

test("shielding never suppresses an addition — what we saw is certainly there", () => {
  const r = diffListings({
    known: ["a"],
    discovered: ["a", "new"],
    complete: true,
    incomplete: ["a"],
  });
  assert.deepEqual(r.added, ["new"]);
});

test("omitting the shield list leaves the old behaviour exactly as it was", () => {
  const r = diffListings({ known: ["a", "b"], discovered: ["a"], complete: true });
  assert.deepEqual(r.removed, ["b"]);
  assert.deepEqual(r.suppressedRemovals, []);
});
