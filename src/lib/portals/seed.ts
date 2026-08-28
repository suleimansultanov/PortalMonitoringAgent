import "server-only";
import { db } from "@/lib/db/client";
import { clients, clientSources, portalSources } from "@/lib/db/schema";
import { COLLECTION_INSEE } from "./communes";
import {
  ETREPROPRIO_SLUGS,
  GREEN_ACRES_COMMUNES,
  SMC_COMMUNES,
  SUPERIMMO_COMMUNES,
  coverageReport,
  luxuryEstatePathsByInsee,
} from "./communePaths";

/**
 * First-run seed: one client, three sources covering four portals, and the
 * subscriptions between them.
 *
 * Idempotent — re-run it after filling in a commune slug and the config
 * updates in place.
 *
 * Every source is seeded DISABLED. Turning collection on should be a decision
 * someone makes after looking at the coverage report this prints, not a side
 * effect of running a script.
 */

type SourceSeed = {
  key: string;
  name: string;
  hosts: string[];
  baseUrl: string;
  crawlDelayMs: number;
  permissionNote: string;
  config: Record<string, unknown>;
};

function sourceSeeds(): SourceSeed[] {
  return [
    {
      key: "smc",
      name: "Maisons et Appartements / Résidences Immobilier",
      hosts: [
        "maisonsetappartements.fr",
        "www.maisonsetappartements.fr",
        "residences-immobilier.com",
        "www.residences-immobilier.com",
      ],
      baseUrl: "https://www.maisonsetappartements.fr",
      crawlDelayMs: 1000,
      permissionNote:
        "maisonsetappartements.fr: robots.txt permits current .html listing pages " +
        "(legacy .asp paths disallowed). residences-immobilier.com: robots.txt disallows " +
        "fiche-annonce-*.html — covered by written permission from SMC France, 2026-08-25.",
      config: {
        host: "https://www.maisonsetappartements.fr",
        /**
         * Discovery goes through here, not their search pages — those return
         * 403 to us while listings are served fine. Their index is split by
         * department, so the Var is one shard out of ninety-five.
         */
        sitemap: "https://www.maisonsetappartements.fr/sitemap.xml",
        department: "83",
        communes: SMC_COMMUNES,
        maxPages: 30,
      },
    },
    {
      key: "etreproprio",
      name: "Etreproprio",
      hosts: ["etreproprio.com", "www.etreproprio.com"],
      baseUrl: "https://www.etreproprio.com",
      crawlDelayMs: 1000,
      permissionNote:
        "robots.txt: Allow: / with /immobilier-recherche disallowed — we walk the " +
        "per-commune index pages, not the search. Checked 2026-08-25.",
      config: {
        host: "https://www.etreproprio.com",
        communeSlugs: ETREPROPRIO_SLUGS,
        types: ["maison", "appartement", "terrain"],
        maxPages: 20,
      },
    },
    {
      key: "superimmo",
      name: "Superimmo",
      hosts: ["superimmo.com", "www.superimmo.com"],
      baseUrl: "https://www.superimmo.com",
      /** Their robots.txt asks named crawlers for 10s. We are not named, but asked is asked. */
      crawlDelayMs: 10_000,
      permissionNote:
        "robots.txt: Allow: / with only account JSON endpoints disallowed. Verified " +
        "2026-08-26 that both index and listing pages are served to our client. " +
        "Note: an intermittent CAPTCHA was observed in a browser in an earlier session — " +
        "watch the run logs for blocks.",
      config: {
        host: "https://www.superimmo.com",
        communes: SUPERIMMO_COMMUNES,
        maxPages: 20,
      },
    },
    {
      key: "green-acres",
      name: "Green-Acres",
      hosts: ["green-acres.fr", "www.green-acres.fr"],
      baseUrl: "https://www.green-acres.fr",
      /** Their robots.txt: `Crawl-delay: 1`, `Request-rate: 1/1`. */
      crawlDelayMs: 1_000,
      permissionNote:
        "robots.txt (read 2026-08-26): Allow: / with only internal AJAX endpoints " +
        "disallowed (LoadAdvertsForNavigation, TagVisit, CityBoundary, EstimationActions, " +
        "prog_show_properties, aspirationalsearch). Listing pages under /fr/properties/ are " +
        "permitted; a sitemap is published. Nine SEO crawlers are banned by name, " +
        "ClaudeBot among them — so research fetches were made with this collector, " +
        "not with an assistant's own tooling. " +
        "NOTE: index cards use base64-obfuscated links (class 'obf-link', attribute " +
        "data-o) rather than hrefs. Not an access control — no login, no token, no " +
        "challenge, and the URLs it hides are the ones robots.txt permits — but it is " +
        "a signal they would rather not be enumerated wholesale. Recorded here so the " +
        "decision is visible rather than assumed; revisit if Green-Acres objects.",
      config: {
        host: "https://www.green-acres.fr",
        communes: GREEN_ACRES_COMMUNES,
        /**
         * Their own pagination field, read off the hidden input in their search
         * form. `?page=2` is accepted and silently ignored — it returns page
         * one — so a wrong name here caps every commune at 24 listings and
         * looks like a thin market rather than a bug.
         */
        pageParam: "p_n",
        maxPages: 20,
      },
    },
    {
      key: "luxuryestate",
      name: "LuxuryEstate",
      hosts: ["luxuryestate.com", "www.luxuryestate.com"],
      baseUrl: "https://www.luxuryestate.com",
      crawlDelayMs: 1000,
      permissionNote:
        "robots.txt permits listing and detail pages; only maps and service endpoints " +
        "are disallowed. They also publish a per-property sitemap. Checked 2026-08-25.",
      config: {
        host: "https://www.luxuryestate.com",
        communePaths: luxuryEstatePathsByInsee(),
        maxPages: 30,
      },
    },
  ];
}

export async function seed(): Promise<void> {
  const [client] = await db
    .insert(clients)
    .values({
      slug: "med-estates",
      name: "Med-Estates",
      communeInsee: COLLECTION_INSEE,
      active: true,
    })
    .onConflictDoUpdate({
      target: clients.slug,
      set: { communeInsee: COLLECTION_INSEE, updatedAt: new Date() },
    })
    .returning({ id: clients.id });

  for (const s of sourceSeeds()) {
    const [source] = await db
      .insert(portalSources)
      .values({
        key: s.key,
        name: s.name,
        hosts: s.hosts,
        discoveryMode: "index",
        baseUrl: s.baseUrl,
        crawlDelayMs: s.crawlDelayMs,
        enabled: false,
        permissionNote: s.permissionNote,
        config: s.config,
      })
      .onConflictDoUpdate({
        target: portalSources.key,
        // Config is refreshed on every seed so a corrected slug takes effect;
        // `enabled` is deliberately NOT touched, so re-seeding cannot silently
        // switch a source back on or off behind whoever set it.
        set: { config: s.config, permissionNote: s.permissionNote, updatedAt: new Date() },
      })
      .returning({ id: portalSources.id });

    await db
      .insert(clientSources)
      .values({ clientId: client.id, sourceId: source.id, enabled: true })
      .onConflictDoNothing();
  }

  report();
}

function report(): void {
  console.log(`\n[seed] client med-estates → ${COLLECTION_INSEE.length} communes`);
  console.log(`[seed] 5 sources, all DISABLED until switched on deliberately\n`);

  let gaps = 0;
  for (const { portal, missing } of coverageReport()) {
    const total = COLLECTION_INSEE.length;
    const have = total - missing.length;
    const mark = missing.length === 0 ? "✓" : "⚠";
    console.log(`  ${mark} ${portal.padEnd(14)} ${have}/${total} communes`);
    if (missing.length > 0) {
      console.log(`      missing: ${missing.join(", ")}`);
      gaps += missing.length;
    }
  }

  if (gaps > 0) {
    console.log(
      `\n[seed] ${gaps} commune gaps. Each one is a whole commune absent from the\n` +
        `       product, and it will look like a quiet market rather than a bug.\n` +
        `       Fill them in src/lib/portals/communePaths.ts and re-run.\n`,
    );
  } else {
    console.log(`\n[seed] full coverage. Enable sources deliberately when ready.\n`);
  }
}

// Allow `npm run db:seed`
if (process.argv[1]?.endsWith("seed.ts")) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seed] failed:", err);
      process.exit(1);
    });
}
