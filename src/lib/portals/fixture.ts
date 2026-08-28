import fs from "node:fs/promises";
import path from "node:path";
import { createFetcher } from "./runner/fetcher";

/**
 * Save a live page as a parser fixture.
 *
 *   npm run fixture -- --url=https://… --name=green-acres-ramatuelle
 *
 * Fetched with the real collector, so what lands on disk is exactly what the
 * adapter will see in production — not what a browser renders, and not what
 * some other tool with different infrastructure was served. Those differ more
 * than anyone expects; three portals in this project return one thing to a
 * browser and another to us.
 *
 * Committed fixtures are the regression net: when a portal redesigns, the test
 * fails in CI rather than silently in a report three weeks later.
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

  console.log(`fetching ${url}`);
  const fetcher = createFetcher({ delayMs: delay, attempts: 2 });

  let html: string;
  try {
    html = await fetcher(url);
  } catch (err) {
    console.error(`\nrefused: ${(err as Error).message}`);
    console.error(
      `\nThat is a result too — it means this portal will not serve the collector,\n` +
        `and no adapter can be written against it until that changes.`,
    );
    process.exit(1);
  }

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
