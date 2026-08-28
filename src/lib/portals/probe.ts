/**
 * Which portals will actually serve us.
 *
 * This exists because the first classification of "easy" was built on
 * robots.txt — on what each site SAYS is allowed. Two of the three portals we
 * built adapters for turned out to refuse our client anyway: robots.txt is
 * written for search engines, and the protection in front of the site has never
 * read it.
 *
 * So: stop inferring, measure. One index page and one listing page per portal,
 * fetched with the real collector, and a table of who answered.
 *
 *   npm run probe
 *
 * Deliberately gentle: two requests per portal, spaced, in the order listed.
 * It is a knock on the door, not a crawl.
 */

import { createFetcher, BlockedError, FetchFailedError } from "./runner/fetcher";

type Target = {
  portal: string;
  /** Written permission on file, or open by robots.txt. */
  basis: "open" | "permission" | "blocks-us-by-name";
  index: string;
  listing: string;
};

/**
 * Real URLs, all verified to exist by loading them elsewhere. If one 404s the
 * portal has moved something and the entry needs updating — that is a different
 * result from being refused, and the probe reports them differently.
 */
const TARGETS: Target[] = [
  {
    portal: "luxuryestate",
    basis: "open",
    index: "https://www.luxuryestate.com/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/ramatuelle",
    listing: "https://www.luxuryestate.com/p131935162-villa-for-sale-ramatuelle",
  },
  {
    portal: "smc (maisonsetappartements)",
    basis: "permission",
    index: "https://www.maisonsetappartements.fr/fr/83/biens/vente/selection-biens-ramatuelle-35951.html",
    listing: "https://www.maisonsetappartements.fr/fr/83/annonce-vente-maison-ramatuelle-4241469.html",
  },
  {
    portal: "smc (residences-immobilier)",
    basis: "permission",
    index: "https://www.residences-immobilier.com/fr/83/maisons/vente/listing-biens-ramatuelle-35951.html",
    listing: "https://www.residences-immobilier.com/fr/83/annonce-vente-maison-ramatuelle-4426627.html",
  },
  {
    portal: "etreproprio",
    basis: "open",
    index: "https://www.etreproprio.com/immobilier-vente-ramatuelle-v83101/maison",
    listing: "https://www.etreproprio.com/immobilier-26534913-vente-saint-tropez-domaine-de-deux-villas-provencales-au-chemin-de-la-moutte-saint-tropez",
  },
  {
    portal: "jamesedition",
    basis: "open",
    index: "https://www.jamesedition.com/real_estate/ramatuelle-france",
    listing: "https://www.jamesedition.com/real_estate/saint-tropez-france/saint-tropez-magnificent-charming-property-with-sea-view-18071317",
  },
  {
    portal: "proprietes-lefigaro",
    basis: "permission",
    index: "https://proprietes.lefigaro.fr/annonces/maison-var-provence+alpes+cote+d+azur-france/",
    listing: "https://proprietes.lefigaro.fr/sitemap/plf-fr/sitemap_index.xml",
  },
  {
    portal: "superimmo",
    basis: "open",
    index: "https://www.superimmo.com/achat/provence-alpes-cote-d-azur/var/ramatuelle-83350",
    listing: "https://www.superimmo.com/annonces/achat-maison-160m-saint-tropez-83990-x10ewng",
  },
  {
    portal: "green-acres",
    basis: "blocks-us-by-name",
    index: "https://www.green-acres.fr/property-for-sale/ramatuelle",
    listing: "https://www.green-acres.fr/property-for-sale/saint-tropez",
  },
  {
    portal: "seloger (aviv)",
    basis: "permission",
    index: "https://www.seloger.com/recherche/achat/maison/provence-alpes-cote-d-azur/saint-tropez-83990/ad08fr34360",
    listing: "https://www.bellesdemeures.com/252282811/detail.htm",
  },
];

type Result = {
  portal: string;
  basis: Target["basis"];
  index: string;
  listing: string;
};

function describe(err: unknown): string {
  if (err instanceof BlockedError) return `blocked (${err.signal})`;
  if (err instanceof FetchFailedError) {
    if (err.status === 404 || err.status === 410) return `404 — url moved, fix the probe`;
    return `refused (${err.status ?? "?"})`;
  }
  return `error (${(err as Error).message.slice(0, 40)})`;
}

async function probeOne(url: string): Promise<string> {
  // Three seconds between requests, and a fresh fetcher per portal so one
  // slow site does not delay the next.
  const fetcher = createFetcher({ delayMs: 3000, attempts: 1, timeoutMs: 20_000 });
  try {
    const body = await fetcher(url);
    // A page that answers but carries nothing is not a working source.
    if (body.length < 2000) return `thin (${body.length}b)`;
    return "ok";
  } catch (err) {
    return describe(err);
  }
}

export async function probe(): Promise<void> {
  console.log(`\nProbing ${TARGETS.length} portals with the real collector.`);
  console.log(`user-agent: ${process.env.CRAWLER_USER_AGENT ?? "(default)"}\n`);

  const results: Result[] = [];

  for (const t of TARGETS) {
    process.stdout.write(`  ${t.portal.padEnd(30)}`);
    const index = await probeOne(t.index);
    const listing = await probeOne(t.listing);
    results.push({ portal: t.portal, basis: t.basis, index, listing });
    console.log(`index: ${index.padEnd(22)} listing: ${listing}`);
  }

  const usable = results.filter((r) => r.index === "ok" && r.listing === "ok");
  const partial = results.filter(
    (r) => (r.index === "ok") !== (r.listing === "ok"),
  );
  const refused = results.filter((r) => r.index !== "ok" && r.listing !== "ok");

  console.log(`\n── verdict ──`);
  console.log(`  usable now   ${usable.length}: ${usable.map((r) => r.portal).join(", ") || "—"}`);
  console.log(`  half open    ${partial.length}: ${partial.map((r) => r.portal).join(", ") || "—"}`);
  console.log(`  refusing us  ${refused.length}: ${refused.map((r) => r.portal).join(", ") || "—"}`);

  const withPermission = refused.filter((r) => r.basis === "permission");
  if (withPermission.length > 0) {
    console.log(
      `\n  ${withPermission.length} of the refusals are portals that gave WRITTEN PERMISSION:\n` +
        `  ${withPermission.map((r) => r.portal).join(", ")}\n` +
        `  That is not a technical problem — it is the allowlisting they still owe us.`,
    );
  }

  console.log(
    `\nBuild adapters for the usable ones first. Everything else is a\n` +
      `conversation, not an engineering task.\n`,
  );
}

if (process.argv[1]?.endsWith("probe.ts")) {
  probe()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("probe failed:", err);
      process.exit(1);
    });
}
