import { test } from "node:test";
import assert from "node:assert/strict";
import { triage, triageLines, type PreviousRow } from "./triage";
import type { CheckResult } from "./portalChecks";

const row = (key: string, source: string, vault: CheckResult["vault"], ours: CheckResult["ours"], note: string | null = null): CheckResult =>
  ({ key, source, label: key, message: `${key} ${source}`, vault, ours, note, value: 0, expected: "", detail: {} }) as CheckResult;
const prev = (checkKey: string, source: string, vaultStatus: string | null, ourStatus: string | null): PreviousRow => ({ checkKey, source, vaultStatus, ourStatus });

test("our reading decides what needs a look; the client's flags alone are explained", () => {
  const t = triage(
    [
      row("market.new_listings", "green-acres", "red", "red"),
      row("market.stale_active", "logic-immo", "amber", "green", "V1 reads changes only"),
      row("market.missing_price", "seloger", "green", "green"),
    ],
    [],
  );
  assert.deepEqual(t.needsLook.map((i) => i.source), ["green-acres"]);
  assert.deepEqual(t.explained.map((i) => [i.source, i.note]), [["logic-immo", "V1 reads changes only"]]);
  assert.equal(t.needsLook[0].isNew, false, "with no run before, nothing is called new");
});

test("new is what our reading flags now and did not flag in the run before", () => {
  const t = triage(
    [row("market.source_run", "vizzit", "red", "red"), row("market.new_listings", "green-acres", "red", "red")],
    [prev("market.new_listings", "green-acres", "red", "red")],
  );
  assert.deepEqual(t.needsLook.map((i) => [i.source, i.isNew]), [["vizzit", true], ["green-acres", false]]);
});

test("cleared is what either side flagged before and neither flags now", () => {
  const t = triage(
    [row("market.source_run", "vizzit", "green", "green"), row("market.quarantine", "seloger", "green", null)],
    [prev("market.source_run", "vizzit", "red", "red"), prev("market.quarantine", "seloger", "red", null), prev("market.sqft", "", "green", "green")],
  );
  assert.deepEqual(t.cleared.map((i) => i.source).sort(), ["seloger", "vizzit"]);
});

test("the summary line names the new problems first", () => {
  const t = triage([row("market.source_run", "vizzit", "red", "red"), row("market.stale_active", "pap", "amber", "green")], [prev("market.source_run", "vizzit", "green", "green")]);
  const { line, details } = triageLines(t);
  assert.match(line, /^triage: 1 needs a look \(1 new: market\.source_run \[vizzit\]\); 1 of the client's flags explained; 0 cleared/);
  assert.match(details[0], /^NEW RED market\.source_run \[vizzit\]/);
});

test("a row that cleared by disappearing is still named, not shown by its key", () => {
  // 2026-11-10: leboncoin's quarantine row was there in the night's run and absent in the evening's.
  const t = triage([], [prev("market.quarantine", "leboncoin", "amber", null)]);
  assert.equal(t.cleared[0].label, "Values refused or mended (data contract)");
});
