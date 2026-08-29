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
 * Superimmo.
 *
 * The most valuable source on the list, and the reason is two fields nobody
 * else publishes: **the date a listing went up and the date it was last
 * edited**, printed on every page. Everywhere else, days-on-market and price
 * cuts have to be inferred from weeks of our own observation. Here they are
 * available from the first run.
 *
 * It also prints `Réf. agence` — the agency's own mandate number — which is the
 * exact key deduplication wants, and which turns up on unrelated portals for
 * the same property.
 *
 * The cost: none of this is in structured markup. Every field below comes off
 * the rendered page, so this adapter is the most exposed to a redesign of any
 * we have. Matching is done on labels rather than class names, which survives a
 * restyle; a change to the wording will not.
 */

/** `/annonces/achat-maison-160m-saint-tropez-83990-x10ewng` → `x10ewng` */
const ID_FROM_URL = /\/annonces\/[a-z0-9-]*-(\w+)(?:$|[?#])/i;
const LISTING_PATH = /\/annonces\/achat-/i;

export const superimmoAdapter: PortalAdapter = {
  key: "superimmo",
  name: "Superimmo",
  hosts: ["superimmo.com", "www.superimmo.com"],
  discoveryMode: "index",
  /** Their robots.txt asks named crawlers for 10s. We are not named, but asked is asked. */
  defaultCrawlDelayMs: 10_000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const host = (ctx.config.host as string) ?? "https://www.superimmo.com";
    const communes = (ctx.config.communes ?? []) as {
      insee: string;
      slug: string;
      postcode: string;
    }[];
    const maxPages = (ctx.config.maxPages as number) ?? 20;

    for (const insee of ctx.communeInsee) {
      if (!communes.some((c) => c.insee === insee)) {
        console.warn(`[superimmo] no commune configured for INSEE ${insee} — skipping`);
      }
    }

    for (const c of communes.filter((x) => ctx.communeInsee.includes(x.insee))) {
      const seen = new Set<string>();
      for (let page = 1; page <= maxPages; page++) {
        const base = `${host}/achat/provence-alpes-cote-d-azur/var/${c.slug}-${c.postcode}`;
        const url = page === 1 ? base : `${base}/p/${page}`;

        let html: string;
        try {
          html = await ctx.fetch(url);
        } catch (err) {
          console.warn(`[superimmo] index fetch failed ${url}:`, (err as Error).message);
          break;
        }

        const fresh = listingUrlsOnPage(html, host).filter((u) => !seen.has(u));
        if (fresh.length === 0) break;

        for (const u of fresh) {
          seen.add(u);
          const id = u.match(ID_FROM_URL)?.[1];
          if (id) yield { externalId: id, url: u, communeHint: c.slug };
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

    // ── Price ─────────────────────────────────────────────────────────────
    // Labelled form first: it appears in a characteristics table and is the
    // least likely to collide with the price-per-m² figure sitting beside it.
    const price =
      match(text, /Prix de vente\s*:\s*([\d\s.,]+)\s*€/i) ??
      match(text, /Vente\s+\w+\s+([\d\s.,]{7,})\s*€/i);
    if (price) listing.priceEur = toInt(price);

    // ── Size, rooms, land ─────────────────────────────────────────────────
    // "160 m² - 4 chambres - ter. 2 250 m²" — one string, three numbers, and
    // the land figure will happily be read as living area if taken first.
    const land = match(text, /ter\.\s*([\d\s.,]+)\s*m²/i);
    if (land) listing.landM2 = num(land);

    const withoutLand = land ? text.replace(new RegExp(`ter\\.\\s*${escape(land)}\\s*m²`, "i"), " ") : text;
    const area = match(withoutLand, /([\d\s.,]+)\s*m²/);
    if (area) listing.areaM2 = num(area);

    const bedrooms = match(text, /(\d+)\s*chambres?/i);
    if (bedrooms) listing.bedrooms = Number(bedrooms);

    /**
     * Rooms are printed as "0 pièces" when the agency did not supply a count.
     * Storing that zero would put a nought into every average and make a villa
     * look like it has no rooms at all.
     */
    const rooms = match(text, /(\d+)\s*pièces?/i);
    if (rooms && Number(rooms) > 0) listing.rooms = Number(rooms);

    // ── Where ─────────────────────────────────────────────────────────────
    const place = /(?:Maison|Appartement|Terrain|Villa|Immeuble)\s+à\s+([A-ZÀ-Ü][^•(]{1,40}?)\s*(?:•|\()/i.exec(text);
    if (place) listing.communeRaw = place[1].trim();
    const postcode = match(text, /\((\d{5})\)/);
    if (postcode) listing.postalCode = postcode;

    const type = match(text, /Vente\s+(maison|appartement|terrain|villa|immeuble)/i);
    if (type) listing.propertyType = capitalise(type);

    // ── The two fields that make this portal worth the fragility ──────────
    listing.publishedAt = parseFrDate(match(text, /Publiée le\s*(\d{2}\/\d{2}\/\d{4})/i));
    listing.sourceUpdatedAt = parseFrDate(match(text, /maj le\s*(\d{2}\/\d{2}\/\d{4})/i));

    /**
     * `Réf. agence` is the agency's own mandate number and the exact
     * deduplication key. `Réf Superimmo` next to it is this portal's internal
     * id and means nothing anywhere else — taking the wrong one would produce
     * a key that never matches another portal, silently.
     */
    /**
     * The reference runs to the next ` - Réf` label, spaces included.
     *
     * The previous pattern stopped at the first space, which quietly turned
     * "VILLA LUMA-EXCELLENCERIVIERA83990" into "VILLA" and "SWI 1316" into
     * "SWI". Three Excellence villas then shared the reference "VILLA" and five
     * Swixim listings shared "SWI" — and since an exact agency+reference match
     * merges at 100% confidence with no threshold, eight separate properties
     * collapsed into two. Prices from €5.49M to €9.95M under one card.
     *
     * Verified against all 63 saved Superimmo pages: this changes the answer on
     * exactly those eight and leaves the other 55 identical, and afterwards no
     * reference is shared by two listings.
     */
    listing.agencyRef =
      match(text, /R[ée]f\.\s*agence\s*:\s*(.{1,60}?)(?:\s+[-–]\s+R[ée]f|\s*$)/i) ??
      match(text, /R[ée]f\.\s*agence\s*:\s*([A-Za-z0-9][\w\-./]{0,24})/i);

    // ── Agency ────────────────────────────────────────────────────────────
    const agencyLink = $('a[href*="/agence/"]').first();
    if (agencyLink.length > 0) {
      listing.agencyName = cleanAgencyName(agencyLink.text());
      const href = agencyLink.attr("href") ?? "";
      const pc = href.match(/\/agence\/[a-z-]+-(\d{5})\//i)?.[1];
      if (pc) listing.agencyPostalCode = pc;
    }
    const phone = $('a[href^="tel:"]').first().attr("href");
    if (phone) listing.agencyPhone = phone.replace("tel:", "").trim();

    // ── Description ───────────────────────────────────────────────────────
    const description = $("section.description, .description").first().text().replace(/\s+/g, " ").trim();
    if (description) listing.description = description;
    listing.title = $("h1").first().text().replace(/\s+/g, " ").trim() || null;

    /**
     * The main photograph, hotlinked rather than copied — the photography is
     * the agency's, and `og:image` is what the portal publishes for other sites
     * to display.
     */
    listing.imageUrl = $('meta[property="og:image"]').attr("content")?.trim() || null;

    /**
     * The gallery, taken ONLY from inside `div.gallery`.
     *
     * Superimmo's photo URLs are opaque hashes with nothing in them tying an
     * image to a listing, and a detail page carries up to a hundred of them —
     * the rest belong to the "similar properties" strip. There is no way to
     * filter them apart after the fact, so the scoping has to be structural:
     * whatever is inside the gallery container, and nothing else.
     *
     * The first photo is an `<a class="fancybox">`; the remainder are lazy
     * placeholders carrying `data-big-photo-url`.
     */
    const gallery = $("div.gallery").first();
    const photos = new Set<string>();
    gallery.find("a.fancybox[href], [data-big-photo-url]").each((_, el) => {
      const url = $(el).attr("data-big-photo-url") ?? $(el).attr("href");
      if (url && /^https?:\/\/photo\./i.test(url)) photos.add(url.trim());
    });
    listing.imageUrls = [...photos];

    listing.raw = { dpe: match(text, /Étiquette climat-énergie\s*:\s*([A-G])/i) };

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
 * Strip the call-to-action wrapper off an agency name.
 *
 * For independent agents on networks like IAD and MeilleursBiens, the only link
 * to their page is a button reading "Contacter l'agent SANDRINE ARMANDO -
 * IKAMI". Taken whole, the product listed competitors named "Contacter l'agent
 * ARNAUD V…" — and worse, it would group every such agent under a single made-up
 * agency if the truncation ever collided.
 *
 * The real name is inside; only the invitation has to go.
 */
export function cleanAgencyName(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const stripped = text
    .replace(/^contacter\s+(l['’]agent|l['’]agence|le\s+vendeur)\s*:?\s*/i, "")
    .replace(/^(voir|contacter)\s+(la\s+)?(page\s+de\s+l['’]agence|l['’]agence)\s*:?\s*/i, "")
    .trim();
  // Two word characters minimum: a name that is punctuation is not a name, and
  // stored it becomes an agency every other nameless listing merges into.
  return /[\p{L}\p{N}]{2}/u.test(stripped) ? stripped : null;
}

function match(text: string, re: RegExp): string | null {
  return re.exec(text)?.[1]?.trim() ?? null;
}

function toInt(raw: string): number | null {
  const n = num(raw);
  return n === null ? null : Math.round(n);
}

/** `06/02/2026` is 6 February, not 2 June. */
function parseFrDate(raw: string | null): Date | null {
  if (!raw) return null;
  const [d, m, y] = raw.split("/").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listingUrlsOnPage(html: string, host: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !LISTING_PATH.test(href)) return;
    urls.add(href.startsWith("http") ? href : new URL(href, host).toString());
  });
  return [...urls];
}

export type { RawListing };
