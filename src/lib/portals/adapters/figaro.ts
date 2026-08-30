import * as cheerio from "cheerio";
import {
  emptyListing,
  type DiscoverContext,
  type DiscoveredListing,
  type ParseResult,
  type PortalAdapter,
} from "../types";
import { extractJsonLd, firstOffer, nodesOfType, num, readAddress, str } from "../jsonld";
import { normaliseCommuneName, resolveCommune } from "../communes";
import { isPastLastPage } from "../runner/fetcher";

/**
 * Propriétés Le Figaro.
 *
 * The richest source in the project, and the only one that answers in data
 * rather than in prose. Their pages are server-rendered by Nuxt, and Nuxt ships
 * the state it rendered from in a `<script id="__NUXT_DATA__">` block. For a
 * listing page that state is the listing: price in euros as a number, the
 * INSEE code of the commune, the agency's own mandate reference, first
 * publication and last-edit timestamps, every photograph, the energy
 * certificate, and the full description.
 *
 * Four things follow from that, and each of them fixes a problem this project
 * has already had somewhere else:
 *
 * 1. **The commune arrives as an INSEE code.** Every other adapter matches a
 *    printed name and hopes the portal spells Sainte-Maxime the way we do.
 *    Here there is nothing to match — `location.inseeCode` is "83101".
 *
 * 2. **Dates.** `firstPublicationDate` and `updatedAt` make days-on-market and
 *    price history available from the first pass instead of from a month of
 *    our own observation. Only Superimmo has offered this before, and Superimmo
 *    costs about two minutes a listing.
 *
 * 3. **Price in euros, separately from the conversions.** Their page has a
 *    currency switch, and the payload carries `valueEUR`, `valueUSD` and
 *    `valueGBP` side by side. A parser reading the rendered figure would turn
 *    every exchange-rate move into a price change — which is the exact trap
 *    `types.ts` warns about, met in the wild for the first time.
 *
 * 4. **The photographs belong to this listing.** A detail page carries about
 *    thirty images, of which five are the property, one is the agency's logo
 *    and the rest are the "similar properties" strip — and several of those
 *    share this listing's title, so filtering on captions would not have
 *    worked. The payload lists this listing's twenty photographs under its own
 *    id, which settles it exactly rather than approximately.
 *
 * WHAT WE DO NOT TAKE. The payload publishes coordinates, and they are the
 * commune's centre rather than the property's: every Ramatuelle listing reads
 * 43.22 / 6.62, and the record says `hideCity: true` because the agency is
 * withholding the address. Stored, that would look like a location and would
 * merge every villa in the commune the first time anything compared distances.
 * So it is left out, deliberately, and this paragraph exists so nobody adds it
 * back in a fortnight thinking it was an oversight.
 *
 * ACCESS. robots.txt (read in full 2026-08-30) has one `User-agent: *` group.
 * It explicitly ALLOWS `/sitemap/plf-fr/`, the route this adapter takes. It
 * disallows `offset=`, `nb_par_page=`, `prix_min/max=`, `radius=`, `region=`,
 * `departement=`, `recherche=`, `type_bien=`, the photo `galerie` paths, and
 * `ville=` tokens beginning with a DIGIT — none of which we use. `?page=` is
 * not among them. Three crawlers are banned by name (The Knowledge AI, Uptime
 * Robot 2.0, Bytespider); we are none of them. No `Crawl-delay` is stated, so
 * the delay below is ours rather than theirs.
 *
 * A note on their WAF, because it has now caught us out on four portals: a
 * plain client gets 403 on every page here and a browser gets 200. That is why
 * `fetchMode: "browser"` is not optional for this source, and why "the probe
 * said no" is never the end of an investigation.
 */

/** `/annonces/villa-var-provence+alpes+cote+d+azur-france/103041455/` → `103041455` */
const ID_FROM_URL = /\/annonces\/[^/?#]+\/(\d{5,})\/?(?:$|[?#])/;

type FigaroCommuneConfig = { insee: string; ville: string; label: string };

export const figaroAdapter: PortalAdapter = {
  key: "figaro",
  name: "Propriétés Le Figaro",
  hosts: ["proprietes.lefigaro.fr", "properties.lefigaro.com"],
  discoveryMode: "index",
  /**
   * Ours, not theirs — their robots.txt asks for nothing. Two seconds is the
   * rate we would want a stranger to use on us, and these communes are small
   * enough that it costs minutes rather than hours.
   */
  defaultCrawlDelayMs: 2_000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const host = (ctx.config.host as string) ?? "https://proprietes.lefigaro.fr";
    const section = (ctx.config.section as string) ?? "immobilier";
    const region = (ctx.config.region as string) ?? "var-provence+alpes+cote+d+azur-france";
    const communes = (ctx.config.communes ?? []) as FigaroCommuneConfig[];
    const maxPages = (ctx.config.maxPages as number) ?? 60;

    for (const insee of ctx.communeInsee) {
      if (!communes.some((c) => c.insee === insee)) {
        console.warn(`[figaro] no commune configured for INSEE ${insee} — skipping`);
      }
    }

    /**
     * Run-level, not per-commune: Figaro promotes a listing onto the pages of
     * communes it does not belong to, so the same villa turns up under several
     * of ours. Yielding it once per commune would fetch it fourteen times for
     * no new data.
     */
    const yielded = new Set<string>();

    for (const c of communes.filter((x) => ctx.communeInsee.includes(x.insee))) {
      /** Every exit from the loop that is not "the results ran out". */
      let cutShort: string | null = null;
      let kept = 0;
      const strangers = new Map<string, number>();
      let stated: number | null = null;
      const seenOnPages = new Set<string>();
      /**
       * Which INSEE code counts as "here" on this commune's pages.
       *
       * Normally ours. It can be replaced by Figaro's own answer below, for the
       * districts — Port Grimaud and Les Issambres have their own `ville`
       * tokens but no INSEE code of their own, and if Figaro files either under
       * something other than its parent commune, their answer is the one that
       * describes the page in front of us.
       */
      let here = c.insee;

      for (let page = 1; page <= maxPages; page++) {
        const url = indexUrl(host, section, region, c.ville, page);

        let html: string;
        try {
          html = await ctx.fetch(url);
        } catch (err) {
          if (isPastLastPage(err) && page > 1) break;
          cutShort = isPastLastPage(err)
            ? `the commune URL is missing (${(err as Error).message}) — check the ville token`
            : `index page ${page} failed: ${(err as Error).message}`;
          console.warn(`[figaro] ${c.label}: ${cutShort}`);
          break;
        }

        const page1 = page === 1;
        const $ = cheerio.load(html);
        const payload = readPayload(html);
        const cards = cardsOnPage(html, host, $, payload);

        if (page1) {
          stated = statedCount(html);

          /**
           * Their own answer to "which commune did you understand?".
           *
           * A `ville` token Figaro does not recognise is not an error: the site
           * answers 200 with a department-wide result set. From the outside
           * that is indistinguishable from a commune with nothing for sale —
           * which is a believable thing for La Môle, and a catastrophic thing
           * to be wrong about, because everything collected there previously
           * gets delisted on the strength of it.
           *
           * The search location in the payload settles it against their answer
           * rather than against a heuristic of ours.
           */
          if (payload.searchInsee === "") {
            cutShort =
              `asked for "${c.ville}" and Figaro answered with the whole department ` +
              `(${payload.searchLabel ?? "no commune"}) — the ville token is not one they know`;
            console.warn(`[figaro] ${c.label}: ${cutShort}`);
            break;
          }

          /**
           * They know the token but file it under a different code. Reported
           * loudly and then followed, rather than treated as a failure: the
           * commune each listing ends up in is decided later, from the listing
           * itself, so trusting their answer here only changes which pages we
           * bother to read. Refusing it would drop a district we can see.
           */
          if (payload.searchInsee !== null && payload.searchInsee !== c.insee) {
            const note =
              `asked for "${c.ville}" expecting INSEE ${c.insee}, and Figaro files it ` +
              `under ${payload.searchInsee} (${payload.searchLabel ?? "unnamed"}) — ` +
              `following their answer, but check this`;
            console.warn(`[figaro] ${c.label}: ${note}`);
            cutShort ??= note;
            here = payload.searchInsee;
          }
        }

        /**
         * "Did this page add anything?" is answered on EVERY listing seen,
         * before any filtering.
         *
         * Etreproprio taught this the expensive way: when the counter only
         * advanced on listings we kept, a page made entirely of promoted
         * neighbours read as the end of the commune, and everything after it
         * was never discovered — then delisted for not being seen.
         */
        const fresh = cards.filter((card) => !seenOnPages.has(card.externalId));
        for (const card of fresh) seenOnPages.add(card.externalId);

        for (const card of fresh) {
          if (!belongsTo(card, here, c.label)) {
            const where = card.locality ?? card.insee ?? "(nowhere stated)";
            strangers.set(where, (strangers.get(where) ?? 0) + 1);
            continue;
          }
          kept++;
          if (yielded.has(card.externalId)) continue;
          yielded.add(card.externalId);
          yield { externalId: card.externalId, url: card.url, communeHint: c.label };
        }

        /**
         * They publish `<link rel="next">` and stop publishing it on the last
         * page. That is their own statement about their own pagination, which
         * beats inferring an ending from a page that looks empty — Green-Acres
         * answers page 999 with page one, and an inferred ending there was
         * wrong for weeks.
         */
        const hasNext = $('link[rel="next"]').attr("href");
        if (fresh.length === 0 || !hasNext) break;

        if (page === maxPages) {
          cutShort = `hit the ${maxPages}-page ceiling with a next-page link still published`;
          console.warn(`[figaro] ${c.label}: ${cutShort}`);
        }
      }

      if (strangers.size > 0) {
        const summary = [...strangers.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([where, n]) => `${where}×${n}`)
          .join(", ");
        console.log(`[figaro] ${c.label}: skipped ${summary} — promoted listings from elsewhere`);
      }

      /**
       * Zero kept where the page was not empty. With the search-location check
       * above this should be unreachable, which is exactly why it stays: it is
       * the backstop for the day their payload changes shape and that check
       * starts returning null.
       */
      if (!cutShort && kept === 0 && seenOnPages.size > 0) {
        cutShort =
          `${seenOnPages.size} listings on the page and none of them in ${c.label} — ` +
          `not an empty market, something is wrong with the query`;
        console.warn(`[figaro] ${c.label}: ${cutShort}`);
      }

      /**
       * The portal's own count, against ours.
       *
       * `offerCount` is what Figaro tells its own users this commune holds, so
       * a shortfall means we missed something rather than that the market
       * moved. Every other portal in this project has been verified by a human
       * opening the site and reading a heading; here the comparison happens on
       * every pass. A small gap is expected — their count includes promoted
       * cards we filtered out — so it only speaks up when the gap is big
       * enough to matter.
       */
      if (stated !== null && kept > 0 && kept < stated * 0.9) {
        const gap = `collected ${kept} of the ${stated} Figaro says are here`;
        console.warn(`[figaro] ${c.label}: ${gap}`);
        cutShort ??= gap;
      } else if (stated !== null) {
        console.log(`[figaro] ${c.label}: ${kept} collected, ${stated} stated by the portal`);
      }

      if (cutShort) ctx.incomplete(c.insee, cutShort);
    }
  },

  parse(html: string, url: string): ParseResult {
    const externalId = url.match(ID_FROM_URL)?.[1];
    if (!externalId) {
      return { status: "failed", error: `could not read a listing id out of ${url}` };
    }

    const $ = cheerio.load(html);
    if ($("body").text().replace(/\s+/g, " ").trim().length < 500) {
      return { status: "failed", error: "page has no body content" };
    }

    /**
     * The record whose id matches the URL — never simply the first one.
     *
     * A detail page carries about thirteen of these: this property and twelve
     * "similar properties", several of which share its title. Taking the first
     * would have been right on the fixture and wrong whenever their ordering
     * changed, silently, with a neighbour's price and a neighbour's photographs
     * under this listing's URL.
     */
    const record = readPayload(html).records.find((r) => r.id === externalId) ?? null;
    const nodes = extractJsonLd(html);
    const offer = nodesOfType(nodes, "Offer", "Product", "RealEstateListing")
      .map((n) => (n["@type"] === "Offer" ? n : firstOffer(n)))
      .find((n) => n && num(n.price) !== null) ?? null;

    const listing = emptyListing(externalId, url);

    // ── Price. Euros only, from data, never from the rendered figure ──────
    if (record?.priceEur !== null && record?.priceEur !== undefined) {
      listing.priceEur = Math.round(record.priceEur);
    } else if (offer) {
      const currency = str(offer.priceCurrency);
      const value = num(offer.price);
      if (value !== null && (currency === null || currency.toUpperCase() === "EUR")) {
        listing.priceEur = Math.round(value);
      }
    }

    // ── Where ─────────────────────────────────────────────────────────────
    listing.communeRaw =
      record?.city ??
      stripDepartment($(".ct-city").first().text()) ??
      stripDepartment(
        readAddress(nodesOfType(nodes, "SingleFamilyResidence")[0]?.address).locality,
      );
    listing.postalCode =
      record?.postalCode ??
      ($(".map-wrapper-inner strong").first().text().match(/\b(\d{5})\b/)?.[1] ?? null);
    // Coordinates deliberately omitted — see the note at the top of this file.

    // ── Size, rooms ───────────────────────────────────────────────────────
    listing.areaM2 = record?.areaM2 ?? specNumber($, "Surface");
    listing.landM2 = record?.landM2 ?? specNumber($, "Terrain");
    listing.rooms = record?.rooms ?? specNumber($, "Pièces");
    listing.bedrooms = record?.bedrooms ?? specNumber($, "Chambres");
    listing.bathrooms = record?.bathrooms ?? specNumber($, "Salles de bains");
    listing.propertyType = record?.propertyType ?? null;

    // ── Text ──────────────────────────────────────────────────────────────
    listing.title =
      record?.title ?? ($(".ct-title").first().text().replace(/\s+/g, " ").trim() || null);
    listing.description = record?.description ?? str(offer?.description);

    // ── Photographs ───────────────────────────────────────────────────────
    /**
     * The payload lists this listing's photographs under its own id, so they
     * are taken from there in preference to anything on the page: the page
     * server-renders five of twenty, and the rest of its images belong to the
     * "similar properties" strip and the agency's logo.
     */
    listing.imageUrls =
      record && record.pictures.length > 0 ? record.pictures : galleryFrom($);
    listing.imageUrl =
      $('meta[property="og:image"]').attr("content")?.trim() || listing.imageUrls[0] || null;

    // ── Agency, and the reference that deduplicates it ────────────────────
    listing.agencyName = record?.agencyName ?? null;
    listing.agencyAddress = record?.agencyAddress ?? null;
    listing.agencyPostalCode = record?.agencyPostalCode ?? null;
    listing.agencyCity = record?.agencyCity ?? null;
    if (!listing.agencyName) {
      /**
       * `offers.seller` first, then a `RealEstateAgent` node — and never a bare
       * `Organization`. The page carries one of those already and it is
       * Propriétés Le Figaro itself; taking it would file every listing on the
       * portal under a single agency called after the portal.
       */
      const seller =
        (offer?.seller && typeof offer.seller === "object"
          ? (offer.seller as Record<string, unknown>)
          : null) ?? nodesOfType(nodes, "RealEstateAgent").find((n) => str(n.name)) ?? null;
      if (seller && str(seller.name)) {
        listing.agencyName = str(seller.name);
        const a = readAddress(seller.address);
        listing.agencyAddress = a.street;
        listing.agencyPostalCode = a.postalCode;
        listing.agencyCity = a.locality;
      }
    }
    const phone = $('a[href^="tel:"]').first().attr("href");
    if (phone) listing.agencyPhone = phone.replace(/^tel:/, "").trim() || null;

    /**
     * `Référence annonceur` is the AGENCY's own mandate number and the exact
     * deduplication key. `Référence Propriétés Le Figaro` sits next to it and
     * is this portal's internal id — it means nothing anywhere else, and taking
     * the wrong one produces a key that silently never matches.
     */
    listing.agencyRef =
      record?.reference ?? ($(".cr-advertiser b").first().text().trim() || null);

    // ── Dates and availability ────────────────────────────────────────────
    listing.publishedAt = record?.publishedAt ?? null;
    listing.sourceUpdatedAt = record?.updatedAt ?? null;
    listing.availability =
      str(offer?.availability) ??
      (record?.isAvailable === null || record?.isAvailable === undefined
        ? null
        : record.isAvailable
          ? "InStock"
          : "SoldOut");

    listing.raw = {
      dpe: record?.dpe ?? null,
      ges: record?.ges ?? null,
      energyKwhM2Year: record?.energyKwh ?? null,
      ghgCo2M2Year: record?.ghgCo2 ?? null,
      ...(record?.insee ? { portalInsee: record.insee } : {}),
      ...(record?.estateType ? { estateType: record.estateType } : {}),
      ...(record?.condition ? { condition: record.condition } : {}),
      ...(record?.parking !== null && record?.parking !== undefined
        ? { parking: record.parking }
        : {}),
      ...(record?.options.length ? { flags: record.options } : {}),
      ...(record?.seller ? { seller: record.seller } : {}),
      ...(record?.pictureCount !== null && record?.pictureCount !== undefined
        ? { pictureCount: record.pictureCount }
        : {}),
      /** Whether the rich reading worked at all, so a shape change is visible in the data. */
      payload: record ? "read" : "missing",
    };

    const missing: string[] = [];
    if (listing.priceEur === null) missing.push("priceEur");
    if (listing.areaM2 === null) missing.push("areaM2");
    if (!listing.agencyName) missing.push("agencyName");
    if (!listing.communeRaw) missing.push("communeRaw");

    return missing.length === 0
      ? { status: "ok", listing }
      : { status: "partial", listing, missing };
  },
};

/**
 * `?ville=st+tropez` — spaces as `+`, and NOT percent-encoded.
 *
 * `encodeURIComponent` produces `st%20tropez`, which Figaro answers with a
 * department-wide page and a 200 rather than an error. The `+` spelling is
 * theirs, read off their own sitemap.
 */
export function indexUrl(
  host: string,
  section: string,
  region: string,
  ville: string,
  page: number,
): string {
  const token = ville.trim().replace(/\s+/g, "+");
  const base = `${host}/annonces/${section}-${region}/?ville=${token}`;
  return page > 1 ? `${base}&page=${page}` : base;
}

export type IndexCard = {
  externalId: string;
  url: string;
  /** The portal's own INSEE code, when the payload could be read. */
  insee: string | null;
  locality: string | null;
};

/** Does this card belong to the commune whose page we asked for? */
function belongsTo(card: IndexCard, insee: string, label: string): boolean {
  // The portal's own code, where we have it. Nothing to spell, nothing to match.
  if (card.insee) return card.insee === insee;
  if (!card.locality) return false;
  const resolved = resolveCommune(card.locality, null);
  if (resolved) return resolved.insee === insee;
  return normaliseCommuneName(card.locality).includes(normaliseCommuneName(label));
}

/**
 * The listings on one index page.
 *
 * Read from the Nuxt payload where it is available, because it carries the
 * INSEE code; from the JSON-LD graph where it is not, which still pairs each
 * URL with a locality; and from the anchors as a last resort. The last of the
 * three cannot tell whose commune a listing is in — which is why it degrades to
 * "found them but cannot place them" rather than to "this commune is empty".
 * The second of those delists.
 */
export function cardsOnPage(
  html: string,
  host: string,
  $?: cheerio.CheerioAPI,
  payload?: FigaroPayload,
): IndexCard[] {
  const data = payload ?? readPayload(html);
  const out = new Map<string, IndexCard>();

  for (const r of data.records) {
    if (!r.url) continue;
    out.set(r.id, { externalId: r.id, url: r.url, insee: r.insee, locality: r.city });
  }
  if (out.size > 0) return [...out.values()];

  for (const node of nodesOfType(
    extractJsonLd(html),
    "SingleFamilyResidence",
    "Apartment",
    "House",
    "Residence",
    "RealEstateListing",
  )) {
    const url = str(node.url);
    const id = url?.match(ID_FROM_URL)?.[1];
    if (!url || !id) continue;
    out.set(id, {
      externalId: id,
      url,
      insee: null,
      locality: stripDepartment(readAddress(node.address).locality),
    });
  }
  if (out.size > 0) return [...out.values()];

  const dom = $ ?? cheerio.load(html);
  dom('a[href*="/annonces/"]').each((_, el) => {
    const href = dom(el).attr("href");
    if (!href) return;
    const absolute = href.startsWith("http") ? href : new URL(href, host).toString();
    const id = absolute.match(ID_FROM_URL)?.[1];
    if (id && !out.has(id)) {
      out.set(id, { externalId: id, url: absolute, insee: null, locality: null });
    }
  });
  return [...out.values()];
}

/**
 * Figaro's own count for the query, out of the `AggregateOffer`.
 *
 * Returned rather than trusted blindly: it is their number for their index,
 * and their index includes whatever they promote into it.
 */
export function statedCount(html: string): number | null {
  for (const node of extractJsonLd(html)) {
    const count = num(firstOffer(node)?.offerCount);
    if (count !== null && count >= 0) return Math.round(count);
  }
  return null;
}

// ── The Nuxt payload ────────────────────────────────────────────────────────

export type FigaroRecord = {
  id: string;
  url: string | null;
  insee: string | null;
  city: string | null;
  postalCode: string | null;
  title: string | null;
  description: string | null;
  priceEur: number | null;
  areaM2: number | null;
  landM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  propertyType: string | null;
  estateType: string | null;
  condition: string | null;
  parking: number | null;
  options: string[];
  reference: string | null;
  agencyName: string | null;
  agencyAddress: string | null;
  agencyPostalCode: string | null;
  agencyCity: string | null;
  pictures: string[];
  pictureCount: number | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  isAvailable: boolean | null;
  seller: string | null;
  dpe: string | null;
  ges: string | null;
  energyKwh: number | null;
  ghgCo2: number | null;
};

export type FigaroPayload = {
  records: FigaroRecord[];
  /**
   * The commune Figaro understood the query to mean, from its own resolver.
   * `null` means they did not say; `""` means they said "the whole department",
   * which is their answer to a `ville` token they do not know.
   */
  searchInsee: string | null;
  searchLabel: string | null;
};

/**
 * Devalue's type wrappers, which are `[name, index]` pairs rather than arrays.
 *
 * Listed explicitly rather than sniffed. A plain array in this format holds
 * indices — numbers — so a leading string almost always means a wrapper; but
 * "almost always" is how a listing whose first field happened to be a string
 * would silently lose the rest of itself.
 */
const DEVALUE_WRAPPERS = new Set([
  "ShallowReactive",
  "Reactive",
  "Ref",
  "ShallowRef",
  "EmptyRef",
  "EmptyShallowRef",
  "Date",
  "Set",
  "Map",
  "BigInt",
  "RegExp",
  "URL",
  "URLSearchParams",
  "NuxtError",
  "Object",
]);

/**
 * Read the state Nuxt rendered the page from.
 *
 * The format is devalue's: one flat array where every value holds INDICES into
 * that same array instead of nested values, so an object shared by ten records
 * is stored once. Resolving it is a walk with a visited-set, because the graph
 * genuinely contains cycles.
 *
 * Written defensively throughout. This is their hydration state, not a
 * published interface — the day they change its shape, every reader here must
 * return null and let the JSON-LD and the DOM answer instead, rather than
 * throwing and losing the page.
 */
export function readPayload(html: string, $?: cheerio.CheerioAPI): FigaroPayload {
  const empty: FigaroPayload = { records: [], searchInsee: null, searchLabel: null };

  const dom = $ ?? cheerio.load(html);
  const raw = dom("#__NUXT_DATA__").first().contents().text().trim();
  if (!raw) return empty;

  let flat: unknown[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return empty;
    flat = parsed;
  } catch {
    return empty;
  }

  const resolve = (index: unknown, seen: ReadonlySet<number>): unknown => {
    if (typeof index !== "number" || index < 0 || index >= flat.length) return null;
    if (seen.has(index)) return null;
    const value = flat[index];
    if (value === null || typeof value !== "object") return value;
    const next = new Set(seen).add(index);
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === "string" && DEVALUE_WRAPPERS.has(value[0])) {
        return resolve(value[1], next);
      }
      return value.map((child) => resolve(child, next));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolve(child, next);
    }
    return out;
  };

  /**
   * Found by shape rather than by path. The payload's top-level key is a
   * per-request hash — `$fB2cqvgCnUHEz…` — so any path through it would be
   * correct exactly once.
   */
  const records: FigaroRecord[] = [];
  let searchInsee: string | null = null;
  let searchLabel: string | null = null;

  flat.forEach((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const keys = new Set(Object.keys(value as Record<string, unknown>));

    if (keys.has("id") && keys.has("location") && keys.has("property") && keys.has("medias")) {
      const record = toRecord(resolve(index, new Set()));
      if (record) records.push(record);
      return;
    }

    /**
     * The search location — the commune Figaro resolved the `?ville=` token to.
     * Told apart from a listing's location by `deptCode`, which only the
     * resolver's object carries.
     */
    if (searchInsee === null && keys.has("inseeCode") && keys.has("deptCode")) {
      const node = resolve(index, new Set()) as Record<string, unknown> | null;
      if (node) {
        /**
         * An EMPTY code is the important case, not a missing one: it is what
         * Figaro returns when it did not recognise the `ville` token and fell
         * back to the whole department. So "" is recorded as an answer rather
         * than discarded, and null continues to mean "they did not say".
         */
        searchInsee = str(node.inseeCode) ?? "";
        searchLabel = str(node.label) ?? str(node.cityLabel);
      }
    }
  });

  return { records, searchInsee, searchLabel };
}

function toRecord(node: unknown): FigaroRecord | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  const id = str(n.id);
  if (!id || !/^\d+$/.test(id)) return null;

  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

  const location = obj(n.location);
  const property = obj(n.property);
  const price = obj(n.price);
  const area = obj(n.area);
  const medias = obj(n.medias);
  const client = obj(n.client);
  const clientLocation = obj(client.location);
  const dpe = obj(n.dpe);

  const pictures: string[] = [];
  const rawPictures = Array.isArray(medias.pictures) ? medias.pictures : [];
  for (const picture of rawPictures) {
    const url = str(obj(picture).url);
    if (url && !pictures.includes(url)) pictures.push(url);
  }

  const rooms = Array.isArray(property.roomCount)
    ? num(property.roomCount[0])
    : num(property.roomCount);

  const options = Array.isArray(property.options)
    ? property.options.filter((o): o is string => typeof o === "string")
    : [];

  return {
    id,
    url: str(n.recordLinkFr),
    insee: str(location.inseeCode),
    // "Ramatuelle (83)" is `city`; `cityLabelFr` is the bare name we want.
    city: str(location.cityLabelFr) ?? stripDepartment(str(location.city)),
    postalCode: str(location.postalCode),
    title: str(n.titleFr),
    description: str(property.descriptionFr),
    /**
     * `valueEUR`, explicitly. `value` is whatever currency the visitor last
     * chose, and `valueUSD` and `valueGBP` sit beside it in the same object.
     */
    priceEur: num(price.valueEUR) ?? num(price.value),
    areaM2: num(area.value),
    landM2: num(area.ground),
    rooms: rooms !== null && rooms > 0 ? rooms : null,
    bedrooms: num(property.bedroomCount),
    bathrooms: num(property.bathroomCount),
    propertyType: str(property.superEstateType),
    estateType: str(property.estateType),
    condition: str(property.etatFr),
    parking: num(property.nbParking),
    options,
    reference: str(property.reference),
    agencyName: str(client.name) ?? str(client.brandName),
    agencyAddress: str(clientLocation.address),
    agencyPostalCode: str(clientLocation.postalCode),
    agencyCity: str(clientLocation.cityLabelFr) ?? stripDepartment(str(clientLocation.city)),
    pictures,
    pictureCount: num(medias.pictureCount),
    publishedAt: toDate(n.firstPublicationDate ?? n.createdAt),
    updatedAt: toDate(n.updatedAt),
    isAvailable: typeof n.isAvailable === "boolean" ? n.isAvailable : null,
    seller: str(n.origin),
    dpe: letter(dpe.energyConsumptionCategory),
    ges: letter(dpe.gesEmissionCategory),
    energyKwh: num(dpe.energyConsumption),
    ghgCo2: num(dpe.gesEmission),
  };
}

// ── Small readers ───────────────────────────────────────────────────────────

/** "Ramatuelle (83)" → "Ramatuelle". The department is not part of the name. */
function stripDepartment(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/\s*\(\d{2,3}\)\s*$/, "").replace(/\s+/g, " ").trim() || null;
}

function letter(v: unknown): string | null {
  const s = str(v)?.toUpperCase();
  return s && /^[A-G]$/.test(s) ? s : null;
}

function toDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A labelled figure out of the specification list, for when the payload is gone. */
function specNumber($: cheerio.CheerioAPI, label: string): number | null {
  let found: number | null = null;
  $(".spec-label").each((_, el) => {
    if (found !== null) return;
    if ($(el).text().replace(/\s+/g, " ").trim().toLowerCase() !== label.toLowerCase()) return;
    const value = num($(el).next(".spec-value").text());
    if (value !== null && value > 0) found = value;
  });
  return found;
}

/**
 * The gallery, from the DOM, for when the payload cannot be read.
 *
 * Scoped to the gallery container and the hero image, and to nothing else. A
 * detail page carries about thirty photographs of which five are this
 * property; the rest are the "similar properties" strip and the agency's logo,
 * and several of the strip's images carry THIS listing's title in their alt
 * text — so the scoping has to be structural. Filtering on captions would have
 * put a neighbour's villa in this gallery and looked entirely fine doing it.
 */
function galleryFrom($: cheerio.CheerioAPI): string[] {
  const photos: string[] = [];
  $(".container-main-img img[src], .container-gallery-images img[src]").each((_, el) => {
    const src = $(el).attr("src")?.trim();
    if (!src || !/googleusercontent\.com/i.test(src)) return;
    // Their CDN appends a size suffix; the same photograph arrives twice at
    // two sizes between the hero and the tiles.
    const base = src.split("=")[0];
    if (!photos.some((p) => p.split("=")[0] === base)) photos.push(src);
  });
  return photos;
}
