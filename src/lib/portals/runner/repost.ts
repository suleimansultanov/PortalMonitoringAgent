/**
 * Pure half of the repost rule in ingest.ts (`findRepostOf`): a listing seen for
 * the first time that repeats an advert of the same source delisted within the
 * window takes over that advert's row. Here so it can be tested without a
 * database.
 */

/** How long a delisted advert can come back under a new id and still be itself. */
export const REPOST_WINDOW_DAYS = 14;

/**
 * What a repost keeps of the advert it repeats. Null when the agency, the title
 * or the price is missing: without all three a match is a guess.
 */
export function repostIdentity(
  i: { agencyId?: string | null; title?: string | null; priceEur?: number | null; areaM2?: string | null; communeInsee?: string | null },
): { agencyId: string; title: string; priceEur: number; areaM2: string | null; communeInsee: string | null } | null {
  const title = i.title?.trim();
  if (!i.agencyId || !title || i.priceEur === null || i.priceEur === undefined) return null;
  return { agencyId: i.agencyId, title: i.title!, priceEur: i.priceEur, areaM2: i.areaM2 ?? null, communeInsee: i.communeInsee ?? null };
}
