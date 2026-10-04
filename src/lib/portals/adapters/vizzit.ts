import type { DiscoverContext, DiscoveredListing, PortalAdapter } from "../types";
import { isPastLastPage } from "../runner/fetcher";
import { cardsOnPage, greenAcresAdapter } from "./greenacres";

/**
 * Vizzit (vizzit.fr) — Green-Acres' engine under its French-market name.
 * Written 2026-10-04.
 *
 * NOT A MIRROR, and the project believed it was for five weeks. The first
 * research note called it "almost certainly the same inventory" on the
 * strength of a byte-identical robots.txt, and the Stream.Estate pilot seemed
 * to agree (their Vizzit adverts carried Green-Acres ids). Measured at last on
 * 2026-10-04: Vizzit stated 510 listings for Saint-Tropez where we held 297
 * from Green-Acres, and of 24 ids on its first page 16 were ones we had never
 * seen. Same id scheme, same pages — a larger catalogue. Green-Acres is the
 * shop window for buyers abroad; an agency can evidently list here alone.
 *
 * WHAT IS SHARED. The listing page is Green-Acres' page: same price block,
 * same icon-labelled surfaces, same agency block, same gallery paths, and the
 * same habit of rendering for the visitor (dollars from a US runner, with the
 * euro figure on a line beneath). So `parse` IS Green-Acres' parser, traps and
 * all — one place to fix when their markup moves. An id seen on both portals
 * is two listings of one property, which is what deduplication is for.
 *
 * WHAT IS NOT. The index lives at `/acheter/<slug>` and its pagination block
 * states the commune's total (`data-total-results`), which Green-Acres' own
 * adapter never had: each commune is graded against the portal's own count.
 *
 * ACCESS: `scripts/access-test.mjs --direct` from GitHub Actions, 2026-10-04 —
 * index and listing 200 to our user-agent. robots.txt is Green-Acres' own:
 * `Crawl-delay: 1`, a handful of AJAX endpoints closed, listings open.
 */

/** `data-current-page="2" data-page-size="24" data-total-results="510"` */
const PAGINATION = /data-current-page="(\d+)"[^>]*data-page-size="(\d+)"[^>]*data-total-results="(\d+)"/;

export function indexUrl(host: string, slug: string, page: number, pageParam = "p_n"): string {
  const base = `${host}/acheter/${slug}`;
  return page === 1 ? base : `${base}?${pageParam}=${page}`;
}

export const vizzitAdapter: PortalAdapter = {
  key: "vizzit",
  name: "Vizzit",
  hosts: ["vizzit.fr", "www.vizzit.fr"],
  discoveryMode: "index",
  /** Their robots.txt, the same file as Green-Acres': `Crawl-delay: 1`. */
  defaultCrawlDelayMs: 1_000,

  async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
    const host = (ctx.config.host as string) ?? "https://www.vizzit.fr";
    const communes = (ctx.config.communes ?? []) as { insee: string; slug: string; label: string }[];
    const maxPages = (ctx.config.maxPages as number) ?? 60;
    const pageParam = (ctx.config.pageParam as string) ?? "p_n";

    for (const insee of ctx.communeInsee) {
      if (!communes.some((c) => c.insee === insee)) {
        ctx.incomplete(insee, "no Vizzit commune configured");
      }
    }

    for (const c of communes.filter((x) => ctx.communeInsee.includes(x.insee))) {
      const seen = new Set<string>();
      let total: number | null = null;
      let knownStreak = 0;
      /** Set by every exit that is not "the results ran out". */
      let cutShort: string | null = null;
      let stoppedOnKnown = false;

      for (let page = 1; page <= maxPages; page++) {
        let html: string;
        try {
          html = await ctx.fetch(indexUrl(host, c.slug, page, pageParam));
        } catch (err) {
          if (isPastLastPage(err)) {
            if (page > 1) break;
            cutShort = `the commune URL is missing (${(err as Error).message}) — check the slug`;
          } else {
            cutShort = `index page ${page} failed: ${(err as Error).message}`;
          }
          console.warn(`[vizzit] ${c.slug}: ${cutShort}`);
          break;
        }

        const pagination = html.match(PAGINATION);
        if (pagination) {
          total ??= Number(pagination[3]);
          /**
           * The page they say this is. `p_n` ignored would serve page one
           * again under a 200 — every commune capped at 24 listings and
           * looking like a thin market. Their own counter says so directly.
           */
          if (Number(pagination[1]) !== page) {
            cutShort = `asked for page ${page}, they served page ${pagination[1]} — '${pageParam}' is not taking effect`;
            console.warn(`[vizzit] ${c.slug}: ${cutShort}`);
            break;
          }
        }

        const cards = cardsOnPage(html, host);
        const fresh = cards.filter((x) => !seen.has(x.id));
        if (fresh.length === 0) {
          if (page > 1 && cards.length > 0) {
            cutShort = `page ${page} repeated listings already seen — only the first ${seen.size} of this commune are visible`;
            console.warn(`[vizzit] ${c.slug}: ${cutShort}`);
          }
          break;
        }

        for (const card of fresh) {
          seen.add(card.id);
          if (ctx.delta) {
            if (ctx.delta.knows(card.id)) {
              knownStreak += 1;
              if (knownStreak >= ctx.delta.after) {
                stoppedOnKnown = true;
                break;
              }
              continue;
            }
            knownStreak = 0;
          }
          yield { externalId: card.id, url: card.url, communeHint: c.slug };
        }
        if (stoppedOnKnown) break;

        if (total !== null && seen.size >= total) break;
        if (page === maxPages) {
          cutShort = `hit the ${maxPages}-page ceiling with listings still arriving`;
          console.warn(`[vizzit] ${c.slug}: ${cutShort}`);
        }
      }

      if (stoppedOnKnown) {
        ctx.incomplete(c.insee, `stopped after ${knownStreak} listings we already hold — the rest is older`);
        continue;
      }
      /**
       * Graded against their own number. A few short is ordinary — promoted
       * cards repeat across pages and the counter includes listings a commune
       * page does not show — so the line is drawn at one page's worth.
       */
      if (!cutShort && total !== null && seen.size + 24 < total) {
        cutShort = `read ${seen.size} of the ${total} they state`;
      }
      if (cutShort) ctx.incomplete(c.insee, cutShort);
      else console.log(`[vizzit] ${c.slug}: ${seen.size} collected, ${total ?? "?"} stated by the portal`);
    }
  },

  parse: greenAcresAdapter.parse,
};
