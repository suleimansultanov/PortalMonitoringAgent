/**
 * Data health, the verdicts. Numbers in, a colour and a sentence out.
 *
 * WHY THIS IS ON OUR SIDE TOO. The client's app (vault, written by Tomaz,
 * `src/lib/ops/data-health*.ts`) reads our feed every night and judges it. For
 * weeks we learned what it found from a screenshot, and every answer was a
 * one-off query that left nothing behind. These are the same rules at the same
 * thresholds, as of vault commit eaed31c (2026-11-03), so that we see what the
 * client sees, on our own side, before and after each fix.
 *
 * Same thresholds on purpose, including the ones we think are wrong: a copy that
 * quietly improves on the original cannot be checked against it. Where our
 * reading differs, `portalChecks.ts` says so beside the copied verdict rather
 * than instead of it.
 *
 * Pure, so the tests read the same sentences the report prints.
 */

export type Status = "green" | "amber" | "red" | "unknown";

export type Verdict = { status: Status; expected: string; message: string };

const RANK: Record<Status, number> = { unknown: 0, green: 1, amber: 2, red: 3 };

export const worst = (xs: Status[]): Status =>
  xs.reduce<Status>((w, s) => (RANK[s] > RANK[w] ? s : w), xs.length ? "green" : "unknown");

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export const fmt = (n: number): string =>
  Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-GB") : String(Math.round(n * 10) / 10);

export const pct = (x: number): string => `${Math.round(x * 1000) / 10} %`;

/**
 * A volume against its own recent days. Red at zero or more than 40 % below the
 * median, amber more than 25 % below. A source whose median is under five is too
 * small to judge a drop: only a zero where three or more are usual is flagged.
 */
export function volume(value: number, history: number[], unit = "a night"): Verdict {
  const med = median(history);
  if (med === null || history.length < 3) {
    return { status: "unknown", expected: "not enough history yet (needs 3 days)", message: `${fmt(value)} ${unit}; no baseline yet.` };
  }
  const expected = `about ${fmt(med)} ${unit} (median of the last ${history.length} days); red below ${fmt(med * 0.6)}`;
  if (med < 5) {
    if (value === 0 && med >= 3) return { status: "amber", expected, message: `None today, usually ${fmt(med)}.` };
    return { status: "green", expected: `small source, about ${fmt(med)} ${unit}`, message: `${fmt(value)} ${unit}.` };
  }
  if (value === 0) return { status: "red", expected, message: `Nothing arrived; usually ${fmt(med)}.` };
  const drop = 1 - value / med;
  const below = `${fmt(value)} ${unit}, ${Math.round(drop * 100)} % below the usual ${fmt(med)}.`;
  if (drop > 0.4) return { status: "red", expected, message: below };
  if (drop > 0.25) return { status: "amber", expected, message: below };
  return { status: "green", expected, message: `${fmt(value)} ${unit}, usual is ${fmt(med)}.` };
}

/** A share of bad records against the same source's baseline: amber 10 points above it, red 25. */
export function share(bad: number, total: number, baseline: number | null, what = "missing"): Verdict {
  if (total < 10) {
    return { status: "unknown", expected: "needs 10 records to judge", message: `${bad} of ${total} ${what}; too few to judge.` };
  }
  const s = bad / total;
  const base = baseline ?? 0;
  const expected =
    baseline === null
      ? `no baseline; red above ${pct(0.25)}`
      : `about ${pct(base)} (this source's usual); red above ${pct(Math.min(1, base + 0.25))}`;
  const message = `${fmt(bad)} of ${fmt(total)} ${what} (${pct(s)}).`;
  const over = s - base;
  if (over >= 0.25) return { status: "red", expected, message };
  if (over >= 0.1) return { status: "amber", expected, message };
  return { status: "green", expected, message };
}

/** How old the last good thing is, in minutes. Never is red. */
export function fresh(ageMin: number | null, okMin: number, redMin: number, what: string): Verdict {
  const h = (m: number) => (m >= 120 ? `${Math.round(m / 60)} h` : `${Math.round(m)} min`);
  const expected = `within ${h(okMin)}; red after ${h(redMin)}`;
  if (ageMin === null) return { status: "red", expected, message: `${what}: never.` };
  const message = `${what}: ${h(ageMin)} ago.`;
  if (ageMin > redMin) return { status: "red", expected, message };
  if (ageMin > okMin) return { status: "amber", expected, message };
  return { status: "green", expected, message };
}

/** A size against the previous one: a drop means a partial read. */
export function dropVsPrevious(value: number, prev: number | null, opts: { redPct: number; amberPct: number; what: string }): Verdict {
  if (prev === null || prev === 0) {
    return { status: "unknown", expected: "no previous run to compare", message: `${fmt(value)} ${opts.what}.` };
  }
  const change = (value - prev) / prev;
  const expected = `close to the previous ${fmt(prev)}; red ${Math.round(opts.redPct * 100)} % below`;
  const message = `${fmt(value)} ${opts.what} (previous ${fmt(prev)}, ${change >= 0 ? "+" : ""}${Math.round(change * 1000) / 10} %).`;
  if (change < -opts.redPct) return { status: "red", expected, message };
  if (change < -opts.amberPct) return { status: "amber", expected, message };
  return { status: "green", expected, message };
}

/** A count of anomalies: amber from `amber`, red from `red`. */
export function threshold(value: number, opts: { amber: number; red: number; what: string }): Verdict {
  const expected = opts.amber <= 1 ? `none; red from ${opts.red}` : `below ${opts.amber}; red from ${opts.red}`;
  const message = `${fmt(value)} ${opts.what}.`;
  if (value >= opts.red) return { status: "red", expected, message };
  if (value >= opts.amber) return { status: "amber", expected, message };
  return { status: "green", expected, message };
}

/** A price that moved by a factor of five or more: a digit error far more often than a deal. */
export function priceJump(prev: number | null | undefined, next: number | null | undefined): boolean {
  if (!prev || !next || prev <= 0 || next <= 0) return false;
  const r = next / prev;
  return r >= 5 || r <= 0.2;
}
