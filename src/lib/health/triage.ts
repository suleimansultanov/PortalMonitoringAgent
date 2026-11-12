import { LABELS, type CheckResult } from "./portalChecks";
import type { Status } from "./rules";

/**
 * WHAT TONIGHT'S DATA HEALTH MEANS FOR US: what needs a look, what is explained,
 * what went away since the run before.
 *
 * The client's rules flag a lot that is not a fault: V1 portals "not re-checked"
 * by design, a quiet Monday read as a broken collector, plots without a living
 * area. Our own verdict (`ours`) is the client's rule corrected where we measured
 * it misreading the collector, so the split is mechanical:
 *
 *   needs a look — flagged by our reading. Marked NEW when the run before did not
 *                  flag it, which is the line worth reading first.
 *   explained    — flagged by the client's rule only; the row's note says why.
 *   cleared      — flagged by either in the run before, by neither now.
 *
 * Pure: the nightly hands it this run and the last stored one.
 */

export type PreviousRow = { checkKey: string; source: string; vaultStatus: string | null; ourStatus: string | null };

export type TriageItem = { key: string; source: string; label: string; message: string; status: Status; isNew?: boolean; note?: string | null };

export type Triage = { needsLook: TriageItem[]; explained: TriageItem[]; cleared: TriageItem[]; hadPrevious: boolean };

const flagged = (s: string | null | undefined): s is "red" | "amber" => s === "red" || s === "amber";
const id = (key: string, source: string) => `${key}\u0000${source}`;
const rank = (s: Status) => (s === "red" ? 0 : s === "amber" ? 1 : 2);

export function triage(current: CheckResult[], previous: PreviousRow[]): Triage {
  const before = new Map(previous.map((p) => [id(p.checkKey, p.source), p]));
  const needsLook: TriageItem[] = [];
  const explained: TriageItem[] = [];
  const now = new Set<string>();

  for (const r of current) {
    const k = id(r.key, r.source);
    if (flagged(r.ours)) {
      now.add(k);
      needsLook.push({ key: r.key, source: r.source, label: r.label, message: r.message, status: r.ours, isNew: previous.length > 0 && !flagged(before.get(k)?.ourStatus) });
    } else if (flagged(r.vault)) {
      now.add(k);
      explained.push({ key: r.key, source: r.source, label: r.label, message: r.message, status: r.vault, note: r.note });
    }
  }

  const labels = new Map(current.map((r) => [id(r.key, r.source), r.label]));
  const cleared: TriageItem[] = previous
    .filter((p) => (flagged(p.vaultStatus) || flagged(p.ourStatus)) && !now.has(id(p.checkKey, p.source)))
    .map((p) => ({
      key: p.checkKey,
      source: p.source,
      // A row that cleared is often absent tonight (no quarantine, no row), so its label is looked up.
      label: labels.get(id(p.checkKey, p.source)) ?? LABELS[p.checkKey] ?? p.checkKey,
      message: "",
      status: "green" as const,
    }));

  const order = (a: TriageItem, b: TriageItem) => Number(!!b.isNew) - Number(!!a.isNew) || rank(a.status) - rank(b.status) || a.label.localeCompare(b.label) || a.source.localeCompare(b.source);
  return { needsLook: needsLook.sort(order), explained: explained.sort(order), cleared, hadPrevious: previous.length > 0 };
}

const name = (i: TriageItem) => `${i.label}${i.source ? ` [${i.source}]` : ""}`;

/**
 * One line for the nightly summary, the lines to print under it, and whether the
 * night has to reach a person: `alert` when our reading flags something the run
 * before did not. Only the new, so an open problem is told once, not every night.
 */
export function triageLines(t: Triage): { line: string; details: string[]; alert: boolean } {
  const fresh = t.needsLook.filter((i) => i.isNew);
  const line =
    `triage: ${t.needsLook.length} need${t.needsLook.length === 1 ? "s" : ""} a look` +
    (fresh.length ? ` (${fresh.length} new: ${fresh.slice(0, 3).map(name).join("; ")}${fresh.length > 3 ? "; …" : ""})` : "") +
    `; ${t.explained.length} of the client's flags explained` +
    (t.hadPrevious ? `; ${t.cleared.length} cleared since the run before` : "");
  const details = [
    ...t.needsLook.map((i) => `${i.isNew ? "NEW " : ""}${i.status.toUpperCase()} ${name(i)}: ${i.message}`),
    ...(t.cleared.length ? [`cleared: ${t.cleared.slice(0, 8).map(name).join("; ")}${t.cleared.length > 8 ? "; …" : ""}`] : []),
  ];
  return { line, details, alert: fresh.length > 0 };
}
