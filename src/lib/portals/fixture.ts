import fs from "node:fs/promises";
import path from "node:path";
import { createFetcher, USER_AGENT } from "./runner/fetcher";
import { createBrowserSession, type BrowserSession } from "./runner/browser";

/**
 * Save a live page as a parser fixture.
 *
 *   npm run fixture -- --url=https://… --name=green-acres-ramatuelle
 *   npm run fixture -- --url=… --name=… --browser
 *
 * Fetched with the real collector, so what lands on disk is exactly what the
 * adapter will see in production — not what a browser renders, and not what
 * some other tool with different infrastructure was served. Those differ more
 * than anyone expects; three portals in this project return one thing to a
 * browser and another to us.
 *
 * Committed fixtures are the regression net: when a portal redesigns, the test
 * fails in CI rather than silently in a report three weeks later.
 *
 * `--browser` drives Chromium instead of the plain client, still carrying our
 * own user-agent and still with no stealth of any kind. Several of these
 * portals answer 403 to a fetch client and 200 to a browser — SMC, Etreproprio
 * and Figaro all do — and without this flag the tool inherited the same blind
 * spot that had three of them filed as unreachable for a week. If a source
 * runs with `fetchMode: browser`, capture its fixtures the same way, or the
 * fixture is not what the adapter will actually be handed.
 */

const FIXTURES = path.resolve(process.cwd(), "src/lib/portals/__fixtures__");

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

async function main(): Promise<void> {
  const url = arg("url");
  const name = arg("name");
  const delay = Number(arg("delay") ?? 3000);

  if (!url || !name) {
    console.error(
      "Usage: npm run fixture -- --url=<page url> --name=<fixture name> [--delay=3000]",
    );
    process.exit(1);
  }

  const useBrowser = process.argv.includes("--browser");

  console.log(`fetching ${url}${useBrowser ? " (through a browser)" : ""}`);

  let session: BrowserSession | null = null;
  if (useBrowser) {
    session = await createBrowserSession({ delayMs: delay, userAgent: USER_AGENT });
  }
  const fetcher = session?.fetch ?? createFetcher({ delayMs: delay, attempts: 2 });

  let html: string;
  try {
    html = await fetcher(url);
  } catch (err) {
    await session?.close().catch(() => {});
    console.error(`\nrefused: ${(err as Error).message}`);
    console.error(
      useBrowser
        ? `\nRefused to a browser carrying our own name, which is a real no.\n` +
            `The answer to that is a conversation, not a different tool.`
        : `\nRefused to the plain client. Try --browser before concluding anything:\n` +
            `SMC, Etreproprio and Figaro all answer 403 here and 200 to a browser.`,
    );
    process.exit(1);
  }
  await session?.close().catch(() => {});

  // Save under the extension the content actually is. A sitemap sitting on disk
  // as .html is the kind of small lie that costs someone ten minutes later.
  const ext = /^\s*<\?xml|<urlset|<sitemapindex/.test(html.slice(0, 200))
    ? "xml"
    : url.endsWith(".txt")
      ? "txt"
      : "html";

  const file = path.join(FIXTURES, `${name}.${ext}`);
  await fs.mkdir(FIXTURES, { recursive: true });

  const header =
    `<!-- Captured with the real collector on ${new Date().toISOString().slice(0, 10)}\n` +
    `     ${url}\n` +
    `     Trim by hand before committing: keep everything the parser reads,\n` +
    `     drop contact forms, country lists and share widgets. A fixture nobody\n` +
    `     can read in a diff stops being a regression net. -->\n`;

  await fs.writeFile(file, header + html, "utf8");

  console.log(`saved ${Math.round(html.length / 1024)}kb → ${path.relative(process.cwd(), file)}`);
  console.log(`\nWhat is in it:`);
  report(html);
}

/** A first look at the page, so the shape of an adapter is obvious before writing one. */
function report(html: string): void {
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  if (ld.length === 0) {
    console.log(`  no JSON-LD — this adapter will depend on their markup`);
  } else {
    const types = new Set<string>();
    for (const m of ld) {
      for (const t of m[1].matchAll(/"@type"\s*:\s*"([^"]+)"/g)) types.add(t[1]);
    }
    console.log(`  ${ld.length} JSON-LD block(s), types: ${[...types].join(", ")}`);
  }

  const price = html.match(/([\d\s.,]{6,})\s*€/)?.[1]?.trim();
  if (price) console.log(`  first price-looking string: ${price} €`);

  const ref = html.match(/R[ée]f[^:]{0,12}:\s*([A-Za-z0-9][\w\-./]{1,24})/)?.[1];
  console.log(`  agency reference: ${ref ?? "not found — dedup will lean on text"}`);

  const dates = html.match(/(?:publiée?|mis[e]? à jour|maj)\s*(?:le)?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1];
  console.log(`  a date: ${dates ?? "none — days-on-market needs our own history"}`);

  /**
   * If this looks like an index page, show where the listings are.
   *
   * Discovery is the half of this project that keeps turning out to be the hard
   * one, so a capture of a commune page should answer "and what do detail URLs
   * look like" in the same breath.
   */
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const detail = hrefs.filter((h) => /\/(annonce|bien|propert|vente|achat|ad)/i.test(h));
  const unique = [...new Set(detail)];
  if (unique.length > 3) {
    console.log(`\n  ${unique.length} links that look like listings, first three:`);
    for (const h of unique.slice(0, 3)) console.log(`    ${h}`);
  }
}

main().catch((err) => {
  console.error("fixture capture failed:", err);
  process.exit(1);
});
