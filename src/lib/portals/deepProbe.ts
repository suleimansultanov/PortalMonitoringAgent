import { createBrowserSession } from "./runner/browser";
import { BlockedError, FetchFailedError, USER_AGENT } from "./runner/fetcher";

/**
 * Does the door STAY open? Twenty listings, not one.
 *
 *   npm run probe:deep -- --portal=jamesedition
 *   npm run probe:deep -- --portal=vizzit --limit=10
 *   npm run probe:deep -- --portal=zefir --index=https://…
 *
 * WHY ONE PAGE PROVES NOTHING, MEASURED TWICE ON THIS PROJECT.
 *
 * LuxuryEstate served 252 pages, then 192, then 107, then 226, then 660 before
 * refusing — there is no counter, and a single request would have told us
 * nothing about any of it. SeLoger answers the first request and the twentieth
 * identically, which is its own kind of information. `probe:browser` asks "is
 * this portal reachable at all"; this asks the question that decides whether an
 * adapter is worth a day: does it hold up at crawl scale.
 *
 * WHAT IT IS NOT. Still no stealth, ever: our own user-agent, an unmodified
 * browser, one request every few seconds — slower than any adapter would run.
 * Every site can see who is knocking and say no, and a no measured here is a
 * real no whose answer is a letter.
 *
 * WHAT IT DOES NOT DO. It does not parse. It reports size and whether a euro
 * price is present, which is enough to tell a real listing from a challenge
 * page, and nothing more — a parser is the adapter's job and writing one here
 * would mean writing it twice.
 *
 * The listing URLs come from the portal's OWN index page, matched by the shape
 * its links actually have. Nothing is constructed: these sites answer an
 * unknown path with 200 and something else entirely, so a guessed URL returns
 * a confident wrong answer.
 */

type Portal = {
  /** Where the listing links are found. Overridable with --index. */
  index: string;
  /** The shape this portal's listing links have, read off real pages. */
  link: RegExp;
  /** Seconds between requests. Ours, chosen to be gentle — none of these stated one. */
  delayMs: number;
  note: string;
};

const PORTALS: Record<string, Portal> = {
  jamesedition: {
    index: "https://www.jamesedition.com/real_estate/saint-tropez-france",
    link: /href="(?:https:\/\/www\.jamesedition\.com)?(\/real_estate\/[a-z0-9-]+\/[a-z0-9-]+-\d{6,})"/gi,
    delayMs: 4_000,
    note: "Open to a browser on 30 Aug and again on 10 Sep. No adapter written.",
  },
  vizzit: {
    index: "https://www.vizzit.fr/acheter/saint-tropez",
    link: /href="(\/(?:fr|en)\/property\/[a-z-]+\/[a-z0-9-]+\/[A-Za-z0-9]+)"/gi,
    delayMs: 4_000,
    note:
      "Green-Acres' network by its own footer, yet states 510 in Saint-Tropez " +
      "against Green-Acres' 316. This is the run that says whether that is real " +
      "stock or a radius.",
  },
  zefir: {
    index: "https://www.zefir.fr/annonces/le-plan-de-la-tour/appartements",
    /**
     * ABSOLUTE, and that is the whole point of writing patterns against a saved
     * page rather than against a URL somebody sent you. This was
     * `/href="(\/annonce-partenaire\/…)"/` — a leading slash, a relative path —
     * and it matched nothing on a page carrying sixteen of these links. The
     * probe reported "0 listing links found", which reads exactly like a portal
     * that changed its markup, and is in fact a typo of mine.
     */
    link: /href="(?:https:\/\/www\.zefir\.fr)?(\/annonce-partenaire\/[0-9a-f-]{36})"/gi,
    delayMs: 4_000,
    note:
      "Listings are real and agency-named; the INDEX is what lies about commune. " +
      "Watch which communes come back from a Le Plan-de-la-Tour list.",
  },
};

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

/**
 * A refusal and a hiccup are not the same answer, and calling both "refused"
 * sends someone to write a letter about a 502.
 *
 * 4xx is the site saying no to us. 5xx is the site failing at itself — Zefir
 * answered 502 on a URL that had served 381 KB five minutes earlier and 381 KB
 * again five minutes later. The word for that is "retry", not "conversation".
 */
function verdict(err: unknown): string {
  if (err instanceof BlockedError) return `REFUSED (${err.message.slice(0, 60)})`;
  if (err instanceof FetchFailedError) {
    const code = err.status ?? 0;
    if (code >= 500) return `HTTP ${code} — their side, retry`;
    return `HTTP ${code || "?"}`;
  }
  return (err as Error).message.slice(0, 70);
}

/** A euro figure, in any of the three ways these sites write one. */
const PRICE = /(\d[\d\s .,]{2,})\s*€|€\s*(\d[\d\s .,]{2,})|EUR\s*\d/;

/** The commune, where the page states one plainly — Zefir's whole question. */
const POSTCODE = /\b(\d{5})\b/;

async function main(): Promise<void> {
  const key = arg("portal");
  const portal = key ? PORTALS[key] : undefined;
  if (!portal) {
    console.error(`\nusage: npm run probe:deep -- --portal=<${Object.keys(PORTALS).join("|")}>\n`);
    process.exit(1);
  }

  const limit = Number(arg("limit") ?? 20);
  const index = arg("index") ?? portal.index;

  console.log(`\n── ${key}`);
  console.log(`   ${portal.note}`);
  console.log(`   asking as: ${USER_AGENT}`);
  console.log(`   no stealth: our own user-agent, an unmodified browser, one page every ${portal.delayMs / 1000}s\n`);

  const session = await createBrowserSession({ delayMs: portal.delayMs, userAgent: USER_AGENT });

  try {
    console.log(`index  ${index}`);
    let html: string;
    try {
      html = await session.fetch(index);
    } catch (err) {
      console.log(`       ${verdict(err)}\n\nThe index itself was refused. Nothing further to measure.\n`);
      return;
    }
    console.log(`       ok — ${Math.round(html.length / 1024)} KB`);

    /**
     * Deduplicated and in page order. A portal that repeats the same twenty
     * links in a carousel would otherwise produce twenty "successes" that are
     * one page fetched twenty times.
     */
    const found = [...new Set([...html.matchAll(portal.link)].map((m) => m[1]))];
    const origin = new URL(index).origin;
    const urls = found.slice(0, limit).map((p) => origin + p);

    console.log(`       ${found.length} listing links found, taking ${urls.length}\n`);
    if (urls.length === 0) {
      console.log(
        `No links matched the expected shape. Either their markup changed or the\n` +
          `pattern in this file is wrong — check by hand before concluding anything\n` +
          `about access.\n`,
      );
      return;
    }

    let served = 0;
    let refused = 0;
    let thin = 0;
    const postcodes = new Map<string, number>();

    for (const [i, url] of urls.entries()) {
      const n = String(i + 1).padStart(2, " ");
      try {
        const page = await session.fetch(url);
        const kb = Math.round(page.length / 1024);
        const hasPrice = PRICE.test(page);
        // A 3 KB "success" is a challenge page, not a property.
        const real = page.length > 20_000;
        if (real) served += 1;
        else thin += 1;

        const code = page.match(POSTCODE)?.[1];
        if (code) postcodes.set(code, (postcodes.get(code) ?? 0) + 1);

        console.log(
          `${n}  ok — ${String(kb).padStart(4)} KB  ${hasPrice ? "price" : "NO PRICE"}` +
            `${real ? "" : "  ⚠ too small to be a real page"}${code ? `  ${code}` : ""}`,
        );
      } catch (err) {
        refused += 1;
        console.log(`${n}  ${verdict(err)}`);
      }
    }

    console.log(`\n${served} served, ${refused} refused, ${thin} too small, of ${urls.length}`);

    if (postcodes.size > 0) {
      const spread = [...postcodes.entries()].sort((a, b) => b[1] - a[1]);
      console.log(
        `postcodes seen: ${spread.map(([c, n2]) => `${c}×${n2}`).join(", ")}`,
      );
      if (spread.length > 2) {
        console.log(
          `⚠ ${spread.length} different postcodes from one commune's list — that is the\n` +
            `  index mixing stock, and it means the commune has to be read off each\n` +
            `  listing rather than taken from the list it was found in.`,
        );
      }
    }

    console.log(
      `\nRead it this way: refusals appearing PART-WAY through are the ones that\n` +
        `matter — that is what an adapter would hit every night, and what a\n` +
        `single-page probe cannot see.\n`,
    );
  } finally {
    await session.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
