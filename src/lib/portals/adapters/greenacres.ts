import * as cheerio from "cheerio";
import {
  emptyListing,
  type DiscoverContext,
  type DiscoveredListing,
  type ParseResult,
  type PortalAdapter,
  type RawListing,
} from "../types";
import { num } from "../jsonld";

/**
 * Green-Acres.
 *
 * The most openly published source of the fourteen. Their robots.txt allows
 * everything except a handful of internal AJAX endpoints, asks for a one-second
 * crawl delay, and points at a sitemap — and unlike five of the other portals,
 * their index pages are actually served to us rather than returning 403.
 *
 * It is also the only source that carries La Môle, La Garde-Freinet and
 * Le Plan-de-la-Tour, the three Superimmo has no page for. The two portals
 * cover each other's gaps, which is why both are worth running even where the
 * stock overlaps.
 *
 * WHAT IT DOES NOT HAVE: dates. No publication date, no last-modified on the
 * listing itself. Days-on-market and price cuts here come from our own
 * observation history, first seen to last seen — which means this source needs
 * a few weeks of runs before its Reports numbers mean anything, while Superimmo
 * is useful from day one.
 *
 * OBFUSCATED LINKS
 *
 * Card links are not `href`s. Each card is a `div.announce-card.obf-link`
 * carrying `data-advertid` and `data-o`, where `data-o` is the base64 of the
 * listing URL. The site's own JavaScript decodes it on click.
 *
 * This is not an access control — no login, no token, no challenge, and the
 * listing pages it points at are explicitly permitted by their robots.txt,
 * which is the site's formal statement about what crawlers may read. The
 * obfuscation reads as SEO hygiene: keeping outbound link equity out of the
 * markup and discouraging naive scrapers.
 *
 * Recording it anyway, because it is the kind of thing that should be a
 * decision rather than an assumption. If Green-Acres would rather we did not
 * enumerate, the honest route is `permission_note` and a conversation, not a
 * cleverer parser.
 */

/** `/fr/properties/maison/ramatuelle/Amfhgmt9hjtzqghr.htm` → `Amfhgmt9hjtzqghr` */
const ID_FROM_URL = /\/fr\/properties\/[^/]+\/[^/]+\/([A-Za-z0-9]+)\.htm/i;

/** `.../{type}/{commune}/{id}.htm` — both segments are useful. */
const TYPE_AND_COMMUNE = /\/fr\/properties\/([^/]+)\/([^/]+)\//i;

export const greenAcresAdapter: PortalAdapter = {
  key: "green-acres",
  name: "Green-Acres",
  hosts: ["green-acres.fr", "www.green-acres.fr"],
  discoveryMode: "index",
  /** Their robots.txt: `Crawl-delay: 1`, `Request-rate: 1/1`. */
  defaultCrawlDelayMs: 1_000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const host = (ctx.config.host as string) ?? "https://www.green-acres.fr";
    const communes = (ctx.config.communes ?? []) as {
      insee: string;
      slug: string;
      label: string;
    }[];
    const maxPages = (ctx.config.maxPages as number) ?? 20;
    /**
     * Their pagination parameter, read off the hidden `p_n` field in their own
     * search form. `?page=2` is silently ignored and returns page one — which
     * would look like "this commune only ever has 24 listings" rather than like
     * a bug, so the pass verifies it moved rather than trusting it.
     */
    const pageParam = (ctx.config.pageParam as string) ?? "p_n";

    for (const insee of ctx.communeInsee) {
      if (!communes.some((c) => c.insee === insee)) {
        console.warn(`[green-acres] no commune configured for INSEE ${insee} — skipping`);
      }
    }

    for (const c of communes.filter((x) => ctx.communeInsee.includes(x.insee))) {
      const seen = new Set<string>();

      for (let page = 1; page <= maxPages; page++) {
        const base = `${host}/immobilier/${c.slug}`;
        const url = page === 1 ? base : `${base}?${pageParam}=${page}`;

        let html: string;
        try {
          html = await ctx.fetch(url);
        } catch (err) {
          console.warn(`[green-acres] index fetch failed ${url}:`, (err as Error).message);
          break;
        }

        const cards = cardsOnPage(html, host);
        const fresh = cards.filter((x) => !seen.has(x.url));

        /**
         * Every card already seen means pagination did not move.
         *
         * Worth distinguishing from an empty page: an empty page is the end of
         * the results, whereas the same page served twice means the parameter
         * name is wrong and everything past the first 24 listings is invisible.
         * Silent truncation is the worse of the two, so it gets a warning.
         */
        if (fresh.length === 0) {
          if (page > 1 && cards.length > 0) {
            console.warn(
              `[green-acres] ${c.slug}: page ${page} repeated page ${page - 1} — ` +
                `pagination parameter '${pageParam}' is not taking effect, ` +
                `so only the first ${seen.size} listings of this commune are visible`,
            );
          }
          break;
        }

        for (const card of fresh) {
          seen.add(card.url);
          yield { externalId: card.id, url: card.url, communeHint: c.slug };
        }
      }
    }
  },

  parse(html: string, url: string): ParseResult {
    const externalId = url.match(ID_FROM_URL)?.[1];
    if (!externalId) {
      return { status: "failed", error: `could not read a listing id out of ${url}` };
    }

    const $ = cheerio.load(html);
    const text = $("body").text().replace(/\s+/g, " ").trim();
    if (text.length < 500) {
      return { status: "failed", error: "page has no body content" };
    }

    const listing = emptyListing(externalId, url);

    // ── Title and description ─────────────────────────────────────────────
    // From Open Graph rather than the rendered heading: the h1 on these pages
    // is decorated with the agency name and the commune, and og: is what they
    // hand to every other consumer of the page.
    listing.title = meta($, "og:title");
    listing.description = meta($, "og:description");
    listing.imageUrl = meta($, "og:image");

    /**
     * The gallery, scoped by the listing's OWN id.
     *
     * Green-Acres puts the id in every one of its photo paths —
     * `.../Ac7eps154xfearb8/Photos/Ac7eps154xfearb8_1.jpg` — which makes the
     * filter exact and free. A detail page carries 25–55 image URLs and a good
     * share of them belong to the "similar properties" strip; taken wholesale
     * they would put a neighbour's kitchen in this villa's gallery, which looks
     * perfectly fine right up until an agent shows a client.
     */
    listing.imageUrls = galleryFor(html, externalId);

    // ── Price ─────────────────────────────────────────────────────────────
    /**
     * Two prices sit next to each other: the asking price and price per m².
     * Reading the first `… €` on the page gets the per-m² figure about as often
     * as not, and a villa priced at 41 736 € looks plausible enough to survive
     * review. So: the dedicated element, and never a bare text scan.
     */
    const priceText = firstText($, ".price-detail, .price-container, .sticky-price");
    listing.priceEur = toInt(priceText);

    /**
     * "Prix sur demande" is information, not a parse failure.
     *
     * Nine of 159 in Ramatuelle withhold the price — normal at the top of this
     * market. Both cases leave `priceEur` null, but they mean opposite things:
     * one is the agency choosing not to publish, the other is our parser
     * missing. Without this flag the quality report cannot tell them apart, and
     * the screen has to print "—" where it should print "on request".
     */
    const onRequest = priceText !== null && listing.priceEur === null;

    // ── Size, rooms ───────────────────────────────────────────────────────
    // Keyed off their icon classes, which name the thing they label
    // (`icon-habitablesurface`, `icon-landsurface`). Living area and land area
    // are both "N m²" in the text, so anything positional would mix them up.
    //
    // Each field lists the icon names it may appear under, because the page
    // renders the same facts in three layouts and they do not use one name
    // throughout — rooms are `icon-advertrooms` in the spec list and
    // `icon-room` in the summary pills.
    listing.areaM2 = surface(byIcon($, ["habitablesurface", "advertsurface"]));
    listing.landM2 = surface(byIcon($, ["landsurface"]));
    listing.rooms = count(byIcon($, ["advertrooms", "room"]));
    listing.bedrooms = count(byIcon($, ["advertbedrooms", "bedroom"]));

    // ── Where ─────────────────────────────────────────────────────────────
    // The commune is in the URL, which is more reliable than the page prose —
    // listings routinely name a beach or a hamlet in the heading.
    const path = url.match(TYPE_AND_COMMUNE);
    if (path) {
      listing.propertyType = capitalise(decodeURIComponent(path[1]));
      listing.communeRaw = titleCase(decodeURIComponent(path[2]).replace(/-/g, " "));
    }

    /**
     * Coordinates come from their inline `advert` object, and their own flag
     * says whether they mean it: `precise: false` marks an approximated point,
     * which several portals use to avoid publishing an exact address. Storing
     * an approximation as if it were exact would put pins in the wrong field.
     */
    const coords = coordinates(html);
    if (coords) {
      listing.lat = coords.lat;
      listing.lon = coords.lon;
    }

    // ── Agency ────────────────────────────────────────────────────────────
    /**
     * `.agency-detail` — name, street, postcode and town, as text.
     *
     * The first version of this read the alt text of the agency logo, which is
     * present on only 82 of 159 real pages: agency came back null for 48% of a
     * full commune. The block below is on ALL of them, and carries more besides.
     *
     * Worth stating the lesson, because it has now happened twice in this
     * adapter: both times the page had a second layout that the one page I
     * looked at did not use, and both times the miss was invisible in the data
     * — a null that reads as "this listing has no agency" rather than as "the
     * parser was written against one example".
     */
    const page = agencyPage($);
    const detail = agencyDetail($);

    listing.agencyName =
      detail.name ??
      $(".title-agency img").first().attr("alt")?.replace(/\s+/g, " ").trim() ??
      (page?.slug ? titleCase(page.slug.replace(/-/g, " ")) : null);

    listing.agencyAddress = detail.street;
    listing.agencyPostalCode = detail.postalCode;
    listing.agencyCity = detail.city;

    /**
     * `Référence` is the agency's own mandate number and the strongest
     * cross-portal deduplication key we have — the same string turns up on
     * Superimmo under `Réf. agence` for the same property.
     */
    listing.agencyRef = labelled($, "Référence");

    listing.raw = {
      priceOnRequest: onRequest,
      fees: labelled($, "Honoraires"),
      /**
       * Their internal city id, from the same inline object. Kept because it is
       * a clean per-commune key if we ever need to talk to them about coverage
       * — but never used for our own commune resolution, which goes through
       * INSEE like every other source.
       */
      cityId: html.match(/cityId:\s*(\d+)/)?.[1] ?? null,
      coordinatesPrecise: coords?.precise ?? null,
      agencyPageId: page?.id ?? null,
      /** Kept so a name reconstructed from the slug can be audited, not trusted. */
      agencySlug: page?.slug ?? null,
      agencyNameFromSlug: !$(".title-agency img").first().attr("alt"),
    };

    /**
     * No `publishedAt`, no `sourceUpdatedAt` — deliberately left null rather
     * than filled with the crawl time. A null here means "we do not know", and
     * `computeEvents` treats it that way; a crawl timestamp would masquerade as
     * a publication date and make every listing look new on the day we first
     * saw it.
     */

    const missing: string[] = [];
    if (listing.priceEur === null) missing.push("priceEur");
    if (listing.areaM2 === null) missing.push("areaM2");
    if (!listing.agencyName) missing.push("agencyName");

    return missing.length === 0
      ? { status: "ok", listing }
      : { status: "partial", listing, missing };
  },
};

/**
 * Read the listing cards off an index page.
 *
 * `data-o` holds the base64 of the URL. `data-advertid` holds the id on its
 * own, so the id never depends on the decode succeeding — a card whose payload
 * is malformed is skipped rather than yielding a broken URL that would 404 and
 * count as a failure.
 */
function cardsOnPage(html: string, host: string): { id: string; url: string }[] {
  const $ = cheerio.load(html);
  const out: { id: string; url: string }[] = [];
  const seen = new Set<string>();

  $("[data-advertid]").each((_, el) => {
    const id = $(el).attr("data-advertid");
    const payload = $(el).attr("data-o");
    if (!id || !payload || seen.has(id)) return;

    const decoded = decodeBase64(payload);
    if (!decoded) return;

    let url: string;
    try {
      url = new URL(decoded, host).toString();
    } catch {
      return;
    }
    // Cards for saved searches and adverts elsewhere on the page carry the same
    // attributes; only listing URLs are wanted.
    if (!ID_FROM_URL.test(url)) return;

    seen.add(id);
    out.push({ id, url });
  });

  return out;
}

function decodeBase64(raw: string): string | null {
  try {
    // Padding is stripped in their markup; Buffer tolerates that, but being
    // explicit costs nothing and makes the intent readable.
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const out = Buffer.from(padded, "base64").toString("utf8");
    return out.includes("�") ? null : out;
  } catch {
    return null;
  }
}

/**
 * Every photo whose path carries this listing's id, in numeric order.
 *
 * Sorted by the `_N` suffix rather than by document order: the same image
 * appears several times on the page at different sizes and in different
 * carousels, so document order is really "whatever the template did".
 */
function galleryFor(html: string, externalId: string): string[] {
  const escaped = externalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `https://lb\\d+\\.green-acres\\.com/[^"'\\s)\\\\]*${escaped}[^"'\\s)\\\\]*\\.(?:jpg|jpeg|png|webp)`,
    "gi",
  );
  const seen = new Set(html.match(pattern) ?? []);
  return [...seen].sort((a, b) => order(a) - order(b));
}

function order(url: string): number {
  const n = url.match(/_(\d+)\.(?:jpg|jpeg|png|webp)$/i)?.[1];
  return n ? Number(n) : 9999;
}

function meta($: cheerio.CheerioAPI, property: string): string | null {
  const v = $(`meta[property="${property}"]`).attr("content");
  return v?.replace(/\s+/g, " ").trim() || null;
}

function firstText($: cheerio.CheerioAPI, selector: string): string | null {
  const t = $(selector).first().text().replace(/\s+/g, " ").trim();
  return t || null;
}

/**
 * Read the value an icon labels.
 *
 * The `<em>` carrying the icon class is EMPTY — it is a font glyph, not a
 * container. The value sits in a sibling block:
 *
 *     <div class="icon-container"><em class="icons icon-advertrooms"></em></div>
 *     <div class="description"><p>8 pièces</p></div>
 *
 * so reading the `<em>`, or even its immediate parent, yields nothing. This
 * walks up until an ancestor has text, which handles all three of their
 * layouts: the summary pills (value is a sibling span), the spec list (value is
 * in an uncle div), and the white feature strip.
 *
 * The climb is capped at four levels. Without a cap it would eventually reach
 * `<body>` and return the whole page, and `num()` would pull some unrelated
 * figure out of it — a wrong number that looks entirely plausible, which is the
 * failure mode that survives review longest.
 */
function byIcon($: cheerio.CheerioAPI, icons: string[]): string | null {
  for (const icon of icons) {
    const matches = $(`em[class*="icon-${icon}"]`);
    for (let i = 0; i < matches.length; i++) {
      let node = matches.eq(i).parent();
      for (let depth = 0; depth < 4 && node.length > 0; depth++) {
        const text = node.text().replace(/\s+/g, " ").trim();
        if (/\d/.test(text)) return text;
        node = node.parent();
      }
    }
  }
  return null;
}

/**
 * A surface in square metres, from a string that may be in hectares.
 *
 * Green-Acres switches unit once a plot passes a hectare: "6 600 m² de terrain"
 * but "1,1 ha". Read as a plain number that becomes **1.1 m²** — a ten-thousand-
 * fold error on exactly the listings where land matters most, and one that never
 * shows up in a missing-field report because the field is populated. It would
 * have surfaced as an estate with a garden the size of a bath mat, months later,
 * in front of the client.
 *
 * The French decimal comma matters here too: "1,1 ha" is 11 000 m², not 11 m².
 * `num()` already handles the comma; this only has to apply the multiplier.
 */
function surface(raw: string | null): number | null {
  if (!raw) return null;
  const value = num(raw);
  if (value === null) return null;
  // Word boundary: "ha" must be a unit, not the start of "habitable".
  const hectares = /\bha\b/i.test(raw);
  return hectares ? Math.round(value * 10_000) : value;
}

/**
 * A count out of a labelled string like "8 pièces" or "Chambres 7".
 *
 * Zero is rejected rather than stored: portals print "0 pièces" when the agency
 * supplied nothing, and a stored nought drags down every average and makes a
 * villa look like it has no rooms.
 */
function count(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw.match(/\d+/)?.[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `<label>Référence</label><p>stz260427</p>` */
function labelled($: cheerio.CheerioAPI, label: string): string | null {
  let found: string | null = null;
  $("label").each((_, el) => {
    if (found) return;
    if ($(el).text().replace(/\s+/g, " ").trim() !== label) return;
    const v = $(el).next("p").text().replace(/\s+/g, " ").trim();
    if (v) found = v;
  });
  return found;
}

function coordinates(html: string): { lat: number; lon: number; precise: boolean } | null {
  const lat = html.match(/latitude:\s*(-?[\d.]+)/)?.[1];
  const lon = html.match(/longitude:\s*(-?[\d.]+)/)?.[1];
  if (!lat || !lon) return null;
  return {
    lat: Number(lat),
    lon: Number(lon),
    precise: /precise:\s*true/.test(html),
  };
}

/**
 * The seller block, which every listing has:
 *
 *     <div class="agency-detail">
 *       <span class="seller-name">Magrey &amp; Sons Saint Tropez</span>
 *       <p>Agence</p>
 *       <p>56 Boulevard Louis Blanc</p>
 *       <p>83990 Saint-Tropez</p>
 *     </div>
 *
 * The paragraphs are positional and routinely empty — plenty of agencies fill in
 * a name and nothing else — so each is taken for what it looks like rather than
 * for where it sits.
 */
function agencyDetail($: cheerio.CheerioAPI): {
  name: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
} {
  const block = $(".agency-detail").first();
  const empty = { name: null, street: null, postalCode: null, city: null };
  if (block.length === 0) return empty;

  const raw = block.find(".seller-name").first().text().replace(/\s+/g, " ").trim();
  /**
   * At least one listing has "-" as the seller name. Stored, it becomes an
   * agency called "-" that every other nameless listing then merges into,
   * inventing a competitor with a portfolio. A name needs at least two word
   * characters to be a name.
   */
  const name = /[\p{L}\p{N}]{2}/u.test(raw) ? raw : null;

  const paragraphs = block
    .find("p")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean)
    // "Agence" is the seller TYPE, printed for every agency listing. Taken as a
    // street it would give six thousand agencies the same address.
    .filter((t) => !/^(agence|particulier|propriétaire)$/i.test(t));

  const postal = paragraphs.find((p) => /\b\d{5}\b/.test(p)) ?? null;
  const street = paragraphs.find((p) => p !== postal) ?? null;

  const postalCode = postal?.match(/\b(\d{5})\b/)?.[1] ?? null;
  const city = postal ? postal.replace(/\b\d{5}\b/, "").trim() || null : null;

  return { name, street, postalCode, city };
}

/**
 * The agency's slug and page id, out of the obfuscated link on its logo:
 * `/fr/agence/savills-…-saint-tropez/UiqpGAqTFAiN`.
 *
 * The id is stable across listings and across renames, so it is a better agency
 * key than the display name — "Savills French Riviera" and "Savills French
 * Riviera & French Alps" are the same office spelled two ways, and grouping by
 * name would report one competitor as two.
 */
function agencyPage($: cheerio.CheerioAPI): { slug: string; id: string } | null {
  const payload = $(".title-agency").first().attr("data-o");
  if (!payload) return null;
  const decoded = decodeBase64(payload);
  const m = decoded?.match(/\/fr\/agence\/([^/]+)\/([A-Za-z0-9]+)/);
  return m ? { slug: m[1], id: m[2] } : null;
}

function toInt(raw: string | null): number | null {
  if (!raw) return null;
  const n = num(raw);
  return n === null ? null : Math.round(n);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function titleCase(s: string): string {
  return s.replace(/\b[a-zà-ÿ]/g, (c) => c.toUpperCase());
}

export type { RawListing };
