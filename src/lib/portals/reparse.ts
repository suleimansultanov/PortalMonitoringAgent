import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalListings, portalSnapshots, portalSources } from "@/lib/db/schema";
import fs from "node:fs/promises";
import path from "node:path";
import { getPage, storageDescription } from "@/lib/s3/pages";
import { getAdapter } from "./registry";
import { coverFromGallery } from "./images";
import { resolveAgency } from "./agencies";
import { resolveCommune } from "./communes";
import { resolveCommuneIdentities } from "./matching/resolve";

/**
 * Re-run the parsers over pages already on disk. NO NETWORK.
 *
 *   npm run reparse
 *   npm run reparse -- --source=green-acres
 *   npm run reparse -- --dry
 *
 * WHY THIS EXISTS
 *
 * A Green-Acres listing page is 815 kB. One commune is 127 MB; the whole gulf
 * is about a gigabyte. So every parser fix cannot mean re-downloading the
 * market — and on a metered connection it cannot mean downloading anything at
 * all.
 *
 * The collector already keeps every page it fetched, precisely so fields can be
 * re-derived without asking the portal again. This is the command that uses
 * that. It is also the polite option: the portals gave us permission on the
 * understanding we would be reasonable, and re-fetching a thousand unchanged
 * pages because of our own bug is not reasonable.
 *
 * WHAT IT DOES NOT DO
 *
 * It cannot recover a field the saved page does not contain, and it cannot see
 * a listing that was never fetched. It re-derives; it does not discover.
 */

type Args = { source?: string; dry: boolean; explain?: string };

function parseArgs(): Args {
  const get = (n: string) =>
    process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
  return {
    source: get("source"),
    dry: process.argv.includes("--dry"),
    explain: get("explain"),
  };
}

/**
 * The most recent capture of a listing that shows a euro price, other than
 * the current one — for pages the runner saved in another currency. Looks at
 * older S3 snapshots first (at most three, newest first), then at the
 * laptop-era files under `.pages/pages/<source>/<date>/<id>.html`. Reads only;
 * nothing is fetched from the portal.
 */
async function lastEuroPrice(
  sourceId: string,
  sourceKey: string,
  externalId: string,
  url: string,
  adapter: ReturnType<typeof getAdapter>,
): Promise<{ price: number; at: string; where: "s3" | "local" } | null> {
  const eurOf = (html: string): number | null => {
    const r = adapter.parse(html, url);
    return "listing" in r ? r.listing.priceEur : null;
  };
  const captures = await db
    .select({ key: portalSnapshots.s3Key, at: portalSnapshots.fetchedAt })
    .from(portalSnapshots)
    .where(and(eq(portalSnapshots.sourceId, sourceId), eq(portalSnapshots.externalId, externalId)))
    .orderBy(desc(portalSnapshots.fetchedAt))
    .limit(4);
  for (const c of captures.slice(1)) {
    try {
      const price = eurOf(await getPage(c.key));
      if (price !== null) return { price, at: c.at.toISOString(), where: "s3" };
    } catch {
      // unreadable capture: try the next one
    }
  }
  const root = path.join(process.cwd(), ".pages", "pages", sourceKey);
  let days: string[] = [];
  try {
    days = (await fs.readdir(root)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  } catch {
    return null;
  }
  for (const day of days) {
    try {
      const price = eurOf(await fs.readFile(path.join(root, day, `${externalId}.html`), "utf8"));
      if (price !== null) return { price, at: `${day}T00:00:00.000Z`, where: "local" };
    } catch {
      // not captured that day
    }
  }
  return null;
}

/**
 * Find the saved page for a listing.
 *
 * ASK THE DATABASE WHERE IT IS. Do not reconstruct the path.
 *
 * This used to scan `.pages/` for a file whose name it rebuilt from the
 * external id, and it was wrong twice over.
 *
 * It only ever looked at local disk, so the day pages moved to object storage
 * — which is the day the collector left this laptop — re-parsing would have
 * quietly found nothing for everything collected since, while still working
 * perfectly for the older files sitting next to it. A backfill would not have
 * fixed that; this function never looked in the bucket at all.
 *
 * And the name it rebuilt was not the name that was written. `pageKey` encodes
 * the id with `encodeURIComponent`; this replaced everything outside
 * `[a-zA-Z0-9._-]` with an underscore. For an id carrying a slash or a query
 * character — which `pages.ts` explicitly warns portals do put in them — the
 * two disagree, the file is not found, and the listing is skipped as though no
 * page had ever been saved. Silent, and worst on exactly the ids nobody
 * inspects.
 *
 * `portal_snapshots` has recorded the exact key of every stored page since the
 * first pass, with the time it was fetched. Reading it removes both bugs and
 * the guessing along with them: newest row, its key, through the same storage
 * layer the collector wrote it with — local disk or bucket, whichever is
 * configured.
 */
async function findPage(sourceId: string, externalId: string): Promise<string | null> {
  const [snapshot] = await db
    .select({ s3Key: portalSnapshots.s3Key })
    .from(portalSnapshots)
    .where(
      and(
        eq(portalSnapshots.sourceId, sourceId),
        eq(portalSnapshots.externalId, externalId),
      ),
    )
    // A listing fetched more than once should be re-parsed from the most recent
    // capture, not the first one we happened to store.
    .orderBy(desc(portalSnapshots.fetchedAt))
    .limit(1);

  if (!snapshot) return null;

  try {
    return await getPage(snapshot.s3Key);
  } catch (err) {
    /**
     * A recorded key whose object is gone. Reported rather than swallowed: it
     * means the two sides have drifted — a bucket lifecycle rule deleted it, or
     * the page was written to a laptop and the row synced to a database the
     * bucket does not match. "No page saved" and "the page we saved is missing"
     * need different answers, and only one of them is normal.
     */
    console.warn(`   ⚠ ${externalId}: ${snapshot.s3Key} is recorded but unreadable — ${(err as Error).message}`);
    return null;
  }
}

/**
 * One listing, and what the parser actually sees.
 *
 *   npm run reparse -- --source=etreproprio --explain=23120189
 *
 * Written because a dry run reported an area changing from 1010 to 10 and no
 * amount of re-reading the regular expression explained why. A parser argues
 * with the page, not with the person reading it, so the page has to be quoted.
 *
 * Prints every "m²" in the text with the characters before it — which is where
 * the answer lives when a number loses its first digit.
 */
async function explainOne(sourceKey: string, externalId: string): Promise<void> {
  const [source] = await db
    .select()
    .from(portalSources)
    .where(eq(portalSources.key, sourceKey))
    .limit(1);
  if (!source) throw new Error(`no source ${sourceKey}`);

  const [row] = await db
    .select()
    .from(portalListings)
    .where(and(eq(portalListings.sourceId, source.id), eq(portalListings.externalId, externalId)))
    .limit(1);
  if (!row) throw new Error(`no listing ${externalId} on ${sourceKey}`);

  const html = await findPage(source.id, externalId);
  if (!html) throw new Error("page not on disk");

  const cheerio = await import("cheerio");
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  console.log(`\n${row.title}`);
  console.log(`stored: area ${row.areaM2 ?? "—"}  land ${row.landM2 ?? "—"}\n`);
  console.log("every m² in the page text, with what precedes it:\n");

  const re = /m²/gu;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null && n < 40) {
    n += 1;
    const from = Math.max(0, m.index - 44);
    console.log(`  ${JSON.stringify(text.slice(from, m.index + 2))}`);
  }

  const adapter = getAdapter(sourceKey);
  const result = adapter.parse(html, row.url);
  if ("listing" in result) {
    console.log(
      `\nparsed now: area ${result.listing.areaM2 ?? "—"}  land ${result.listing.landM2 ?? "—"}`,
    );
    const fp = (result.listing.raw as Record<string, unknown> | null)?.foreignPrice;
    if (fp) {
      /**
       * A page in another currency: where else might the euro price be?
       * Two places to look, printed rather than guessed at (2026-09-24):
       * figures on this page that carry a euro sign or sit in a data
       * attribute, and every earlier capture of the same listing — the
       * laptop-era ones were rendered in euros.
       */
      console.log("\neuro candidates on this page:");
      const seen = new Set<string>();
      for (const m of html.matchAll(/data-default-value=["']?(\d{5,})/g)) {
        if (!seen.has(m[1])) console.log(`  data-default-value ${m[1]}`);
        seen.add(m[1]);
      }
      for (const m of text.matchAll(/(\d[\d\s\u00a0\u202f.]{4,})\s*€(?!\s*\/)/g)) {
        const v = m[1].trim();
        if (!seen.has(v)) console.log(`  "${text.slice(Math.max(0, m.index! - 40), m.index! + m[0].length)}"`);
        seen.add(v);
        if (seen.size > 20) break;
      }
      const captures = await db
        .select({ key: portalSnapshots.s3Key, at: portalSnapshots.fetchedAt })
        .from(portalSnapshots)
        .where(and(eq(portalSnapshots.sourceId, source.id), eq(portalSnapshots.externalId, externalId)))
        .orderBy(desc(portalSnapshots.fetchedAt));
      console.log(`\n${captures.length} capture(s) of this listing:`);
      for (const c of captures) {
        let shown = "unreadable";
        try {
          const page = await getPage(c.key);
          const r = adapter.parse(page, row.url);
          if ("listing" in r) {
            const f = (r.listing.raw as Record<string, unknown> | null)?.foreignPrice as { shown?: string } | undefined;
            shown = r.listing.priceEur !== null ? `${r.listing.priceEur} EUR` : f ? `not EUR: ${f.shown}` : "no price";
          }
        } catch (err) {
          shown = `unreadable: ${(err as Error).message}`;
        }
        console.log(`  ${c.at.toISOString().slice(0, 16)}  ${shown}`);
      }
    }
    console.log(
      `price: stored ${row.priceEur ?? "—"}  parsed ${result.listing.priceEur ?? "—"}` +
        (fp ? `  (page not in EUR: ${JSON.stringify(fp)})` : ""),
    );
  }
  process.exit(0);
}

export async function reparse(args: Args): Promise<void> {
  const sources = await db.select().from(portalSources);
  const wanted = args.source ? sources.filter((s) => s.key === args.source) : sources;

  if (wanted.length === 0) {
    console.error(`No source "${args.source}". Known: ${sources.map((s) => s.key).join(", ")}`);
    process.exit(1);
  }

  if (args.explain) {
    await explainOne(args.source ?? "etreproprio", args.explain);
    return;
  }

  console.log(`\nRe-parsing from ${storageDescription()} — no network, no traffic.`);
  if (args.dry) console.log(`dry run: nothing will be written\n`);

  const touchedCommunes = new Set<string>();
  let totalUpdated = 0;

  for (const source of wanted) {
    let adapter;
    try {
      adapter = getAdapter(source.key);
    } catch {
      continue; // A source with no adapter written yet.
    }

    /**
     * The stored values come too, because a re-parse has to be able to answer
     * "what would change" and not merely "what did the parser find".
     *
     * The first version counted every non-null field the parser produced. On a
     * dry run that printed `title 1697, description 1697, raw 1697` — which
     * says every listing has a title, not that a single one would change, and
     * is worse than printing nothing: it looks like a report.
     */
    const rows = await db
      .select({
        id: portalListings.id,
        externalId: portalListings.externalId,
        url: portalListings.url,
        title: portalListings.title,
        priceEur: portalListings.priceEur,
        areaM2: portalListings.areaM2,
        landM2: portalListings.landM2,
        rooms: portalListings.rooms,
        bedrooms: portalListings.bedrooms,
        propertyType: portalListings.propertyType,
        imageUrl: portalListings.imageUrl,
        imageUrls: portalListings.imageUrls,
      })
      .from(portalListings)
      .where(eq(portalListings.sourceId, source.id));

    if (rows.length === 0) continue;

    let updated = 0;
    let missing = 0;
    let failed = 0;
    const changes = new Map<string, number>();
    /** Fields whose value would actually change, and a few worked examples. */
    const differs = new Map<string, number>();
    const examples: string[] = [];
    const currencyExamples: string[] = [];

    /**
     * A line every hundred pages.
     *
     * Pages come back from object storage one at a time — a few tenths of a
     * second each, and Green-Acres pages are 815 kB — so a source takes ten or
     * twenty minutes. A run that prints nothing for twenty minutes is
     * indistinguishable from a run that has hung, and the first thing anyone
     * does is kill it and lose the work.
     */
    const startedAt = Date.now();
    let seen = 0;

    for (const row of rows) {
      seen += 1;
      if (seen % 100 === 0) {
        const secs = (Date.now() - startedAt) / 1000;
        const rate = seen / secs;
        const left = Math.round((rows.length - seen) / Math.max(rate, 0.01));
        console.log(
          `  ${source.key}: ${seen}/${rows.length}  ${updated} changed  ` +
            `~${Math.max(left, 0)}s left`,
        );
      }
      const html = await findPage(source.id, row.externalId);
      if (!html) {
        missing++;
        continue;
      }

      const result = adapter.parse(html, row.url);
      if (result.status === "failed") {
        failed++;
        continue;
      }

      const p = result.listing;
      const commune = resolveCommune(p.communeRaw, p.postalCode, `${p.title ?? ""} ${p.description ?? ""}`);
      if (commune) touchedCommunes.add(commune.insee);

      /**
       * Only non-null values are written.
       *
       * A re-parse must never turn a field we already have into a null: the
       * saved page may be an older capture than the row, and "the parser found
       * nothing this time" is not evidence that the property has no price.
       * Same rule as `mergeParsed` in the ingest path.
       */
      const patch: Record<string, unknown> = {};
      const consider = <K extends string>(key: K, value: unknown) => {
        if (value === null || value === undefined) return;
        patch[key] = value;
        changes.set(key, (changes.get(key) ?? 0) + 1);
      };

      consider("title", p.title);
      consider("description", p.description);
      // Same rule as the ingest path (2026-09-24): the cover is a member of the
      // gallery, or it becomes the gallery's first photo. Without this the
      // re-parse would write exactly the pair the dashboard cannot dedup —
      // 3,042 Superimmo rows and 1,021 Green-Acres rows measured that way.
      const photos = coverFromGallery(p.imageUrl, p.imageUrls);
      consider("imageUrl", photos.imageUrl);
      // An empty gallery is not evidence of no gallery — same rule as every
      // other field here, so only a non-empty array overwrites.
      if (photos.imageUrls.length > 0) consider("imageUrls", photos.imageUrls);
      consider("priceEur", p.priceEur);
      consider("areaM2", p.areaM2 === null ? null : String(p.areaM2));
      consider("landM2", p.landM2 === null ? null : String(p.landM2));
      consider("rooms", p.rooms);
      consider("bedrooms", p.bedrooms);
      consider("bathrooms", p.bathrooms);
      consider("propertyType", p.propertyType);
      consider("agencyRef", p.agencyRef);

      /**
       * Re-resolve the AGENCY, not just the reference.
       *
       * The first version of this command missed it, and the symptom was
       * unmistakable: the fix that strips "Contacter l'agent " off a name
       * landed in the parser, the re-parse reported success, and the screen
       * still said "Contacter l'agent ARNAUD VIALLANEIX". The listing rows had
       * been updated; the agency they pointed at had not.
       *
       * Worth stating why that is easy to miss — agency is the one field on a
       * listing that is a foreign key rather than a value, so "re-parse the
       * fields" quietly means "re-parse everything except this".
       */
      /**
       * Not in a dry run (2026-09-24). `resolveAgency` is not a lookup: it
       * inserts agencies it has not seen and fills in their missing address
       * and phone. So `--dry` printed "nothing will be written" and then wrote
       * to `portal_agencies` — additively, never destructively, but a dry run
       * that writes is not a dry run. The agency column is simply left out of
       * the dry report.
       */
      if (p.agencyName && !args.dry) {
        const agencyId = await resolveAgency({
          name: p.agencyName,
          address: p.agencyAddress,
          postalCode: p.agencyPostalCode,
          city: p.agencyCity,
          phone: p.agencyPhone,
        });
        consider("agencyId", agencyId);
      }
      consider("communeRaw", p.communeRaw);
      consider("postalCode", p.postalCode);
      consider("publishedAt", p.publishedAt);
      consider("sourceUpdatedAt", p.sourceUpdatedAt);
      consider("raw", p.raw);

      /**
       * The one place a re-parse writes a null, 2026-09-24.
       *
       * Everywhere else "the parser found nothing" is not evidence, so nothing
       * is cleared. A page rendered in dollars is evidence: it proves the
       * stored price was read off a dollar figure and filed as euros. Green-
       * Acres picks the display currency by visitor, the nightly runner sits
       * in a US datacentre, and the adapter had no currency check. Such a row
       * is cleared — an honest gap instead of a price 15% too high — and the
       * dry run counts them before anything is touched.
       */
      const foreign = (p.raw as Record<string, unknown> | null)?.foreignPrice as
        | { currency?: string; shown?: string }
        | undefined;
      if (foreign) {
        /**
         * Recover before clearing. The same listing was usually captured
         * earlier in euros — laptop-era pages are, and the four checked by
         * hand all were, at exactly the converter's 1.1488 below the stored
         * dollar figure. That capture's price is a real published euro price,
         * only older, so it is used and dated in `raw.priceEurFrom`. No rate
         * is applied anywhere: where no euro capture exists the price is
         * cleared, which is an honest gap rather than a figure of our making.
         */
        const eur = await lastEuroPrice(source.id, source.key, row.externalId, row.url, adapter);
        const bump = (k: string) => {
          changes.set(k, (changes.get(k) ?? 0) + 1);
          differs.set(k, (differs.get(k) ?? 0) + 1);
        };
        if (eur) {
          if (row.priceEur !== eur.price) {
            patch.priceEur = eur.price;
            bump("priceEur from earlier EUR capture");
          }
          patch.raw = { ...(p.raw as Record<string, unknown>), priceEurFrom: { capturedAt: eur.at, where: eur.where } };
        } else if (row.priceEur !== null) {
          patch.priceEur = null;
          bump("priceEur cleared (no EUR capture)");
        }
        if (currencyExamples.length < 6) {
          currencyExamples.push(
            `    ${(row.title ?? "").slice(0, 55)}\n` +
              `      stored ${row.priceEur ?? "—"} · page "${foreign.shown ?? "?"}" · ` +
              (eur ? `→ ${eur.price} € from ${eur.where} ${eur.at.slice(0, 10)}` : "→ cleared, no euro capture") +
              `\n      ${row.url}`,
          );
        }
      }
      if (commune) consider("communeInsee", commune.insee);

      /**
       * What would actually change. Measured on the numbers, because those are
       * what a parser fix is usually about and what a report is usually wrong
       * about.
       */
      const before: Record<string, unknown> = {
        areaM2: row.areaM2 === null ? null : Number(row.areaM2),
        landM2: row.landM2 === null ? null : Number(row.landM2),
        priceEur: row.priceEur,
        rooms: row.rooms,
        bedrooms: row.bedrooms,
        propertyType: row.propertyType,
        // The photo columns are compared as strings so the loop below can see
        // them: the cover exactly, the gallery by its join. Added 2026-09-24,
        // when the first dry run reported rooms and areas and said nothing
        // about the 2 458 galleries it was about to rewrite.
        imageUrl: row.imageUrl,
        imageUrls: row.imageUrls.join("\n"),
      };
      const after: Record<string, unknown> = {
        areaM2: p.areaM2,
        landM2: p.landM2,
        priceEur: p.priceEur,
        rooms: p.rooms,
        bedrooms: p.bedrooms,
        propertyType: p.propertyType,
        imageUrl: photos.imageUrl,
        imageUrls: photos.imageUrls.length > 0 ? photos.imageUrls.join("\n") : null,
      };
      const changed: string[] = [];
      for (const key of Object.keys(before)) {
        if (after[key] === null || after[key] === undefined) continue;
        if (before[key] === after[key]) continue;
        changed.push(key);
        differs.set(key, (differs.get(key) ?? 0) + 1);
      }
      if (
        examples.length < 8 &&
        (changed.includes("areaM2") || changed.includes("landM2"))
      ) {
        examples.push(
          `    ${(row.title ?? "").slice(0, 70)}\n` +
            `      area ${String(before.areaM2 ?? "—")} → ${String(after.areaM2 ?? "—")}   ` +
            `land ${String(before.landM2 ?? "—")} → ${String(after.landM2 ?? "—")}\n` +
            `      ${row.url}`,
        );
      }

      if (Object.keys(patch).length === 0) continue;

      if (!args.dry) {
        patch.updatedAt = new Date();
        await db.update(portalListings).set(patch).where(eq(portalListings.id, row.id));
      }
      updated++;
    }

    totalUpdated += updated;
    console.log(
      `  ${source.key.padEnd(14)} ${updated} re-parsed, ${missing} pages not on disk, ` +
        `${failed} unparseable`,
    );
    const diffs = [...differs.entries()].sort((a, b) => b[1] - a[1]);
    console.log(
      diffs.length === 0
        ? "    nothing would change"
        : `    WOULD CHANGE: ${diffs.map(([k, n]) => `${k} ${n}`).join(", ")}`,
    );
    if (examples.length > 0) {
      console.log("    examples:");
      for (const e of examples) console.log(e);
    }
    if (currencyExamples.length > 0) {
      console.log("    prices read off a page in another currency:");
      for (const e of currencyExamples) console.log(e);
    }
    const top = [...changes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (top.length > 0) {
      console.log(`    fields written: ${top.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    }
  }

  /**
   * Re-resolve afterwards. Parsing changes the fields deduplication compares
   * — an agency name that was null and is now known can merge two rows that
   * previously could not be connected — so leaving properties untouched would
   * report a fix that had not fully landed.
   */
  if (!args.dry && totalUpdated > 0) {
    console.log(`\n── re-running deduplication ──`);
    for (const insee of touchedCommunes) {
      const r = await resolveCommuneIdentities(insee);
      console.log(`   ${insee}: ${r.listings} listings → ${r.properties} properties (${r.merged} merged)`);
    }
  }

  console.log(
    `\n${totalUpdated} listings re-derived from saved pages. Nothing was downloaded.\n`,
  );
}

if (process.argv[1]?.endsWith("reparse.ts")) {
  reparse(parseArgs())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[reparse] failed:", (err as Error).message);
      process.exit(1);
    });
}
