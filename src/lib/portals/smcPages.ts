import { createBrowserSession } from "./runner/browser";
import { USER_AGENT } from "./runner/fetcher";

/**
 * Is the browser capturing pages before they have finished rendering?
 *
 *   npm run smc:pages
 *
 * Measured 2026-08-30, and the reason this script exists in this shape: the
 * same Gassin index page came back at 97 KB with ONE listing link, while every
 * other commune's equivalent page came back at 233–236 KB with fifteen. That
 * is not a difference in content. It is the same page caught at two different
 * moments.
 *
 * We wait for `domcontentloaded` rather than for the network to fall silent,
 * and deliberately — these pages never go quiet, because analytics, ad slots
 * and chat widgets keep chattering long after the content is there, so waiting
 * for silence means waiting for the timeout on every page. The cost of that
 * choice is this: anything the page fills in with JavaScript a moment later can
 * be missed.
 *
 * It matters well beyond SMC. A half-rendered index page yields a handful of
 * listings instead of a full one, the crawl reads that as a thin market, and
 * nothing anywhere says otherwise. Same silent shape as every other truncation
 * we have found today, with the added cruelty of being intermittent — it would
 * not reproduce, and the counts would simply wobble between nights.
 *
 * Fetching one URL repeatedly is what separates the two explanations. Stable
 * numbers mean the page really is that small; numbers that move mean we are
 * racing the page.
 */

const HOST = "https://www.maisonsetappartements.fr";
const URL_ = `${HOST}/fr/83/biens/vente/selection-biens-gassin-35915.html`;
const LISTING = /\/fr\/\d{2}\/annonce-vente-[a-z0-9-]+-\d+\.html/gi;
const ROUNDS = 4;

async function main(): Promise<void> {
  const session = await createBrowserSession({ delayMs: 4_000, userAgent: USER_AGENT });
  const sizes: number[] = [];
  const counts: number[] = [];

  try {
    console.log(`\nfetching the same page ${ROUNDS} times:\n${URL_}\n`);
    for (let i = 1; i <= ROUNDS; i++) {
      try {
        const html = await session.fetch(URL_);
        const n = new Set(html.match(LISTING) ?? []).size;
        sizes.push(Math.round(html.length / 1024));
        counts.push(n);
        console.log(`   attempt ${i}: ${Math.round(html.length / 1024)} KB, ${n} listing links`);
      } catch (err) {
        console.log(`   attempt ${i}: ${(err as Error).message.split("\n")[0].slice(0, 80)}`);
      }
    }
  } finally {
    await session.close().catch(() => {});
  }

  const stable = new Set(counts).size <= 1;
  console.log(
    stable
      ? `\n   Stable at ${counts[0]} links every time — the page really is that\n` +
          `   size, and SMC is simply a small portal in this area. No race.\n`
      : `\n   ⚠ The same URL returned ${Math.min(...counts)}–${Math.max(...counts)} links.\n` +
          `   We are racing the page: it is captured before JavaScript has\n` +
          `   finished filling it in, so an index page can silently yield a\n` +
          `   fraction of its listings. This affects every browser-mode source —\n` +
          `   SMC and Etreproprio — and it is intermittent, which is worse than\n` +
          `   consistent: the counts would just wobble between nights.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
