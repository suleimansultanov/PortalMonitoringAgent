import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRetries, RETRY_LOOKBACK_HOURS, type RetryRun, type RetrySource } from "./retryRule";
import { insideCollectWindow } from "./runner/collectWindow";

const MORNING = new Date("2026-11-10T06:30:00Z");
const src = (key: string, extra: Partial<RetrySource> = {}): RetrySource => ({ key, enabled: true, config: {}, ...extra });
const run = (sourceKey: string, status: string, startedAt: string, mode = "scheduled"): RetryRun => ({
  sourceKey,
  status,
  mode,
  startedAt: new Date(startedAt),
});
const retried = (v: ReturnType<typeof pickRetries>) => v.filter((x) => x.retry).map((x) => x.key);

test("Vizzit, 2026-11-10: discovery returned 0 after a good night — retried once", () => {
  const v = pickRetries(
    [src("vizzit"), src("green-acres")],
    [
      run("vizzit", "done", "2026-11-09T00:38:00Z"),
      run("vizzit", "aborted", "2026-11-10T03:10:00Z"),
      run("green-acres", "done", "2026-11-09T01:04:00Z"),
      run("green-acres", "done", "2026-11-10T03:16:00Z"),
    ],
    MORNING,
  );
  assert.deepEqual(retried(v), ["vizzit"]);
  assert.equal(v.length, 1, "a source whose night went well is not mentioned");
});

test("two failures in a row are a person's call: the portal may be refusing us", () => {
  // JamesEdition from 16 September: 403, then 0 listings, night after night.
  const v = pickRetries(
    [src("jamesedition")],
    [run("jamesedition", "aborted", "2026-09-16T23:46:00Z"), run("jamesedition", "aborted", "2026-09-17T23:46:00Z")],
    new Date("2026-09-18T06:30:00Z"),
  );
  assert.deepEqual(retried(v), []);
  assert.match(v[0].why, /before it ended aborted too/);
});

test("a retry that fails is not retried the next morning", () => {
  const runs = [
    run("vizzit", "done", "2026-11-09T00:38:00Z"),
    run("vizzit", "aborted", "2026-11-10T03:10:00Z"),
    run("vizzit", "aborted", "2026-11-10T06:40:00Z"), // the retry
  ];
  assert.deepEqual(retried(pickRetries([src("vizzit")], runs, new Date("2026-11-11T06:30:00Z"))), [], "outside the lookback");
  // And if the next night fails too, the failure before it is the retry.
  const next = [...runs, run("vizzit", "aborted", "2026-11-11T02:00:00Z")];
  assert.deepEqual(retried(pickRetries([src("vizzit")], next, new Date("2026-11-11T06:30:00Z"))), []);
});

test("the lookback reaches the night just gone and not the one before", () => {
  const runs = [run("vizzit", "done", "2026-11-08T00:06:00Z"), run("vizzit", "aborted", "2026-11-09T00:38:00Z")];
  // A night that has not started yet by 06:30 leaves yesterday's failure as the latest run: 30 h old.
  assert.deepEqual(retried(pickRetries([src("vizzit")], runs, new Date("2026-11-10T06:30:00Z"))), []);
  const justInside = new Date(new Date("2026-11-09T00:38:00Z").getTime() + (RETRY_LOOKBACK_HOURS - 0.1) * 3_600_000);
  assert.deepEqual(retried(pickRetries([src("vizzit")], runs, justInside)), ["vizzit"]);
});

test("a switched-off source is never retried: --sources= would override the flag", () => {
  const v = pickRetries(
    [src("smc", { enabled: false })],
    [run("smc", "done", "2026-11-09T00:00:00Z"), run("smc", "aborted", "2026-11-10T02:00:00Z")],
    MORNING,
  );
  assert.deepEqual(retried(v), []);
  assert.match(v[0].why, /switched off/);
});

test("the client's paid feed and Superimmo are never retried by the schedule", () => {
  const keys = ["stream-estate-v1", "superimmo"];
  const v = pickRetries(
    keys.map((k) => src(k)),
    keys.flatMap((k) => [run(k, "done", "2026-11-09T00:55:00Z"), run(k, "error", "2026-11-10T03:05:00Z")]),
    MORNING,
  );
  assert.deepEqual(retried(v), []);
  assert.match(v.find((x) => x.key === "stream-estate-v1")!.why, /client's card/);
});

test("a manual or backfill run that failed is left to whoever started it", () => {
  const v = pickRetries(
    [src("stream-estate")],
    [run("stream-estate", "done", "2026-11-09T01:32:00Z"), run("stream-estate", "error", "2026-11-10T03:36:00Z", "backfill")],
    MORNING,
  );
  assert.deepEqual(retried(v), []);
});

test("LuxuryEstate asked for 01:00-05:00 Paris: the 06:30 UTC retry does not go back to it", () => {
  const lux = src("luxuryestate", { config: { collectWindow: { from: 1, to: 5, tz: "Europe/Paris" } } });
  const runs = [run("luxuryestate", "done", "2026-11-09T00:38:00Z"), run("luxuryestate", "aborted", "2026-11-10T03:05:00Z")];
  const v = pickRetries([lux], runs, MORNING);
  assert.deepEqual(retried(v), []);
  assert.match(v[0].why, /outside the hours/);
  // Inside its hours (03:30 UTC is 04:30 Paris in winter) it would be.
  assert.deepEqual(retried(pickRetries([lux], runs, new Date("2026-11-10T03:30:00Z"))), ["luxuryestate"]);
});

test("a run still going, and a partial night before a failure, are read as they are", () => {
  const v = pickRetries(
    [src("bienici"), src("etreproprio")],
    [
      run("bienici", "aborted", "2026-11-09T01:10:00Z"),
      run("bienici", "running", "2026-11-10T03:23:00Z"),
      run("etreproprio", "partial", "2026-11-09T00:57:00Z"),
      run("etreproprio", "error", "2026-11-10T03:11:00Z"),
    ],
    MORNING,
  );
  assert.deepEqual(retried(v), ["etreproprio"], "running is not a failure; partial is a night that worked");
});

test("a run started after the moment judged is not read — `--at` rehearses a past morning", () => {
  const runs = [
    run("vizzit", "done", "2026-11-09T00:38:00Z"),
    run("vizzit", "aborted", "2026-11-10T03:10:00Z"),
    run("vizzit", "done", "2026-11-10T16:32:00Z"), // the hand dispatch that fixed it
  ];
  assert.deepEqual(retried(pickRetries([src("vizzit")], runs, MORNING)), ["vizzit"]);
  assert.deepEqual(retried(pickRetries([src("vizzit")], runs, new Date("2026-11-10T17:00:00Z"))), []);
});

test("a collect window that crosses midnight", () => {
  const w = { from: 22, to: 4, tz: "UTC" };
  assert.equal(insideCollectWindow(w, new Date("2026-11-10T23:00:00Z")), true);
  assert.equal(insideCollectWindow(w, new Date("2026-11-10T03:59:00Z")), true);
  assert.equal(insideCollectWindow(w, new Date("2026-11-10T04:00:00Z")), false);
  assert.equal(insideCollectWindow({ from: 1, to: 5, tz: "Europe/Paris" }, new Date("2026-11-10T00:00:00Z")), true, "01:00 Paris in winter");
});
