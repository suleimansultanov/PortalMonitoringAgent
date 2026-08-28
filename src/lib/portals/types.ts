/**
 * The adapter contract.
 *
 * Ten implementations, one interface. Everything downstream — diffing, storage,
 * deduplication, events, the product screens — is written against `RawListing`
 * and knows nothing about which portal produced it.
 *
 * TWO RULES THAT KEEP THIS HONEST
 *
 * 1. Adapters do not fetch. They are handed a `fetch` function that enforces the
 *    source's crawl delay, sets our user-agent, and records what was requested.
 *    An adapter reaching for the network directly would quietly bypass all
 *    three, and the first sign would be a portal blocking us.
 *
 * 2. Adapters do not normalise. They return what the page says — commune as
 *    written, price as published, agency name as spelled. Mapping to INSEE
 *    codes and canonical agencies happens once, centrally, in `normalize.ts`.
 *    Ten adapters each doing their own commune matching is ten places for
 *    Ramatuelle to end up filed under Saint-Tropez.
 */

/** What a listing page yields, before any normalisation. */
export type RawListing = {
  /** From the URL. Never from a `sku` field — see CLAUDE.md. */
  externalId: string;
  url: string;

  title: string | null;
  description: string | null;

  /**
   * The listing's main photograph, as the portal publishes it in `og:image`.
   *
   * We store the URL and hotlink it, rather than copying the file. Copying
   * would mean redistributing the agency's photography, which is theirs; a
   * link is what the portal publishes for exactly this purpose. It also means
   * a delisted property's image disappears on their schedule, not ours.
   */
  imageUrl: string | null;

  /**
   * The rest of the gallery, in the order the portal presents it.
   *
   * Scoped to THIS listing's gallery container, never scraped off the whole
   * page: a Superimmo detail page carries up to a hundred image URLs, and most
   * of them belong to the "similar properties" strip at the bottom. Taking them
   * all would put a neighbour's kitchen in this villa's gallery — wrong in a way
   * that looks completely fine until an agent shows a client.
   */
  imageUrls: string[];

  /**
   * Euros, from structured markup. Adapters must not read the rendered price:
   * at least one portal displays a converted USD figure over EUR source data,
   * which turns every exchange-rate move into a fake price change.
   */
  priceEur: number | null;

  areaM2: number | null;
  landM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  propertyType: string | null;

  /** As printed on the page. Mapped to an INSEE code later. */
  communeRaw: string | null;
  postalCode: string | null;

  /**
   * Only one portal publishes these and only to postcode precision. Captured
   * for display, never used for matching.
   */
  lat: number | null;
  lon: number | null;

  agencyName: string | null;
  agencyAddress: string | null;
  agencyPostalCode: string | null;
  agencyCity: string | null;
  agencyPhone: string | null;
  /** The agency's own mandate reference. The strongest cross-portal key we have. */
  agencyRef: string | null;

  availability: string | null;
  publishedAt: Date | null;
  sourceUpdatedAt: Date | null;

  /** Structured markup as extracted, so fields can be re-derived without refetching. */
  raw: Record<string, unknown>;
};

export type DiscoveredListing = {
  externalId: string;
  url: string;
  /** Commune as the discovery step understood it, for filtering before fetch. */
  communeHint?: string;
};

/**
 * Partial is a first-class outcome, not a soft failure.
 *
 * Several portals publish price and agency in their markup but leave floor area
 * only in prose. A listing with a price, an agency and no area is still worth
 * having — it deduplicates, it appears in Listings, it carries price history.
 * Refusing it because one field is missing would discard most of two portals.
 */
export type ParseResult =
  | { status: "ok"; listing: RawListing }
  | { status: "partial"; listing: RawListing; missing: string[] }
  | { status: "failed"; error: string };

/** Fetch provided by the runner: applies crawl delay, user-agent and logging. */
export type PoliteFetch = (url: string) => Promise<string>;

export type DiscoverContext = {
  fetch: PoliteFetch;
  /** INSEE codes the caller cares about. Adapters map these to their own slugs. */
  communeInsee: string[];
  /** Adapter-specific settings from `portal_sources.config`. */
  config: Record<string, unknown>;
};

export type PortalAdapter = {
  /** Matches `portal_sources.key`. */
  key: string;
  name: string;
  /** All hosts this adapter handles — one source is often several brands. */
  hosts: string[];
  discoveryMode: "sitemap" | "index";
  /** Taken from the portal's robots.txt. The runner honours it. */
  defaultCrawlDelayMs: number;

  /**
   * Enumerate what is live right now. Async iterable rather than an array so a
   * paginated crawl streams instead of buffering thousands of URLs, and so the
   * runner can stop early when a source is clearly misbehaving.
   */
  discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing>;

  /** Pure: HTML in, listing out. No network, no database, trivially testable. */
  parse(html: string, url: string): ParseResult;
};

/** Empty listing with the required identity fields, for adapters to fill in. */
export function emptyListing(externalId: string, url: string): RawListing {
  return {
    externalId,
    url,
    title: null,
    description: null,
    imageUrl: null,
    imageUrls: [],
    priceEur: null,
    areaM2: null,
    landM2: null,
    rooms: null,
    bedrooms: null,
    bathrooms: null,
    propertyType: null,
    communeRaw: null,
    postalCode: null,
    lat: null,
    lon: null,
    agencyName: null,
    agencyAddress: null,
    agencyPostalCode: null,
    agencyCity: null,
    agencyPhone: null,
    agencyRef: null,
    availability: null,
    publishedAt: null,
    sourceUpdatedAt: null,
    raw: {},
  };
}
