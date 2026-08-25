/**
 * Turning two states of a listing into a history.
 *
 * Pure and clock-injectable. Everything the Reports screen will ever claim is
 * derived from what this function decides, so it is worth being able to argue
 * with in a test rather than in production.
 */

export type ListingState = {
  priceEur: number | null;
  areaM2: number | null;
  rooms: number | null;
  availability: string | null;
  status: "active" | "delisted";
};

export type ListingEvent = {
  type: "listed" | "price_changed" | "delisted" | "relisted" | "availability_changed" | "updated";
  priceFrom?: number | null;
  priceTo?: number | null;
  payload?: Record<string, unknown>;
};

/**
 * A field that came back null from a parse is UNKNOWN, not CLEARED.
 *
 * This distinction is the whole reason this file is careful. When a portal
 * redesigns, a parser keeps returning rows — it just returns them with holes.
 * Treating those holes as real values writes "price removed" against nine
 * hundred listings, emits nine hundred false events, and poisons every metric
 * downstream. The events are append-only, so there is no clean way back.
 *
 * So: absent means leave it alone. Only a value that is present and different
 * counts as a change.
 */
function changed<T>(before: T | null, after: T | null): boolean {
  if (after === null) return false;
  if (before === null) return false;
  return before !== after;
}

export function computeEvents(
  before: ListingState | null,
  after: ListingState,
): ListingEvent[] {
  // Never seen before — one event, and nothing else is meaningful yet.
  if (before === null) {
    return [{ type: "listed", priceTo: after.priceEur }];
  }

  const events: ListingEvent[] = [];

  if (before.status === "active" && after.status === "delisted") {
    /**
     * Note what this does NOT say. It does not say sold. A listing disappears
     * when it sells, when the owner withdraws it, when the agency's
     * subscription lapses, and when it moves to a competitor. We saw it go;
     * that is the entire claim.
     */
    events.push({
      type: "delisted",
      priceFrom: before.priceEur,
      payload: { lastAvailability: before.availability },
    });
    return events;
  }

  if (before.status === "delisted" && after.status === "active") {
    events.push({ type: "relisted", priceTo: after.priceEur });
  }

  if (changed(before.priceEur, after.priceEur)) {
    const from = before.priceEur as number;
    const to = after.priceEur as number;
    events.push({
      type: "price_changed",
      priceFrom: from,
      priceTo: to,
      payload: {
        delta: to - from,
        // Rounded on the way in. A raw float here surfaces as -6.800000000000001
        // in the UI, and nobody trusts a number that looks like that.
        percent: Number((((to - from) / from) * 100).toFixed(2)),
        direction: to < from ? "down" : "up",
      },
    });
  }

  /**
   * Availability is the closest thing to an honest sold signal any portal
   * gives us — several publish schema.org `InStock`, so a transition away from
   * it is worth capturing even before we know what the other values look like.
   */
  if (changed(before.availability, after.availability)) {
    events.push({
      type: "availability_changed",
      payload: { from: before.availability, to: after.availability },
    });
  }

  // Material edits by the agency. Not interesting alone, but they explain why
  // a price per square metre moved without a price change.
  const edits: Record<string, unknown> = {};
  if (changed(before.areaM2, after.areaM2)) {
    edits.areaM2 = { from: before.areaM2, to: after.areaM2 };
  }
  if (changed(before.rooms, after.rooms)) {
    edits.rooms = { from: before.rooms, to: after.rooms };
  }
  if (Object.keys(edits).length > 0) {
    events.push({ type: "updated", payload: edits });
  }

  return events;
}

/**
 * Which fields of the stored row a fresh parse is allowed to overwrite.
 *
 * Same rule as above, applied to persistence rather than history: a null from
 * a degraded parse must not erase a value we already have. Better a stale
 * number than a hole — a stale number is wrong in a way someone notices.
 */
export function mergeParsed<T extends Record<string, unknown>>(
  existing: T,
  // Nulls are explicitly allowed in — dropping them is the entire job. A
  // `Partial<T>` signature would reject exactly the input this exists to handle.
  parsed: { [K in keyof T]?: T[K] | null },
): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(parsed) as (keyof T)[]) {
    const value = parsed[key];
    if (value === null || value === undefined) continue;
    if (existing[key] === value) continue;
    patch[key] = value as T[keyof T];
  }
  return patch;
}
