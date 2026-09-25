import { test } from "node:test";
import assert from "node:assert/strict";
import { grade } from "./nightlyGrade";
import type { RunSummary } from "./runner/run";

/**
 * The grade is what a person reads at 8am, and it is what turns a night red.
 * Both bugs found in one week were here, in opposite directions — so every
 * case below is a night that actually happened, graded the way it should have
 * been.
 */

/** A clean, complete pass — the baseline every other case is a deviation from. */
function clean(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "r",
    status: "done",
    discovered: 2711,
    added: 78,
    refreshed: 17,
    delisted: 74,
    failed: 0,
    ingested: 95,
    communesVisited: 12,
    communesIncomplete: 0,
    ...over,
  };
}

test("a clean night is ok", () => {
  assert.deepEqual(grade(clean()), { grade: "ok", note: "" });
});

test("refused at the door with no baseline is FAIL, not ok", () => {
  /**
   * JamesEdition, 2026-09-15, from a GitHub runner: Cloudflare 403 on page one
   * of its first and only commune. Zero discovered against a baseline of zero
   * — the abort guard is silent — one commune incomplete. It reached the
   * summary as `ok` and the night said "all clear".
   */
  const g = grade(clean({ discovered: 0, added: 0, refreshed: 0, delisted: 0, ingested: 0,
    communesVisited: 1, communesIncomplete: 1 }));
  assert.equal(g.grade, "fail");
  assert.match(g.note, /reached nothing/);
  assert.match(g.note, /1 of 1 communes/);
});

test("every commune shut across a full pass is FAIL", () => {
  const g = grade(clean({ discovered: 0, added: 0, refreshed: 0, ingested: 0,
    communesVisited: 12, communesIncomplete: 12 }));
  assert.equal(g.grade, "fail");
  assert.match(g.note, /12 of 12/);
});

test("a genuinely empty market — nothing found, every commune walked to the end — is not a failure", () => {
  /**
   * The rule must distinguish "found nothing because shut out" from "found
   * nothing because there is nothing". Zero incomplete communes means the
   * lists were walked to their ends and were empty. That is data, not a fault.
   */
  const g = grade(clean({ discovered: 0, added: 0, refreshed: 0, ingested: 0,
    communesVisited: 3, communesIncomplete: 0 }));
  assert.equal(g.grade, "ok");
});

test("a complete discovery with a truncated fetch is WARN, not error", () => {
  /**
   * Figaro, 2026-09-16, from home: all twelve communes discovered (2142), 607
   * pages stored, 132 delisted correctly, then Cloudflare closed the session.
   * The market picture is right; only freshness is short. It reached the
   * client dashboard as "error" until `partial` existed.
   */
  const g = grade(clean({ status: "partial", discovered: 2142, added: 532, refreshed: 387,
    ingested: 607, delisted: 132, fetchStoppedEarly: "refused 3 times in a row after 607 served" }));
  assert.equal(g.grade, "warn");
  assert.match(g.note, /607 served/);
});

test("a truncated fetch on an INCOMPLETE discovery stays FAIL", () => {
  /**
   * Superimmo, 2026-09-16: one of three communes never yielded its first index
   * page, then the fetch budget ran out. The market picture has a hole; this
   * is not `partial` and must not be softened to a warning.
   */
  const g = grade(clean({ status: "done", discovered: 165, communesVisited: 3,
    communesIncomplete: 1, fetchStoppedEarly: "the 40-minute fetch budget was spent" }));
  assert.equal(g.grade, "fail");
});

test("aborted and error are always FAIL", () => {
  assert.equal(grade(clean({ status: "aborted", abortedReason: "blocked crawl" })).grade, "fail");
  assert.equal(grade(clean({ status: "error", error: "threw" })).grade, "fail");
});

test("a switched-off source is a WARN with a plain reason", () => {
  const g = grade(clean({ status: "disabled" }));
  assert.equal(g.grade, "warn");
  assert.match(g.note, /switched off/);
});

test("individual failed listings warn with the ratio, never fail on count alone", () => {
  /**
   * LuxuryEstate, 2026-08-31: 43 refused of 1688 and it was a good run.
   * Failures are shown with their ratio so a person can judge.
   */
  const g = grade(clean({ failed: 43, added: 1645, refreshed: 43 }));
  assert.equal(g.grade, "warn");
  assert.match(g.note, /43 of 1688/);
});

test("the shut-door rule does not fire when the counts are simply absent", () => {
  /**
   * Older summaries — and the aborted/disabled paths — carry no commune
   * counts. Absent counts must read as "unknown", never as "shut".
   */
  const g = grade(clean({ discovered: 0, added: 0, refreshed: 0, ingested: 0,
    communesVisited: undefined, communesIncomplete: undefined }));
  assert.equal(g.grade, "ok");
});
