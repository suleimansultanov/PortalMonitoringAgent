import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clients, clientSources, portalSources } from "@/lib/db/schema";
import { COLLECTION_INSEE, GULF_OF_SAINT_TROPEZ } from "./communes";

/**
 * First-run seed: one client, one source, the subscription between them.
 *
 * Idempotent — safe to re-run after editing the commune slugs below, which will
 * happen, because the ones for Cogolin, Gassin and the rest still have to be
 * read off SMC's own commune index.
 */

/**
 * SMC's internal commune ids, taken from their URLs
 * (`selection-biens-ramatuelle-35951.html`).
 *
 * ⚠️ INCOMPLETE. Six of the twelve are still missing and each one absent here
 * is a whole commune silently absent from the product — the failure looks like
 * a quiet market, not like a bug. The adapter logs a warning per missing code;
 * check the first run's logs before trusting any count.
 */
const SMC_COMMUNE_SLUGS: Record<string, { slug: string; id: string }> = {
  "83101": { slug: "ramatuelle", id: "35951" },
  "83119": { slug: "st-tropez", id: "35969" },
  "83115": { slug: "ste-maxime", id: "35965" },
  "83068": { slug: "grimaud", id: "35918" },
  "83094": { slug: "plan-de-la-tour", id: "35944" },
  "83107": { slug: "les-issambres", id: "36027" },
  // TODO — read from https://www.maisonsetappartements.fr/fr/83-var
  // "83042": Cogolin
  // "83065": Gassin
  // "83048": La Croix-Valmer
  // "83036": Cavalaire-sur-Mer
  // "83078": La Môle
  // "83063": La Garde-Freinet
};

export async function seed(): Promise<void> {
  // ── Client ──────────────────────────────────────────────────────────────
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

  // ── Source ──────────────────────────────────────────────────────────────
  const [source] = await db
    .insert(portalSources)
    .values({
      key: "smc",
      name: "Maisons et Appartements / Résidences Immobilier",
      hosts: [
        "maisonsetappartements.fr",
        "www.maisonsetappartements.fr",
        "residences-immobilier.com",
        "www.residences-immobilier.com",
      ],
      discoveryMode: "index",
      baseUrl: "https://www.maisonsetappartements.fr",
      crawlDelayMs: 1000,
      /**
       * Left OFF. Turning collection on is a decision someone should make
       * deliberately, after checking the commune slugs above and confirming
       * that this source's permission note is still accurate.
       */
      enabled: false,
      permissionNote:
        "maisonsetappartements.fr: robots.txt permits listing pages (legacy .asp paths " +
        "disallowed, current .html open). residences-immobilier.com: robots.txt disallows " +
        "fiche-annonce-*.html — covered by written permission from SMC France, 2026-08-25.",
      config: {
        host: "https://www.maisonsetappartements.fr",
        communeSlugs: SMC_COMMUNE_SLUGS,
        maxPages: 30,
      },
    })
    .onConflictDoUpdate({
      target: portalSources.key,
      set: { config: { host: "https://www.maisonsetappartements.fr", communeSlugs: SMC_COMMUNE_SLUGS, maxPages: 30 }, updatedAt: new Date() },
    })
    .returning({ id: portalSources.id });

  // ── Subscription ────────────────────────────────────────────────────────
  await db
    .insert(clientSources)
    .values({ clientId: client.id, sourceId: source.id, enabled: true })
    .onConflictDoNothing();

  const missing = COLLECTION_INSEE.filter((i) => !SMC_COMMUNE_SLUGS[i]);
  const labels = missing.map(
    (i) => GULF_OF_SAINT_TROPEZ.find((c) => c.insee === i && !c.localityOf)?.label ?? i,
  );

  console.log(`[seed] client med-estates → ${COLLECTION_INSEE.length} communes`);
  console.log(`[seed] source smc → ${Object.keys(SMC_COMMUNE_SLUGS).length} slugs configured`);
  if (missing.length > 0) {
    console.warn(`[seed] ⚠ no SMC slug yet for: ${labels.join(", ")}`);
  }
  console.log("[seed] source is DISABLED — enable it deliberately when the slugs are complete");
}

// Allow `tsx src/lib/portals/seed.ts`
if (process.argv[1]?.endsWith("seed.ts")) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seed] failed:", err);
      process.exit(1);
    });
}
