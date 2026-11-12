import { bedroomsFromLabels, contractIssues, sqftAsM2, unrepairable, type FeedProperty, type Issue } from "./contract";
import { dropVsPrevious, fmt, fresh, median, pct, share, threshold, volume, worst, type Status, type Verdict } from "./rules";

/**
 * Data health, the portal checks. Pure: `load.ts` gathers, this judges.
 *
 * EVERY ROW HAS TWO VERDICTS, side by side.
 *
 *   `vault` is what the client's app concludes from the same numbers, at its
 *   thresholds. It is how we check the copy against Tomaz's screen: the two must
 *   agree before anything else here means anything.
 *
 *   `ours` is what we conclude knowing how the collector works. It differs only
 *   where we measured the rule misreading us, and `note` says how.
 *
 * Either can be null: a row of vault's that has no meaning for us (a deviation
 * filed under the wrong portal), or one of ours vault cannot see (the V1 meter).
 *
 * Only the portal block of vault's module is here: 17 kinds of check, 157 of its
 * 196 rows on 2026-11-03. Apimo, the CRM, enquiries and documents are its own data.
 */

export const LABELS: Record<string, string> = {
  "market.sync_run": "Feed the client reads",
  "market.source_run": "Collector run",
  "market.new_listings": "New listings received",
  "market.missing_price": "Listings without a price",
  "market.missing_area": "Listings without an area",
  "market.missing_photo": "Listings without a photo",
  "market.missing_bedrooms": "Listings without bedrooms",
  "market.missing_commune": "Listings without a commune",
  "market.mojibake": "Garbled text (encoding)",
  "market.sqft": "Square feet stored as m²",
  "market.ppm_outliers": "Implausible price per m²",
  "market.price_jumps": "Price jumps ×5 or more",
  "market.stale_active": "Active but not re-checked for 14 days",
  "market.delisted": "Marked delisted tonight",
  "market.duplicates": "Likely duplicates hidden",
  "market.sources_changed": "Portals appeared or vanished",
  "market.quarantine": "Values refused or mended (data contract)",
  "ours.value_origin": "Values refused or mended, by who supplied them",
  "ours.v1_meter": "Stream.Estate V1 items this period",
};

export type CheckResult = {
  key: string;
  label: string;
  source: string;
  vault: Status | null;
  ours: Status | null;
  value: number | null;
  expected: string;
  message: string;
  /** Why `ours` differs from `vault`. */
  note: string | null;
  detail: Record<string, unknown>;
};

/**
 * Why a listing has no price, where its page says so. `on_request`: the page
 * prints "prix sur demande" (`raw.priceOnRequest`), the agency withholds it.
 * `foreign_currency`: the page states a price only in another currency
 * (`raw.foreignPrice`) and no EUR figure — an advert priced in zlotys, or the
 * visitor's currency because we did not find the EUR line.
 */
export type PriceMissing = "on_request" | "foreign_currency";

/** One served listing, in history or live: an aggregator row already split into its portals. */
export type HistoryRow = {
  portal: string;
  propertyId: string;
  firstSeenAt: Date;
  hasPrice: boolean;
  /** Set only when `hasPrice` is false and the page said why. */
  priceMissing?: PriceMissing;
  hasArea: boolean;
  hasBedrooms: boolean;
  propertyHasBedrooms: boolean;
  propertyType: string | null;
  hasPhoto: boolean;
  hasCommune: boolean;
};

export type StatusSource = { key: string; lastRunAt: string | null; lastOutcome: string; via?: string };

export type HealthInput = {
  now: Date;
  properties: FeedProperty[];
  history: HistoryRow[];
  status: StatusSource[];
  lastCollectionAt: string | null;
  /** Properties that stopped being active, by nights ago: 0 is the last 24 hours. */
  closedByAge: Map<number, number>;
  priceJumps: number;
  /** The cards vault's duplicate net would hide, by property id. */
  hiddenDuplicates: Set<string>;
  /** Which of our sources holds a refused value: property id → field → source keys. */
  origins: Map<string, Map<string, string[]>>;
  activeBySource: Map<string, number>;
  meter: { items: number; cap: number; periodStart: Date } | null;
  /** Earlier stored values of a check, oldest first. Empty until `--write` has run. */
  previous: (key: string, source?: string) => number[];
  previousPortals: string[] | null;
};

const DAY = 86_400_000;
const HOUR_MIN = 60;

/** Everything before this is the backfill: the crawl began on 26 August, so it all reads as new. Vault's own line. */
export const COUNTING_FROM = new Date("2026-09-06T00:00:00Z");

const NOT_PORTALS = new Set(["apimo", "stream-estate", "stream-estate-v1"]);
/** Vault's list, exact and case-sensitive: copied as it stands, for the `vault` verdict. */
const VAULT_NO_BEDROOMS = new Set(["Terrain", "Parking", "Commerce", "Local", "Land", "Garage", "Bureau"]);
/**
 * What actually has no bedroom count to miss. `Programme neuf` was the one that
 * mattered: 54 of 54 lacked one on 2026-11-03 and made Bien'ici red by itself,
 * because a programme states rooms ("T4") and never bedrooms.
 *
 * Since 2026-11-08 ingest stores the client's word (portals/propertyType.ts), so
 * a programme lot is a "Maison" or an "Appartement" read from its title and is
 * counted here: a T4 house has bedrooms, the portal just does not state them.
 * The raw labels stay in the pattern for rows stored before.
 */
const NO_BEDROOM_COUNT = /^(programme|terrain|land|parking|garage|box|commerc|local|bureau|office|shop|cave)/i;
/** The same, plus what a price per m² means nothing for. `Landform` and `Local-commercial` are raw labels, 18 of 19 and 10 of 49 "too cheap". */
const NOT_A_HOME = /^(programme|terrain|land|parking|garage|box|commerc|local|bureau|office|shop|cave|immeuble|building|unknown)/i;

const minutesSince = (iso: string | null, now: Date): number | null => (iso ? (now.getTime() - new Date(iso).getTime()) / 60_000 : null);
const ageDays = (d: Date, now: Date) => Math.floor((now.getTime() - d.getTime()) / DAY);

function row(key: string, source: string, v: Verdict, ours: Status | null, value: number | null, extra: { note?: string; detail?: Record<string, unknown> } = {}): CheckResult {
  return {
    key,
    label: LABELS[key] ?? key,
    source,
    vault: v.status,
    ours,
    value,
    expected: v.expected,
    message: v.message,
    note: extra.note ?? null,
    detail: extra.detail ?? {},
  };
}

/* ── The feed and the runs ─────────────────────────────────────────────── */

function feedChecks(input: HealthInput): CheckResult[] {
  const { now, properties } = input;
  const size = properties.length;
  const age = minutesSince(input.lastCollectionAt, now);
  let v = fresh(age, 26 * HOUR_MIN, 30 * HOUR_MIN, "Last collection");
  const d = dropVsPrevious(size, median(input.previous("market.sync_run")), { redPct: 0.4, amberPct: 0.15, what: "properties in the feed" });
  v =
    d.status === "red" || d.status === "amber"
      ? { status: d.status, expected: d.expected, message: `${v.message} ${d.message} A smaller feed means a partial read.` }
      : { ...v, message: `${v.message} ${d.message}` };
  const out = [row("market.sync_run", "", v, v.status, size)];

  // Delisted in the last day, against the nights before.
  const closed = input.closedByAge.get(0) ?? 0;
  const before = [1, 2, 3, 4, 5, 6, 7].map((a) => input.closedByAge.get(a) ?? 0);
  const med = median(before);
  const big = size * 0.05;
  const st: Status = closed > big ? "red" : med !== null && closed > Math.max(30, med * 3) ? "amber" : "green";
  out.push(
    row(
      "market.delisted",
      "",
      { status: st, expected: `about ${fmt(med ?? 0)} a night; red above 5 % of the feed (${fmt(Math.round(big))})`, message: `${fmt(closed)} properties stopped being served in the last day.` },
      st,
      closed,
    ),
  );
  return out;
}

function runChecks(input: HealthInput): CheckResult[] {
  const { now, status } = input;
  const twice = new Set(status.map((s) => s.key).filter((k, i, a) => a.indexOf(k) !== i));
  const out = status.map((s) => {
    const age = minutesSince(s.lastRunAt, now);
    const label = twice.has(s.key) ? `${s.key} (${s.via ? `via ${s.via}` : "direct"})` : s.key;
    let v = fresh(age, 26 * HOUR_MIN, 48 * HOUR_MIN, `Last run (${s.lastOutcome})`);
    if (s.lastOutcome === "error" || s.lastOutcome === "aborted") {
      v = { ...v, status: "red", message: `Last run ${s.lastOutcome}${age === null ? "" : ` ${Math.round(age / 60)} h ago`}.` };
    }
    return row("market.source_run", label, v, v.status, age === null ? null : Math.round(age / 60), { detail: { via: s.via ?? null } });
  });

  if (status.length > 0) {
    const nowKeys = [...new Set(status.map((s) => s.key))].sort();
    const seen = new Set(input.previousPortals ?? []);
    const first = seen.size === 0;
    const added = nowKeys.filter((k) => !seen.has(k));
    const gone = [...seen].filter((k) => !nowKeys.includes(k));
    const st: Status = gone.length ? "red" : added.length && !first ? "amber" : "green";
    const message = first
      ? `${nowKeys.length} portals recorded (first check).`
      : [added.length ? `New: ${added.join(", ")}.` : "", gone.length ? `Gone: ${gone.join(", ")}.` : "", !added.length && !gone.length ? `${nowKeys.length} portals, unchanged.` : ""].join(" ").trim();
    out.push(row("market.sources_changed", "", { status: st, expected: "the same portals as before", message }, st, first ? 0 : added.length + gone.length, { detail: { portals: nowKeys } }));
  }
  return out;
}

/* ── Per portal ────────────────────────────────────────────────────────── */

type PortalTotals = { active: number; stale: number; staleForUs: number; exempt: number; first: number };

function portalTotals(input: HealthInput): Map<string, PortalTotals> {
  const { now } = input;
  const out = new Map<string, PortalTotals>();
  const get = (p: string) => {
    let t = out.get(p);
    if (!t) out.set(p, (t = { active: 0, stale: 0, staleForUs: 0, exempt: 0, first: Infinity }));
    return t;
  };
  for (const p of input.properties) {
    for (const l of p.listings) {
      const t = get(l.source);
      t.active += 1;
      const seen = l.lastSeenAt ? new Date(l.lastSeenAt).getTime() : 0;
      const stale = now.getTime() - seen > 14 * DAY;
      if (stale) t.stale += 1;
      /**
       * Not re-read on purpose, so not "not re-checked". V1 reads its stock once
       * and then changes only, which delists by name: 4 947 of 6 170 rows last
       * touched on 15 October, by design. And a portal whose index says a page
       * has not changed is left alone for up to 30 days (run.ts): all 726 stale
       * Bien'ici rows on 2026-11-03.
       */
      const byDesign = l.via === "stream-estate-v1" || (!!l.sourceUpdatedAt && now.getTime() - seen < 30 * DAY);
      if (byDesign) t.exempt += 1;
      else if (stale) t.staleForUs += 1;
      if (l.firstSeenAt) t.first = Math.min(t.first, new Date(l.firstSeenAt).getTime());
    }
  }
  for (const h of input.history) {
    const t = get(h.portal);
    t.first = Math.min(t.first, h.firstSeenAt.getTime());
  }
  return out;
}

/** The nights behind `now` a portal existed for, and after the backfill line. */
function nightsKnown(first: number, now: Date, ages: number[]): number[] {
  return ages.filter((a) => now.getTime() - a * DAY > first && now.getTime() - (a + 1) * DAY > COUNTING_FROM.getTime());
}

/**
 * One night against a median is too sharp for a portal this lumpy: Etreproprio
 * ranges 10–34 a night and went red at 9. Three nights against what three nights
 * usually bring keeps a real fall (Vizzit's, amber) and drops the noise.
 */
function threeNights(by: Map<number, number>, first: number, now: Date): { status: Status; note: string } {
  const recent = (by.get(0) ?? 0) + (by.get(1) ?? 0) + (by.get(2) ?? 0);
  const prior = nightsKnown(first, now, [3, 4, 5, 6, 7, 8, 9]).map((a) => by.get(a) ?? 0);
  const med = median(prior);
  if (med === null || prior.length < 3) return { status: "unknown", note: "too little history for three nights" };
  const usual = med * 3;
  const note = `last 3 nights ${fmt(recent)}, usually about ${fmt(usual)}`;
  if (med < 5) return { status: recent === 0 && med >= 3 ? "amber" : "green", note };
  const drop = 1 - recent / usual;
  // Red takes a portal large enough to mean it: Belles Demeures at six a night brought 6 in three nights, not 18, on an ordinary week.
  if (recent === 0 || (med >= 10 && drop > 0.6)) return { status: "red", note };
  return { status: drop > 0.4 ? "amber" : "green", note };
}

/**
 * The same three nights of the week, in the weeks before: Monday's nights against
 * Mondays'. Volume follows the week — on 2026-11-10 Green-Acres' median by night
 * of the week was 5 on Mondays and 7 on Sundays against 38 on Thursdays, and
 * LuxuryEstate's 2 on Tuesdays against 21.5 on Fridays — so a quiet start of the
 * week read as a broken collector, to the client's rule and to three-night medians
 * alike. Null until two earlier weeks are known; the caller falls back to three
 * nights against the nights before.
 */
function sameNightsOfWeek(by: Map<number, number>, first: number, now: Date): { status: Status; note: string } | null {
  const window = (span: number) => {
    const sum = (ages: number[]) => ages.reduce((n, a) => n + (by.get(a) ?? 0), 0);
    const nights = (start: number) => Array.from({ length: span }, (_, i) => start + i);
    const weeks = [1, 2, 3, 4]
      .map((w) => nights(7 * w))
      .filter((ages) => nightsKnown(first, now, ages).length === ages.length)
      .map(sum);
    return { recent: sum(nights(0)), weeks };
  };
  const three = window(3);
  if (three.weeks.length < 2) return null;

  /**
   * A portal that arrives in batches: three nights cannot tell a quiet stretch
   * from a fall when ordinary weeks already ranged from a few to many. Idealista,
   * through Stream.Estate, brought 31, 5, 18 and 5 over the same three nights of
   * four weeks — batches of 28, 19 and 15 between nights of 0 to 3 — and was
   * amber on 2026-11-12 for three nights of 0 with its run done and its stock
   * re-read. Where the quietest earlier window is under a third of the busiest,
   * the week is judged instead: seven nights against the same seven of the
   * weeks before. A regular portal never qualifies (SeLoger 232, 192, 251, 128;
   * Vizzit 151, 184, 350, 229) and keeps the sharper three nights.
   */
  const lumpy = Math.min(...three.weeks) * 3 < Math.max(...three.weeks);
  const seven = lumpy ? window(7) : null;
  const { recent, weeks } = seven && seven.weeks.length >= 2 ? seven : three;
  const span = seven && seven.weeks.length >= 2 ? 7 : 3;

  const usual = median(weeks)!;
  const perNight = usual / span;
  const note =
    span === 7
      ? `arrives in batches (the same 3 nights of earlier weeks: ${three.weeks.map(fmt).join(", ")}), so judged by the week: last 7 nights ${fmt(recent)}, the same nights of the ${weeks.length} weeks before about ${fmt(usual)}`
      : `last 3 nights ${fmt(recent)}, the same nights of the ${weeks.length} weeks before about ${fmt(usual)}`;
  if (perNight < 5) return { status: recent === 0 && perNight >= 3 ? "amber" : "green", note };
  const drop = 1 - recent / usual;
  if (recent === 0 || (perNight >= 10 && drop > 0.6)) return { status: "red", note };
  return { status: drop > 0.4 ? "amber" : "green", note };
}

function portalChecks(input: HealthInput, totals: Map<string, PortalTotals>): CheckResult[] {
  const { now, status } = input;
  const statusKeys = new Set(status.map((s) => s.key));
  const out: CheckResult[] = [];
  const since = Math.max(now.getTime() - 8 * DAY, COUNTING_FROM.getTime());

  for (const [portal, t] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
    if (NOT_PORTALS.has(portal) || (t.active === 0 && !statusKeys.has(portal))) continue;

    const rows = input.history.filter((h) => h.portal === portal);
    const byAll = new Map<number, number>();
    const byAge = new Map<number, number>();
    for (const h of rows) {
      const a = ageDays(h.firstSeenAt, now);
      byAll.set(a, (byAll.get(a) ?? 0) + 1);
      if (h.firstSeenAt.getTime() > since) byAge.set(a, (byAge.get(a) ?? 0) + 1);
    }
    const hist = nightsKnown(t.first, now, [1, 2, 3, 4, 5, 6, 7]).map((a) => byAge.get(a) ?? 0);
    const today = byAge.get(0) ?? 0;
    const v = volume(today, hist);
    const three = sameNightsOfWeek(byAll, t.first, now) ?? threeNights(byAll, t.first, now);
    out.push(row("market.new_listings", portal, v, three.status, today, { note: three.status !== v.status ? three.note : undefined, detail: { history: hist } }));

    if (t.active >= 20) {
      const entries = status.filter((s) => s.key === portal);
      const dead = entries.length > 0 && !entries.some((e) => e.lastOutcome === "done" && (minutesSince(e.lastRunAt, now) ?? 1e9) <= 48 * HOUR_MIN);
      const st = t.stale / t.active;
      const vault: Status = st > 0.3 ? (dead ? "red" : "amber") : "green";
      const checked = t.active - t.exempt;
      const ours: Status = checked >= 20 && t.staleForUs / checked > 0.3 ? (dead ? "red" : "amber") : "green";
      out.push(
        row(
          "market.stale_active",
          portal,
          { status: vault, expected: "under 30 % of the portal's active listings", message: `${fmt(t.stale)} of ${fmt(t.active)} active listings not seen for 14 days (${pct(st)})${dead ? "; the portal's crawler is not running" : ""}.` },
          ours,
          t.stale,
          {
            note: ours !== vault ? `${fmt(t.stale - t.staleForUs)} of them are by design (V1 reads changes only; an unchanged index is left alone up to 30 days); ${fmt(t.staleForUs)} of ${fmt(checked)} are not` : undefined,
            detail: { byDesign: t.stale - t.staleForUs, stale: t.staleForUs, checked },
          },
        ),
      );
    }
  }
  return out;
}

/* ── Quality of what arrived: 72 hours against the portal's own last month ── */

type QualityFields = { price: boolean; area: boolean; photo: boolean; commune: boolean };

function qualityChecks(input: HealthInput, totals: Map<string, PortalTotals>): CheckResult[] {
  const { now } = input;
  const statusKeys = new Set(input.status.map((s) => s.key));
  const out: CheckResult[] = [];
  const from = Math.max(now.getTime() - 37 * DAY, COUNTING_FROM.getTime());
  const fields = [
    ["market.missing_price", "price", "without a price"],
    ["market.missing_area", "area", "without an area"],
    ["market.missing_photo", "photo", "without a photo"],
    ["market.missing_commune", "commune", "without a commune"],
  ] as const;

  for (const [portal, t] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
    if (NOT_PORTALS.has(portal) || (t.active === 0 && !statusKeys.has(portal))) continue;
    const rows = input.history.filter((h) => h.portal === portal && h.firstSeenAt.getTime() > from);
    const recent = rows.filter((h) => now.getTime() - h.firstSeenAt.getTime() < 3 * DAY);
    const base = rows.filter((h) => now.getTime() - h.firstSeenAt.getTime() > 8 * DAY);
    if (recent.length === 0) continue;

    const missing: Record<keyof QualityFields, (h: HistoryRow) => boolean> = {
      price: (h) => !h.hasPrice,
      area: (h) => !h.hasArea,
      photo: (h) => !h.hasPhoto,
      commune: (h) => !h.hasCommune,
    };
    if (recent.length >= 10) {
      for (const [key, col, what] of fields) {
        const bad = recent.filter(missing[col]).length;
        const baseline = base.length >= 20 ? base.filter(missing[col]).length / base.length : null;
        const v = share(bad, recent.length, baseline, what);
        if (col !== "price") {
          out.push(row(key, portal, v, v.status, bad / recent.length, { detail: { recent: recent.length, baseline } }));
          continue;
        }
        /**
         * A price the agency withholds is not one we failed to read. On
         * 2026-11-12 Vizzit was amber at 23 of 187 without a price against its
         * usual 0.2 %: 19 printed "prix sur demande", 4 were a Polish agency's
         * adverts priced in zlotys only. The parser had read every one right.
         * A price only in another currency still counts: it is also what a
         * page looks like when we miss the EUR line, as Green-Acres' 535 rows
         * did for three weeks. The note keeps the two apart.
         */
        const unread = (h: HistoryRow) => !h.hasPrice && h.priceMissing !== "on_request";
        const ourBad = recent.filter(unread).length;
        const o = share(ourBad, recent.length, base.length >= 20 ? base.filter(unread).length / base.length : null, "without a price, not counting those on request");
        const onRequest = recent.filter((h) => h.priceMissing === "on_request").length;
        const foreign = recent.filter((h) => h.priceMissing === "foreign_currency").length;
        const split = `${fmt(onRequest)} on request (the agency withholds it), ${fmt(foreign)} priced only in another currency, ${fmt(bad - onRequest - foreign)} unread`;
        out.push(
          row(key, portal, v, o.status, bad / recent.length, {
            note: o.status !== v.status || foreign > 0 ? `${split}; without those on request: ${o.message}` : undefined,
            detail: { recent: recent.length, baseline, onRequest, foreignCurrency: foreign },
          }),
        );
      }
    }

    // Bedrooms, over what can have them. The two lists are the whole difference between the verdicts.
    const noBed = (h: HistoryRow) => !h.hasBedrooms && !h.propertyHasBedrooms;
    const vaultRows = (xs: HistoryRow[]) => xs.filter((h) => !VAULT_NO_BEDROOMS.has(h.propertyType ?? ""));
    const ourRows = (xs: HistoryRow[]) => xs.filter((h) => !NO_BEDROOM_COUNT.test(h.propertyType ?? ""));
    const judge = (pick: (xs: HistoryRow[]) => HistoryRow[]) => {
      const r = pick(recent);
      const b = pick(base);
      return share(r.filter(noBed).length, r.length, b.length >= 20 ? b.filter(noBed).length / b.length : null, "without bedrooms");
    };
    if (vaultRows(recent).length >= 10) {
      const v = judge(vaultRows);
      const o = judge(ourRows);
      const excluded = vaultRows(recent).length - ourRows(recent).length;
      out.push(
        row("market.missing_bedrooms", portal, v, o.status === "unknown" ? "green" : o.status, null, {
          note: o.status !== v.status ? `${fmt(excluded)} are types with no bedroom count; without them: ${o.message}` : undefined,
          detail: { recent: vaultRows(recent).length, excluded },
        }),
      );
    }
  }
  return out;
}

/* ── The whole feed ────────────────────────────────────────────────────── */

function feedQualityChecks(input: HealthInput): CheckResult[] {
  const { properties, now } = input;
  const out: CheckResult[] = [];

  // Garbled text: a portal gets its own row when new ones arrive; the stock is one row below.
  const garbled = properties.filter((p) => unrepairable(p.title) || unrepairable(p.description));
  const recentByPortal = new Map<string, number>();
  for (const p of garbled) {
    for (const l of p.listings) {
      if (l.firstSeenAt && now.getTime() - new Date(l.firstSeenAt).getTime() < 3 * DAY) recentByPortal.set(l.source, (recentByPortal.get(l.source) ?? 0) + 1);
    }
  }
  for (const [portal, n] of [...recentByPortal].sort(([a], [b]) => a.localeCompare(b))) {
    const v = threshold(n, { amber: 1, red: 5, what: "new listings (72 h) with garbled text" });
    out.push(row("market.mojibake", portal, v, v.status, n));
  }
  const moji = threshold(garbled.length, { amber: 1, red: 100, what: "active properties with garbled text the contract cannot repair" });
  out.push(row("market.mojibake", "", moji, moji.status, garbled.length, { detail: { ids: garbled.slice(0, 5).map((p) => p.id) } }));

  // Square feet stored as m²: before the client's contract converts them, since that is the part we can fix.
  const sq = new Map<string, number>();
  for (const p of properties) for (const l of p.listings) if (sqftAsM2(l.areaM2, l.characteristics)) sq.set(l.source, (sq.get(l.source) ?? 0) + 1);
  const sqTotal = [...sq.values()].reduce((a, b) => a + b, 0);
  const sqV = threshold(sqTotal, { amber: 1, red: 20, what: "active listings with square feet stored as m²" });
  out.push(row("market.sqft", "", sqV, sqV.status, sqTotal, { detail: { bySource: Object.fromEntries(sq) } }));

  // Price per m² against the commune's median.
  const ppm = (keep: (p: FeedProperty) => boolean) => {
    const rows = properties.filter((p) => !input.hiddenDuplicates.has(p.id) && p.priceEur !== null && p.priceEur > 0 && p.areaM2 !== null && p.areaM2 >= 15 && p.communeInsee !== null && keep(p));
    const byCommune = new Map<string, number[]>();
    for (const p of rows) byCommune.set(p.communeInsee!, [...(byCommune.get(p.communeInsee!) ?? []), p.priceEur! / p.areaM2!]);
    let low = 0;
    let high = 0;
    let total = 0;
    for (const values of byCommune.values()) {
      if (values.length < 20) continue;
      const med = median(values)!;
      total += values.length;
      for (const x of values) {
        if (x < med / 4) low += 1;
        else if (x > med * 4) high += 1;
      }
    }
    const s = total ? (low + high) / total : 0;
    const status: Status = s > 0.05 ? "red" : s > 0.02 ? "amber" : "green";
    return { low, high, total, s, status };
  };
  const vaultPpm = ppm((p) => !VAULT_NO_BEDROOMS.has(p.propertyType ?? ""));
  const ourPpm = ppm((p) => !NOT_A_HOME.test(p.propertyType ?? ""));
  if (vaultPpm.total > 0) {
    out.push(
      row(
        "market.ppm_outliers",
        "",
        { status: vaultPpm.status, expected: "under 2 % of active listings; red above 5 %", message: `${fmt(vaultPpm.low + vaultPpm.high)} of ${fmt(vaultPpm.total)} (${pct(vaultPpm.s)}): ${fmt(vaultPpm.low)} too cheap, ${fmt(vaultPpm.high)} too dear for their commune.` },
        ourPpm.status,
        vaultPpm.low + vaultPpm.high,
        { note: ourPpm.status !== vaultPpm.status ? `homes only: ${fmt(ourPpm.low + ourPpm.high)} of ${fmt(ourPpm.total)} (${pct(ourPpm.s)})` : undefined, detail: { low: vaultPpm.low, high: vaultPpm.high, total: vaultPpm.total } },
      ),
    );
  }

  const jumps = threshold(input.priceJumps, { amber: 1, red: 5, what: "price changes of ×5 or more in the last day" });
  out.push(row("market.price_jumps", "", jumps, jumps.status, input.priceJumps));

  // Likely duplicates vault hides, against this check's own last week.
  if (properties.length > 0) {
    const s = input.hiddenDuplicates.size / properties.length;
    const med = median(input.previous("market.duplicates"));
    const st: Status = med !== null && s - med > 0.08 ? "red" : med !== null && s - med > 0.03 ? "amber" : "green";
    out.push(
      row(
        "market.duplicates",
        "",
        { status: st, expected: med === null ? "a stable share" : `about ${pct(med)} (last week); red 8 points above`, message: `${fmt(input.hiddenDuplicates.size)} of ${fmt(properties.length)} active listings the client hides as likely duplicates (${pct(s)}).` },
        st,
        s,
      ),
    );
  }
  return out;
}

/* ── The data contract ─────────────────────────────────────────────────── */

const ORIGIN_FIELD: Partial<Record<Issue["field"], string>> = { photos: "photos", cover: "cover", title: "title", description: "description" };

function contractChecks(input: HealthInput): CheckResult[] {
  type Tally = { n: number; repaired: number; dropped: number; flagged: number; fields: Set<string> };
  const reported = new Map<string, Tally>();
  const origin = new Map<string, { n: number; props: Set<string>; fields: Map<string, number>; sample: string | null }>();

  for (const p of input.properties) {
    const seen = new Set<string>();
    for (const i of contractIssues(p)) {
      // One row per property, field and portal: what vault's fingerprint counts.
      const fp = `${i.field}|${i.reportedAs ?? ""}`;
      if (seen.has(fp)) continue;
      seen.add(fp);
      const key = i.reportedAs ?? "unknown";
      const t = reported.get(key) ?? { n: 0, repaired: 0, dropped: 0, flagged: 0, fields: new Set<string>() };
      t.n += 1;
      t[i.action] += 1;
      t.fields.add(i.field);
      reported.set(key, t);

      const originField = ORIGIN_FIELD[i.field];
      const sources = originField ? input.origins.get(p.id)?.get(originField) : undefined;
      // A set: a property can hold two rows of one source, and it is still one property.
      for (const s of new Set(sources?.length ? sources : ["unknown"])) {
        const o = origin.get(s) ?? { n: 0, props: new Set<string>(), fields: new Map<string, number>(), sample: null };
        o.n += 1;
        o.props.add(p.id);
        o.fields.set(i.field, (o.fields.get(i.field) ?? 0) + 1);
        o.sample ??= i.bad;
        origin.set(s, o);
      }
    }
  }

  const out: CheckResult[] = [];
  for (const [source, q] of [...reported].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = [q.repaired && `${q.repaired} repaired`, q.dropped && `${q.dropped} dropped`, q.flagged && `${q.flagged} flagged`].filter(Boolean).join(", ");
    const v = threshold(q.n, { amber: 1, red: 50, what: `values refused or mended in the last read (${parts}; ${[...q.fields].sort().join(", ")})` });
    out.push(row("market.quarantine", source, v, null, q.n, { detail: { repaired: q.repaired, dropped: q.dropped, flagged: q.flagged } }));
  }

  /**
   * THE SAME DEVIATIONS, UNDER WHOEVER SUPPLIED THEM. As a share of that source,
   * so a large portal is not red for being large: 40 mended titles in 4 806
   * Stream.Estate rows is housekeeping, 772 cards from 1 467 Etreproprio rows is
   * a fault.
   */
  for (const [source, o] of [...origin].sort(([a], [b]) => a.localeCompare(b))) {
    const active = input.activeBySource.get(source) ?? 0;
    const s = active ? o.props.size / active : 1;
    const ours: Status = s >= 0.1 && o.props.size >= 20 ? "red" : s >= 0.01 ? "amber" : "green";
    const fields = [...o.fields].map(([f, n]) => `${f} ${fmt(n)}`).join(", ");
    out.push({
      key: "ours.value_origin",
      label: LABELS["ours.value_origin"],
      source,
      vault: null,
      ours,
      value: o.props.size,
      expected: "under 1 % of the source's active rows; red from 10 %",
      message: `${fmt(o.props.size)} properties carry values from this source that the client must refuse or mend (${fields}); ${fmt(active)} active rows.`,
      note: null,
      detail: { sample: o.sample },
    });
  }
  return out;
}

function meterCheck(input: HealthInput): CheckResult[] {
  if (!input.meter) return [];
  const { items, cap, periodStart } = input.meter;
  const used = cap > 0 ? items / cap : 1;
  const ours: Status = used >= 0.95 ? "red" : used >= 0.8 ? "amber" : "green";
  return [
    {
      key: "ours.v1_meter",
      label: LABELS["ours.v1_meter"],
      source: "stream-estate-v1",
      vault: null,
      ours,
      value: items,
      expected: "amber from 80 % of the cap; at the cap the pass stops and nothing new or expired arrives",
      message: `${fmt(items)} of ${fmt(cap)} items since ${periodStart.toISOString().slice(0, 10)} (${pct(used)}).`,
      note: null,
      detail: {},
    },
  ];
}

export function runPortalChecks(all: HealthInput): CheckResult[] {
  // Judged as of `now`, which `--as-of` can put in the past: what arrived since has not arrived yet.
  const input = { ...all, history: all.history.filter((h) => h.firstSeenAt.getTime() <= all.now.getTime()) };
  const totals = portalTotals(input);
  return [...feedChecks(input), ...runChecks(input), ...portalChecks(input, totals), ...qualityChecks(input, totals), ...feedQualityChecks(input), ...contractChecks(input), ...meterCheck(input)];
}

export type Tally = Record<Status, number> & { checks: number };

export function tally(results: CheckResult[], side: "vault" | "ours"): Tally {
  const t: Tally = { checks: 0, green: 0, amber: 0, red: 0, unknown: 0 };
  for (const r of results) {
    const s = r[side];
    if (s === null) continue;
    t.checks += 1;
    t[s] += 1;
  }
  return t;
}

export const overall = (results: CheckResult[], side: "vault" | "ours"): Status => worst(results.map((r) => r[side]).filter((s): s is Status => s !== null));

/** Vault fills a null from the portal's own label before it stores a row. Same here. */
export function propertyBedrooms(p: FeedProperty): number | null {
  return p.bedrooms ?? bedroomsFromLabels(p.listings);
}

/**
 * The feed's own listings as history rows, so a live property counts exactly as it is served.
 * `priceMissing`: by listing URL, why a page gave no price — the feed itself does not say.
 */
export function historyFromFeed(properties: FeedProperty[], priceMissing: ReadonlyMap<string, PriceMissing> = new Map()): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const p of properties) {
    const hasPhoto = !!p.imageUrl?.startsWith("https://") || p.imageUrls.some((u) => u.startsWith("https://"));
    const propertyHasBedrooms = propertyBedrooms(p) !== null;
    for (const l of p.listings) {
      if (!l.firstSeenAt) continue;
      rows.push({
        portal: l.source,
        propertyId: p.id,
        firstSeenAt: new Date(l.firstSeenAt),
        hasPrice: l.priceEur !== null,
        ...(l.priceEur === null && priceMissing.has(l.url) ? { priceMissing: priceMissing.get(l.url) } : {}),
        hasArea: l.areaM2 !== null,
        hasBedrooms: l.bedrooms !== null,
        propertyHasBedrooms,
        propertyType: p.propertyType,
        hasPhoto,
        hasCommune: p.communeInsee !== null,
      });
    }
  }
  return rows;
}
