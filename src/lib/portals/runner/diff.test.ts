import { test } from "node:test";
import assert from "node:assert/strict";
import { diffListings, shouldAbort, needsRefresh } from "./diff";

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

/* ── The refresh skip ─────────────────────────────────────────────────────

   Guarding a saving, so every test here is really asking "does this fetch a
   page it should have fetched?" — the failure that matters is the one that
   leaves a stale price on a client's screen, not the one that costs a request.
*/

const DAY = 86_400_000;
const now = new Date("2026-09-16T12:00:00Z");
const ceiling = new Date(now.getTime() - 30 * DAY);
const fetchedRecently = new Date(now.getTime() - 8 * DAY);

test("a listing the portal says is unchanged is not fetched again", () => {
  const stored = new Date("2026-08-01T00:00:00Z");
  assert.equal(
    needsRefresh(
      { externalId: "1", fetchedAt: fetchedRecently, storedSourceUpdatedAt: stored },
      new Date("2026-08-01T00:00:00Z"),
      ceiling,
    ),
    false,
  );
});

test("a newer date from the portal means the page changed", () => {
  assert.equal(
    needsRefresh(
      {
        externalId: "1",
        fetchedAt: fetchedRecently,
        storedSourceUpdatedAt: new Date("2026-08-01T00:00:00Z"),
      },
      new Date("2026-09-14T00:00:00Z"),
      ceiling,
    ),
    true,
  );
});

test("a missing date on either side is never read as freshness", () => {
  const stored = new Date("2026-08-01T00:00:00Z");
  // The portal said nothing — most sources publish no dates at all, and they
  // must behave exactly as they did before this existed.
  assert.equal(
    needsRefresh(
      { externalId: "1", fetchedAt: fetchedRecently, storedSourceUpdatedAt: stored },
      null,
      ceiling,
    ),
    true,
  );
  // We hold no date to compare against.
  assert.equal(
    needsRefresh(
      { externalId: "1", fetchedAt: fetchedRecently, storedSourceUpdatedAt: null },
      stored,
      ceiling,
    ),
    true,
  );
});

test("a listing this pass never saw is not skipped on the strength of that", () => {
  /**
   * `undefined` is discovery not having reached it — a delta stop, a commune
   * cut short, a page that failed. Absence from a pass says nothing about
   * whether the listing changed, and reading it as "unchanged" would let one
   * truncated night freeze a commune's prices.
   */
  assert.equal(
    needsRefresh(
      {
        externalId: "1",
        fetchedAt: fetchedRecently,
        storedSourceUpdatedAt: new Date("2026-08-01T00:00:00Z"),
      },
      undefined,
      ceiling,
    ),
    true,
  );
});

test("past the ceiling the page is read again whatever the portal claims", () => {
  /**
   * The bound on trusting somebody else's timestamp. A portal that never
   * touches the field when a price changes would otherwise freeze that price in
   * our data permanently — and price history is the product.
   */
  const stale = new Date(now.getTime() - 40 * DAY);
  assert.equal(
    needsRefresh(
      {
        externalId: "1",
        fetchedAt: stale,
        storedSourceUpdatedAt: new Date("2026-08-01T00:00:00Z"),
      },
      new Date("2026-08-01T00:00:00Z"),
      ceiling,
    ),
    true,
  );
});

test("a listing we have never fetched is always fetched", () => {
  assert.equal(
    needsRefresh({ externalId: "1", fetchedAt: null, storedSourceUpdatedAt: null }, null, ceiling),
    true,
  );
});
