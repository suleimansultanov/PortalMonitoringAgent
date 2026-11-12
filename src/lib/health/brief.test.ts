import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBrief, type BriefInput } from "./brief";

const NIGHT = new Date("2026-11-12T03:20:00Z");
const BEFORE = new Date("2026-11-11T01:42:00Z");
const check = (ran_at: Date, check_key: string, source: string, vault_status: string | null, our_status: string | null, value: number, note: string | null = null) => ({
  ran_at, check_key, source, vault_status, our_status, value, expected: "about 0.2 %", message: `${check_key} ${source} ${value}`, note, detail: ran_at === NIGHT ? { recent: 187 } : null,
});
const input = (checks: BriefInput["checks"], runs = [NIGHT, BEFORE]): BriefInput => ({
  asOf: new Date("2026-11-12T08:00:00Z"),
  runs,
  checks,
  collection: [{ source_key: "vizzit", started_at: new Date("2026-11-12T02:10:00Z"), completed_at: null, mode: "scheduled", status: "aborted", seen_count: 0, new_count: 0, gone_count: 0, fetched_count: 0, failed_count: 0, aborted_reason: "0 against 5280", error: null }],
});

test("a row our reading flags tonight and not the night before is NEW, with its nights beside it", () => {
  const md = renderBrief(input([
    check(NIGHT, "market.missing_price", "vizzit", "amber", "amber", 0.123),
    check(BEFORE, "market.missing_price", "vizzit", "green", "green", 0.092),
    check(NIGHT, "market.stale_active", "figaro", "amber", "green", 0.93, "V1 reads changes only"),
    check(BEFORE, "market.stale_active", "figaro", "amber", "green", 0.93, "V1 reads changes only"),
  ]));
  assert.match(md, /Needs a look: 1 \(1 new\)\. Explained by a known cause: 1\./);
  assert.match(md, /VERDICT: something new needs a look/);
  assert.match(md, /### NEW AMBER .*\[vizzit\] \(`market\.missing_price`\)/);
  assert.match(md, /2026-11-11 01:42 {2}ours green, client green, value 0\.092/);
  assert.match(md, /V1 reads changes only/);
  assert.match(md, /2026-11-12 02:10 scheduled aborted: seen 0.* — 0 against 5280/);
});

test("the verdict the daily review stops on: nothing new, and nothing at all", () => {
  const still = renderBrief(input([
    check(NIGHT, "market.missing_price", "vizzit", "amber", "amber", 0.12),
    check(BEFORE, "market.missing_price", "vizzit", "amber", "amber", 0.11),
  ]));
  assert.match(still, /VERDICT: nothing new\./);
  const quiet = renderBrief(input([check(NIGHT, "market.missing_price", "vizzit", "green", "green", 0), check(BEFORE, "market.missing_price", "vizzit", "green", "green", 0)]));
  assert.match(quiet, /VERDICT: nothing needs a look\./);
  assert.match(renderBrief(input([], [])), /No stored run/);
});
