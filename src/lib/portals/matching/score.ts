import { containment, similarity } from "./text";

/**
 * Deciding whether two listings are one property.
 *
 * Pure and deterministic. Every merge this produces is written to the database
 * with its score and the signals behind it, because "why did you decide these
 * two are the same house" has to have an answer — and because a wrong merge is
 * only fixable if you can see what caused it.
 */

export type Candidate = {
  id: string;
  sourceId: string;
  communeInsee: string | null;
  priceEur: number | null;
  areaM2: number | null;
  rooms: number | null;
  agencyId: string | null;
  agencyRef: string | null;
  title: string | null;
  description: string | null;
};

export type MatchSignals = {
  agencyRefExact?: boolean;
  agencyRefConflict?: boolean;
  textContainment?: number;
  textJaccard?: number;
  priceEqual?: boolean;
  priceDelta?: number;
  areaClose?: boolean;
  roomsEqual?: boolean;
  communeConflict?: boolean;
};

export type MatchVerdict = {
  same: boolean;
  confidence: number;
  signals: MatchSignals;
};

/** Portals round floor area differently — 240,62 becomes 241 or 240. */
const AREA_TOLERANCE = 0.03;
/** Below this, no amount of corroboration makes two listings the same property. */
const TEXT_FLOOR = 0.45;
/** Above this, the same prose is the same listing. */
const TEXT_STRONG = 0.75;

export function scoreMatch(a: Candidate, b: Candidate): MatchVerdict {
  const signals: MatchSignals = {};

  // ── 1. The exact key, when both sides have it ──────────────────────────
  if (a.agencyId && b.agencyId && a.agencyId === b.agencyId && a.agencyRef && b.agencyRef) {
    if (a.agencyRef.trim().toLowerCase() === b.agencyRef.trim().toLowerCase()) {
      signals.agencyRefExact = true;
      return { same: true, confidence: 1, signals };
    }
    /**
     * Same agency, different mandate numbers. That is the agency itself telling
     * us these are two properties, and it outranks any amount of shared prose —
     * agencies reuse whole paragraphs between neighbouring villas.
     */
    signals.agencyRefConflict = true;
    return { same: false, confidence: 0, signals };
  }

  // ── 2. Cheap vetoes ────────────────────────────────────────────────────
  if (a.communeInsee && b.communeInsee && a.communeInsee !== b.communeInsee) {
    signals.communeConflict = true;
    return { same: false, confidence: 0, signals };
  }

  // ── 3. Text ────────────────────────────────────────────────────────────
  const textA = [a.title, a.description].filter(Boolean).join(" ");
  const textB = [b.title, b.description].filter(Boolean).join(" ");

  /**
   * Containment, not Jaccard, is the deciding number. Portals truncate the
   * agency's text at different lengths, and Jaccard reads a truncation as a
   * disagreement. Jaccard is still recorded — it is the better description of
   * how alike two full texts are, and worth having when reviewing a merge.
   */
  const cont = containment(textA, textB);
  const jac = similarity(textA, textB);
  signals.textContainment = round(cont);
  signals.textJaccard = round(jac);

  if (cont < TEXT_FLOOR) return { same: false, confidence: round(cont), signals };

  // ── 4. Corroboration ───────────────────────────────────────────────────
  let support = 0;

  if (a.priceEur !== null && b.priceEur !== null) {
    const delta = Math.abs(a.priceEur - b.priceEur) / Math.max(a.priceEur, b.priceEur);
    signals.priceDelta = round(delta);
    signals.priceEqual = a.priceEur === b.priceEur;

    if (a.priceEur === b.priceEur) support += 0.15;
    else if (delta <= 0.02) support += 0.08;
    /**
     * A price disagreement does NOT veto. Agencies update one portal and forget
     * another routinely, so the same villa genuinely sits at two prices for
     * weeks. Vetoing on price would split exactly the properties whose price
     * history we most want — the ones being repriced.
     */
    else if (delta > 0.25) support -= 0.1;
  }

  if (a.areaM2 !== null && b.areaM2 !== null) {
    const delta = Math.abs(a.areaM2 - b.areaM2) / Math.max(a.areaM2, b.areaM2);
    signals.areaClose = delta <= AREA_TOLERANCE;
    if (signals.areaClose) support += 0.1;
    else if (delta > 0.15) support -= 0.1;
  }

  if (a.rooms !== null && b.rooms !== null) {
    signals.roomsEqual = a.rooms === b.rooms;
    support += a.rooms === b.rooms ? 0.05 : -0.05;
  }

  const confidence = clamp(cont + support);

  /**
   * Strong prose alone is enough. Below that, something else has to agree —
   * which is what keeps two neighbouring villas sharing an agency's stock
   * paragraph from merging into one.
   */
  const same = cont >= TEXT_STRONG ? confidence >= 0.7 : confidence >= 0.8;

  return { same, confidence: round(confidence), signals };
}

/**
 * Which pairs are worth scoring at all.
 *
 * Comparing every listing to every other is quadratic, and at a few thousand
 * listings across thirteen portals that is millions of shingle comparisons a
 * night. Blocking cuts it to pairs that could plausibly match: same commune, or
 * one of them unplaced.
 */
export function blockKey(c: Candidate): string {
  return c.communeInsee ?? "unknown";
}

export function candidatePairs(candidates: Candidate[]): [Candidate, Candidate][] {
  const blocks = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = blockKey(c);
    const list = blocks.get(key);
    if (list) list.push(c);
    else blocks.set(key, [c]);
  }

  const unknown = blocks.get("unknown") ?? [];
  const pairs: [Candidate, Candidate][] = [];

  for (const [key, list] of blocks) {
    // Everything inside a commune against everything else inside it.
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) pairs.push([list[i], list[j]]);
    }
    // Unplaced listings are compared against every commune, because "unknown"
    // is a parse gap, not a location.
    if (key !== "unknown") {
      for (const u of unknown) for (const c of list) pairs.push([u, c]);
    }
  }

  return pairs;
}

/**
 * Union-find over the pairs that matched.
 *
 * Transitivity matters here: if A matches B and B matches C, all three are one
 * property even when A and C never scored above the threshold themselves —
 * which happens when one portal truncated the description and another rewrote
 * the title.
 */
export function cluster(
  ids: string[],
  matches: [string, string][],
): Map<string, string> {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression, so repeated lookups stay flat.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  for (const [a, b] of matches) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const out = new Map<string, string>();
  for (const id of ids) out.set(id, find(id));
  return out;
}

function round(n: number): number {
  return Number(n.toFixed(3));
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
