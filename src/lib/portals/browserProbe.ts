import { createBrowserSession } from "./runner/browser";
import { BlockedError, FetchFailedError, USER_AGENT } from "./runner/fetcher";

/**
 * Does a real browser get further than our plain client?
 *
 *   npm run probe:browser
 *
 * Three portals were written off on a test that turned out to be the wrong one.
 * `npm run probe` asks with a plain HTTP client; SMC answered it 403 on every
 * index page and was filed as "needs a letter" for four days. On 30 August the
 * same URLs were opened by our collector driving Chromium and served normally,
 * and SMC — two sites — started collecting the same afternoon.
 *
 * The difference is not headers. It is the TLS handshake and the absence of a
 * JavaScript runtime, neither of which a fetch client can change honestly. So a
 * plain-client 403 says nothing about what a browser will get, and every portal
 * refused on that evidence alone deserves this second question before anyone
 * writes it a letter.
 *
 * WHAT THIS IS NOT. There is no stealth here and there must never be: no
 * patching of `navigator.webdriver`, no fingerprint spoofing, no proxies, no
 * captcha solving. The browser carries our own user-agent, so every site below
 * can see exactly who is knocking and refuse. A refusal measured here is a
 * genuine no and the answer to it is a conversation, not a better disguise.
 *
 * Read-only, and about a dozen requests in total.
 *
 * WHAT BELONGS ON THE LIST: portals that are NOT collecting and were refused on
 * a plain-client probe. Figaro and LuxuryEstate were both here until 2026-09-10
 * and both have been collecting since 30 August — Figaro's "listing page" was
 * still its `robots.txt`, carrying the note "nothing may be collected until it
 * can be read", which stopped being true the day a browser read it. A target
 * that is already answered turns this from a question into decoration, and
 * spends requests at a site to learn something we know.
 *
 * So: when a portal starts collecting, take it out of here.
 */

type Target = {
  portal: string;
  index: string;
  /**
   * Optional, because a portal can be worth asking about before anyone has a
   * single listing URL for it. Inventing one would be worse than skipping it:
   * these sites answer an unknown path with 200 and something else entirely,
   * so a made-up URL returns a confident wrong answer.
   */
  listing?: string;
  /** Why it is on this list — printed, so a result is never read out of context. */
  note: string;
};

const TARGETS: Target[] = [
  {
    portal: "seloger",
    index:
      "https://www.seloger.com/recherche/achat/maison/provence-alpes-cote-d-azur/saint-tropez-83990/ad08fr34360",
    listing: "https://www.bellesdemeures.com/252282811/detail.htm",
    note: "AVIV. Written permission since 25 Aug, never once served. Two sites.",
  },
  {
    portal: "vizzit",
    index: "https://www.vizzit.fr/acheter/saint-tropez",
    listing: "https://www.vizzit.fr/fr/property/maison/saint-tropez/A9vu8dlg951uktyn",
    note:
      "Green-Acres' platform under a second brand — its own listing footer says " +
      "'Vizzit (Green-Acres network)' and its sitemap shards carry Green-Acres' " +
      "exact filenames. Probed to find out whether the STOCK differs, not whether " +
      "the door opens: if it is the same feed, an adapter buys 2700 duplicates for " +
      "the deduplication to undo.",
  },
  {
    portal: "zefir",
    index: "https://www.zefir.fr/annonces/le-plan-de-la-tour/appartements",
    listing: "https://www.zefir.fr/annonce-partenaire/00eddcb4-b9e4-4085-8ce0-543fcdb6a95a",
    note:
      "Never blocked — its robots.txt is empty, so this probe will say ok and that " +
      "was never the question. Dropped on 29 Aug as 'nothing there to collect', " +
      "which was too strong: a partner listing read on 10 Sep is a real property " +
      "with a named agency (REMAX FRANCE), a mandate reference and an " +
      "agent-written description. What is untrustworthy is the INDEX — a page " +
      "titled '431 apartments in Le Plan-de-la-Tour' carrying stock from Cogolin " +
      "and Grimaud, and the same commune answering under two slugs with different " +
      "totals (429 vs 466). So the commune would have to be read off each listing " +
      "rather than taken from the list it was found in, exactly as Figaro already " +
      "does. The real risk here is duplicates: /annonce-partenaire/ says it " +
      "republishes feeds we may already collect elsewhere.",
  },
  {
    portal: "jamesedition",
    index: "https://www.jamesedition.com/real_estate/ramatuelle-france",
    listing:
      "https://www.jamesedition.com/real_estate/saint-tropez-france/saint-tropez-magnificent-charming-property-with-sea-view-18071317",
    note: "403 to the plain client on both. Never tried with a browser.",
  },
];

function verdict(err: unknown): string {
  if (err instanceof BlockedError) return `refused (${err.message})`;
  if (err instanceof FetchFailedError) return `HTTP ${err.status ?? "?"}`;
  return (err as Error).message.slice(0, 80);
}

async function main(): Promise<void> {
  console.log(`\nasking as: ${USER_AGENT}`);
  console.log(`no stealth: our own user-agent, an unmodified browser, every site can refuse\n`);

  // Slower than any adapter would run: four portals, eight pages, and being
  // conspicuously gentle is the least we owe a site we are re-testing.
  const session = await createBrowserSession({ delayMs: 5_000, userAgent: USER_AGENT });

  try {
    for (const t of TARGETS) {
      console.log(`── ${t.portal}`);
      console.log(`   ${t.note}`);
      const pages: [string, string][] = [["index  ", t.index]];
      if (t.listing) pages.push(["listing", t.listing]);

      for (const [label, url] of pages) {
        try {
          const html = await session.fetch(url);
          const kb = Math.round(html.length / 1024);
          // Size matters: a 3 KB "success" is a challenge page, not content.
          const looksReal = html.length > 20_000;
          console.log(
            `   ${label}  ok — ${kb} KB${looksReal ? "" : "  ⚠ too small to be a real page"}`,
          );
        } catch (err) {
          console.log(`   ${label}  ${verdict(err)}`);
        }
      }
      console.log("");
    }
  } finally {
    await session.close().catch(() => {});
  }

  console.log(
    `Read it this way: "ok" with a plausible size means the plain-client verdict\n` +
      `was wrong and that portal is worth an adapter. Anything else is the site\n` +
      `saying no to a browser that told it exactly who it was — which is a real no.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
