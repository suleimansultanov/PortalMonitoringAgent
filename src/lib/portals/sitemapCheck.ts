import "server-only";
import { db } from "@/lib/db/client";
import { portalSources } from "@/lib/db/schema";
import { createFetcher, USER_AGENT } from "./runner/fetcher";
import { createBrowserSession, type BrowserSession } from "./runner/browser";
import { isSitemapIndex, parseSitemap, parseSitemapIndex, type SitemapEntry } from "./runner/sitemap";

/**
 * IS THIS PORTAL'S `lastmod` WORTH ANYTHING?
 *
 *   npm run sitemap:check
 *   npm run sitemap:check -- --source=figaro --shards=3
 *   npm run sitemap:check -- --source=green-acres --match=listing
 *
 * A sitemap that dates its entries honestly would let a night ask one question
 * — "what changed since yesterday?" — instead of walking a hundred index pages
 * to find four new listings. That is the difference between a pass that fits in
 * a night and one that does not, and between a polite crawler and a heavy one.
 *
 * But `lastmod` is optional and frequently a lie of convenience. Three worlds
 * exist and they look identical from the outside:
 *
 *   1. Absent. Nothing to filter on.
 *   2. One date for every URL — the day the file was generated. Useless, and
 *      dangerous if trusted: everything looks equally fresh or equally stale.
 *   3. Per-page and maintained. The thing we want.
 *
 * SMC is already known to be the second kind: every shard of its index carries
 * 2026-03-05. This tells us which kind the others are, by counting distinct
 * dates rather than by hoping.
 *
 * Read-only, and deliberately small: the root, and a couple of shards. It asks
 * a portal for the file it publishes for exactly this purpose, at that
 * source's own crawl delay. Run it from a machine the portals answer — some of
 * them refuse datacentre addresses outright, and a 403 here says nothing about
 * the dates.
 *
 * TWO THINGS THE FIRST VERSION GOT WRONG, both of which produced a confident
 * answer to a question it had not asked:
 *
 * It fetched with the plain HTTP client always. Figaro's WAF answers 403 to
 * that on every path — index, listing and sitemap alike — and 200 to a
 * browser, which is why the source carries `fetchMode: browser` and a
 * permission note saying so. The run reported "robots.txt unreadable" and no
 * sitemap, which reads as a portal that publishes none. It publishes one; we
 * knocked with the wrong hand.
 *
 * And it opened the first shards in the index, which on Green-Acres are
 * `main-real-estate` and `main-house` — category pages, 142 and 185 URLs,
 * regenerated wholesale. Their single shared date says nothing about whether
 * LISTING pages are dated individually. `--match` picks the shards worth
 * opening; the shard list is printed so there is something to pick from.
 */

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

function describe(label: string, entries: SitemapEntry[]): void {
  const dated = entries.filter((e) => e.lastmod);
  const distinct = new Set(dated.map((e) => e.lastmod!.toISOString().slice(0, 10)));
  const times = dated.map((e) => e.lastmod!.getTime());

  console.log(`\n   ${label}`);
  console.log(`     entries        ${entries.length}`);
  console.log(`     with lastmod   ${dated.length}`);

  if (dated.length === 0) {
    console.log(`     verdict        NO DATES — a delta pass cannot use this`);
    return;
  }

  const newest = new Date(Math.max(...times));
  const oldest = new Date(Math.min(...times));
  const ageDays = Math.round((Date.now() - newest.getTime()) / 86_400_000);
  console.log(`     distinct days  ${distinct.size}`);
  console.log(`     newest         ${newest.toISOString().slice(0, 10)} (${ageDays}d ago)`);
  console.log(`     oldest         ${oldest.toISOString().slice(0, 10)}`);

  if (distinct.size === 1) {
    console.log(`     verdict        ONE DATE FOR EVERYTHING — generation stamp, not per-page. Useless.`);
  } else if (ageDays > 30) {
    console.log(`     verdict        STALE — newest entry is ${ageDays} days old. Not maintained.`);
  } else {
    console.log(`     verdict        USABLE — ${distinct.size} distinct days, freshest ${ageDays}d old`);
  }
}

/** Sitemap roots: the source's own config first, then whatever robots.txt declares. */
async function roots(baseUrl: string, configured: string | undefined, fetch: (u: string) => Promise<string>): Promise<string[]> {
  const out = configured ? [configured] : [];
  try {
    const robots = await fetch(new URL("/robots.txt", baseUrl).toString());
    for (const line of robots.split("\n")) {
      const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (m && !out.includes(m[1])) out.push(m[1]);
    }
  } catch (err) {
    console.log(`     (robots.txt unreadable: ${(err as Error).message})`);
  }
  return out;
}

async function main(): Promise<void> {
  const only = arg("source");
  const shardLimit = Math.max(0, Number(arg("shards") ?? 2) || 2);
  /** Substring a shard URL must contain to be opened. */
  const match = arg("match")?.toLowerCase();

  const sources = await db.select().from(portalSources);
  const targets = only ? sources.filter((s) => s.key === only) : sources;

  console.log(`\nasking each portal for the file it publishes to be read.`);
  console.log(`user-agent: ${USER_AGENT}`);

  for (const source of targets) {
    console.log(`\n═══ ${source.key} ═══`);
    const cfg = (source.config as Record<string, unknown> | null) ?? {};

    /**
     * The same door the collector uses for this source, not a door of our own.
     * A portal that only answers a browser is not a portal without a sitemap.
     */
    const fetchMode = cfg.fetchMode;
    const useBrowser = fetchMode === "browser" || fetchMode === "browser-discovery";
    const plain = createFetcher({
      delayMs: source.crawlDelayMs,
      userAgent: (cfg.userAgent as string | undefined)?.trim() || undefined,
      extraHeaders: (cfg.extraHeaders as Record<string, string> | undefined) ?? {},
    });

    let session: BrowserSession | null = null;
    if (useBrowser) {
      session = await createBrowserSession({
        delayMs: source.crawlDelayMs,
        userAgent: (cfg.userAgent as string | undefined)?.trim() || undefined,
        extraHeaders: (cfg.extraHeaders as Record<string, string> | undefined) ?? {},
        readySelector: (cfg.readySelector as string | undefined)?.trim() || undefined,
      });
      console.log(`   (browser, because this source needs one)`);
    }

    /**
     * Gzipped shards go to the plain client even on a browser source: Chromium
     * renders a .xml.gz as a download, not as text, and `fetcher.ts` already
     * ungzips. Same split the collector makes in run.ts.
     */
    const SITEMAP_LIKE = /\.(?:xml|gz|xml\.gz)(?:$|[?#])/i;
    const fetch = (url: string): Promise<string> =>
      session && !SITEMAP_LIKE.test(url) ? session.fetch(url) : plain(url);

    const found = await roots(source.baseUrl, cfg.sitemap as string | undefined, fetch);
    if (found.length === 0) {
      console.log(`   no sitemap in config and none declared in robots.txt`);
      continue;
    }

    for (const root of found.slice(0, 2)) {
      console.log(`\n   root: ${root}`);
      let xml: string;
      try {
        xml = await fetch(root);
      } catch (err) {
        console.log(`     unreadable: ${(err as Error).message}`);
        continue;
      }

      if (!isSitemapIndex(xml)) {
        describe("(leaf sitemap)", parseSitemap(xml));
        continue;
      }

      const shards = parseSitemapIndex(xml);
      describe(`index of ${shards.length} shards — dates ON THE SHARDS`, shards);

      console.log(`\n     shards (first 20 of ${shards.length}):`);
      for (const sm of shards.slice(0, 20)) {
        console.log(`       ${sm.loc.split("/").pop()}`);
      }

      /**
       * The index's own dates and the entries' dates are different claims, and
       * a portal can get one right and the other wrong. SMC stamps every shard
       * with the same day; whether the URLs inside are dated individually is a
       * separate question, and the one that actually matters.
       */
      const wanted = match
        ? shards.filter((sm) => sm.loc.toLowerCase().includes(match))
        : shards;
      if (match && wanted.length === 0) {
        console.log(`\n     no shard matches --match=${match}`);
      }
      for (const shard of wanted.slice(0, shardLimit)) {
        let child: string;
        try {
          child = await fetch(shard.loc);
        } catch (err) {
          console.log(`\n   shard ${shard.loc}\n     unreadable: ${(err as Error).message}`);
          continue;
        }
        describe(`shard ${shard.loc.split("/").pop()} — dates ON THE PAGES`, parseSitemap(child));
      }
    }

    await session?.close().catch(() => {});
  }

  console.log(
    `\nRead it this way: a source whose entries carry many distinct, recent days\n` +
      `can be collected by asking what changed. One date for everything is a\n` +
      `generation stamp — it says when the file was written, not when the\n` +
      `listings were, and trusting it would make every listing look equally new.\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("sitemap:check failed:", err);
    process.exit(1);
  });
