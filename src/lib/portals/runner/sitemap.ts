import type { PoliteFetch } from "../types";

/**
 * Discovery through sitemaps.
 *
 * Measured, not assumed: five of the portals we want refuse their own search
 * pages to our client and serve individual listings without complaint. That is
 * not inconsistency on their part — search pages are what scrapers hammer, so
 * those get the protection, while listing pages are left open because the site
 * wants them in Google and shared in messages.
 *
 * A sitemap is the enumeration those portals publish deliberately. Reading it
 * asks the question search pages answer, using the door they left open on
 * purpose. It is also gentler: one gzipped file instead of forty paginated
 * requests.
 */

export type SitemapEntry = { loc: string; lastmod: Date | null };

/** Tags rather than a parser: sitemaps are simple, regular, and sometimes huge. */
const LOC = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
const LASTMOD = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i;
const URL_BLOCK = /<url>([\s\S]*?)<\/url>/gi;
const SITEMAP_BLOCK = /<sitemap>([\s\S]*?)<\/sitemap>/gi;

export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex/i.test(xml);
}

/** Child sitemap URLs from an index. */
export function parseSitemapIndex(xml: string): SitemapEntry[] {
  return blocks(xml, SITEMAP_BLOCK);
}

/** Page URLs from a leaf sitemap. */
export function parseSitemap(xml: string): SitemapEntry[] {
  const entries = blocks(xml, URL_BLOCK);
  if (entries.length > 0) return entries;

  // Some sitemaps omit <url> wrappers entirely. Fall back to bare <loc> tags
  // rather than returning nothing and reporting the portal as empty.
  const out: SitemapEntry[] = [];
  for (const m of xml.matchAll(LOC)) out.push({ loc: decode(m[1]), lastmod: null });
  return out;
}

function blocks(xml: string, re: RegExp): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const m of xml.matchAll(re)) {
    const chunk = m[1];
    const loc = new RegExp(LOC.source, "i").exec(chunk)?.[1];
    if (!loc) continue;
    const lastmodRaw = LASTMOD.exec(chunk)?.[1];
    const lastmod = lastmodRaw ? new Date(lastmodRaw) : null;
    out.push({
      loc: decode(loc),
      lastmod: lastmod && !Number.isNaN(lastmod.getTime()) ? lastmod : null,
    });
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export type WalkOptions = {
  fetch: PoliteFetch;
  /** Root sitemap or sitemap index. */
  root: string;
  /**
   * Which child sitemaps are worth opening. A global index may list a hundred
   * shards covering every country the portal operates in; opening all of them
   * to find one French commune is exactly the kind of load we promised not to
   * put on these sites.
   */
  keepSitemap?: (entry: SitemapEntry) => boolean;
  /** Which page URLs to keep — normally a commune-slug test. */
  keepUrl: (entry: SitemapEntry) => boolean;
  /** Stop after this many matches. Guards against a bad filter. */
  limit?: number;
  /** How deep to follow nested indexes. Two levels covers every real case. */
  maxDepth?: number;
};

/**
 * Walk a sitemap, yielding only the entries that matter.
 *
 * Streams rather than collecting: a portal-wide sitemap can hold hundreds of
 * thousands of URLs, and the caller usually wants a few hundred of them.
 */
export async function* walkSitemap(opts: WalkOptions): AsyncIterable<SitemapEntry> {
  const { fetch, root, keepSitemap, keepUrl, limit, maxDepth = 2 } = opts;

  let yielded = 0;
  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: root, depth: 0 }];

  while (queue.length > 0) {
    const { url, depth } = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);

    let xml: string;
    try {
      xml = await fetch(url);
    } catch (err) {
      // One unreadable shard should not abandon the rest — but the caller must
      // know the walk was incomplete, so this is loud.
      console.warn(`[sitemap] could not read ${url}: ${(err as Error).message}`);
      continue;
    }

    if (isSitemapIndex(xml)) {
      if (depth >= maxDepth) {
        console.warn(`[sitemap] nested deeper than ${maxDepth} at ${url} — not following`);
        continue;
      }
      for (const child of parseSitemapIndex(xml)) {
        if (keepSitemap && !keepSitemap(child)) continue;
        queue.push({ url: child.loc, depth: depth + 1 });
      }
      continue;
    }

    for (const entry of parseSitemap(xml)) {
      if (!keepUrl(entry)) continue;
      yield entry;
      yielded += 1;
      if (limit && yielded >= limit) return;
    }
  }
}

/**
 * Match a URL against commune slugs.
 *
 * Slug matching rather than anything cleverer because that is all a sitemap
 * gives us — a URL and a date. Bounded by separators so `la-mole` cannot match
 * inside `la-molere`, and case-folded because portals are inconsistent about it.
 */
export function communeSlugMatcher(slugs: string[]): (entry: SitemapEntry) => boolean {
  const patterns = slugs.map((s) => new RegExp(`[/-]${escapeRegex(s)}(?:[/-]|$|\\.)`, "i"));
  return (entry) => patterns.some((p) => p.test(entry.loc));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
