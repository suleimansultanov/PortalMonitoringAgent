/**
 * How each portal names our communes.
 *
 * Kept in one file rather than scattered through the adapters, because the
 * failure mode is identical everywhere and it is silent: a missing entry drops
 * a whole commune from the product, and the result looks like a quiet market
 * rather than like a bug. Having them side by side makes a gap visible.
 *
 * These become `portal_sources.config` at seed time. They live in code so they
 * are reviewable in a diff, and in the database so they can be corrected
 * without a deploy.
 */

import { GULF_OF_SAINT_TROPEZ } from "./communes";

/**
 * LuxuryEstate — full paths, read off their own Var commune index.
 *
 * Worth noting: they publish separate pages for Port Grimaud and Les Issambres.
 * Most portals fold districts into their parent commune and leave us fishing
 * them out of the listing text; here they can be collected directly, which is
 * more accurate than any text match.
 */
export const LUXURYESTATE_PATHS: Record<string, string> = {
  "Saint-Tropez": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/saint-tropez",
  "Ramatuelle": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/ramatuelle",
  "Gassin": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/gassin",
  "Grimaud": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/grimaud",
  "Port Grimaud": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/port-grimaud",
  "Cogolin": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/cogolin",
  "Sainte-Maxime": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/sainte-maxime",
  "La Croix-Valmer": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/la-croix-valmer",
  "Cavalaire-sur-Mer": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/cavalaire-sur-mer",
  "La Môle": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/la-mole",
  "La Garde-Freinet": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/la-garde-freinet",
  "Le Plan-de-la-Tour": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/le-plan-de-la-tour",
  "Les Issambres": "/france/provence-alpes-cote-d-azur/var/arrondissement-de-draguignan/les-issambres",
  // Marines de Cogolin has no page of its own — it is a marina district and
  // its stock appears under Cogolin.
};

/**
 * Etreproprio — slug plus the INSEE code, which they embed in the path
 * themselves (`immobilier-vente-saint-tropez-v83119`).
 *
 * That embedding is where ten of our twelve INSEE codes were confirmed from in
 * the first place, so these are the least likely of the three to be wrong.
 */
export const ETREPROPRIO_SLUGS: Record<string, string> = {
  "83119": "saint-tropez",
  "83101": "ramatuelle",
  "83065": "gassin",
  "83068": "grimaud",
  "83042": "cogolin",
  "83115": "sainte-maxime",
  "83048": "la-croix-valmer",
  "83036": "cavalaire-sur-mer",
  "83063": "la-garde-freinet",
  "83094": "plan-de-la-tour",
  // ⚠ UNVERIFIED — derived from their slug convention, not read off their site.
  // Both are also the two INSEE codes that were set from memory rather than
  // observed, so a mistake here fails twice over and silently.
  "83078": "la-mole",
  "83107": "roquebrune-sur-argens",
};

/**
 * SMC — slug plus their own internal commune id, read off their Var index
 * (`selection-biens-ramatuelle-35951.html`). The id is theirs and cannot be
 * guessed.
 *
 * A LIST rather than a map keyed by INSEE, because they publish district pages
 * — Port Grimaud and Marines de Cogolin have their own — and a district shares
 * its parent's INSEE code. Keyed by INSEE, one of the pair would silently
 * overwrite the other and half a commune's stock would vanish.
 *
 * Note their abbreviations: `st-tropez`, `ste-maxime`. Guessing "saint-tropez"
 * returns nothing at all, quietly.
 */
export type SmcCommune = { insee: string; slug: string; id: string; label: string };

export const SMC_COMMUNES: SmcCommune[] = [
  { insee: "83119", slug: "st-tropez", id: "35969", label: "Saint-Tropez" },
  { insee: "83101", slug: "ramatuelle", id: "35951", label: "Ramatuelle" },
  { insee: "83065", slug: "gassin", id: "35915", label: "Gassin" },
  { insee: "83068", slug: "grimaud", id: "35918", label: "Grimaud" },
  { insee: "83068", slug: "port-grimaud", id: "36005", label: "Port Grimaud" },
  { insee: "83042", slug: "cogolin", id: "35892", label: "Cogolin" },
  { insee: "83042", slug: "marines-de-cogolin", id: "39127", label: "Marines de Cogolin" },
  { insee: "83115", slug: "ste-maxime", id: "35965", label: "Sainte-Maxime" },
  { insee: "83048", slug: "la-croix-valmer", id: "35898", label: "La Croix-Valmer" },
  { insee: "83036", slug: "cavalaire-sur-mer", id: "35886", label: "Cavalaire-sur-Mer" },
  { insee: "83078", slug: "la-mole", id: "35929", label: "La Môle" },
  { insee: "83063", slug: "la-garde-freinet", id: "35913", label: "La Garde-Freinet" },
  { insee: "83094", slug: "le-plan-de-la-tour", id: "35944", label: "Le Plan-de-la-Tour" },
  { insee: "83107", slug: "les-issambres", id: "36027", label: "Les Issambres" },
  /**
   * Roquebrune-sur-Argens itself (35957) is deliberately NOT collected. Only
   * Les Issambres was asked for, and Les Issambres has its own page — pulling
   * the whole commune would add inland stock nobody wants and inflate every
   * count for a market the client does not work in.
   */
];

/**
 * Superimmo — slug plus postcode, both in the path
 * (`/achat/.../var/saint-tropez-83990`).
 *
 * ⚠ Six of twelve. The confirmed ones were read off their own "villes voisines"
 * block; the rest need looking up rather than guessing, because several of these
 * communes share a postcode (Grimaud, Cogolin and La Môle are all 83310) and a
 * wrong pairing returns an empty page rather than an error.
 */
export type SuperimmoCommune = { insee: string; slug: string; postcode: string; label: string };

export const SUPERIMMO_COMMUNES: SuperimmoCommune[] = [
  { insee: "83119", slug: "saint-tropez", postcode: "83990", label: "Saint-Tropez" },
  { insee: "83101", slug: "ramatuelle", postcode: "83350", label: "Ramatuelle" },
  { insee: "83065", slug: "gassin", postcode: "83580", label: "Gassin" },
  { insee: "83068", slug: "grimaud", postcode: "83310", label: "Grimaud" },
  { insee: "83042", slug: "cogolin", postcode: "83310", label: "Cogolin" },
  { insee: "83115", slug: "sainte-maxime", postcode: "83120", label: "Sainte-Maxime" },
  { insee: "83048", slug: "la-croix-valmer", postcode: "83420", label: "La Croix-Valmer" },
  { insee: "83036", slug: "cavalaire-sur-mer", postcode: "83240", label: "Cavalaire-sur-Mer" },
  // TODO — read from https://www.superimmo.com/achat/provence-alpes-cote-d-azur/var
  //   83078 La Môle · 83063 La Garde-Freinet · 83094 Le Plan-de-la-Tour
  //   83107 Les Issambres (a locality — may sit under Roquebrune-sur-Argens)
];

/**
 * Green-Acres — a plain slug under `/immobilier/`.
 *
 * Every one of these was READ OFF their own sitemap
 * (`sitemap-cities-real-estate/1.xml.gz`), not inferred from a slug convention.
 * That distinction has already cost this project twice, so it is worth stating:
 * nothing below is a guess.
 *
 * Twelve of twelve, and notably the only source so far that carries La Môle,
 * La Garde-Freinet and Le Plan-de-la-Tour — the three Superimmo is missing. The
 * two portals cover each other's holes, which is an argument for running both
 * even where their stock overlaps.
 *
 * Port Grimaud and Les Issambres have their own pages here, as on SMC and
 * LuxuryEstate, so the districts can be collected directly rather than fished
 * out of listing prose.
 */
export type GreenAcresCommune = { insee: string; slug: string; label: string };

export const GREEN_ACRES_COMMUNES: GreenAcresCommune[] = [
  { insee: "83119", slug: "saint-tropez", label: "Saint-Tropez" },
  { insee: "83101", slug: "ramatuelle", label: "Ramatuelle" },
  { insee: "83065", slug: "gassin", label: "Gassin" },
  { insee: "83068", slug: "grimaud", label: "Grimaud" },
  { insee: "83068", slug: "port-grimaud", label: "Port Grimaud" },
  { insee: "83042", slug: "cogolin", label: "Cogolin" },
  { insee: "83115", slug: "sainte-maxime", label: "Sainte-Maxime" },
  { insee: "83048", slug: "la-croix-valmer", label: "La Croix-Valmer" },
  { insee: "83036", slug: "cavalaire-sur-mer", label: "Cavalaire-sur-Mer" },
  { insee: "83078", slug: "la-mole", label: "La Môle" },
  { insee: "83063", slug: "la-garde-freinet", label: "La Garde-Freinet" },
  { insee: "83094", slug: "le-plan-de-la-tour", label: "Le Plan-de-la-Tour" },
  { insee: "83107", slug: "les-issambres", label: "Les Issambres" },
  /**
   * Marines de Cogolin has no page of its own in their sitemap; its stock sits
   * under Cogolin and is separated afterwards by the locality text match in
   * communes.ts, as everywhere else.
   *
   * Rayol-Canadel-sur-Mer does have a page here, and it is deliberately NOT
   * collected — the client asked for fourteen places and that is not one of
   * them. Adding a neighbouring commune because a portal happens to publish it
   * would inflate every count in the product against a market Med-Estates does
   * not work in.
   */
  /**
   * As on SMC: Roquebrune-sur-Argens proper is not collected. Only Les
   * Issambres was asked for, and it has its own page — taking the whole commune
   * would add inland stock the client does not work in and inflate every count.
   */
];

/** LuxuryEstate keys on our display labels, so map them back to INSEE. */
export function luxuryEstatePathsByInsee(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of GULF_OF_SAINT_TROPEZ) {
    const path = LUXURYESTATE_PATHS[entry.label];
    // A district page is preferred over the parent commune's when one exists —
    // it is a narrower, more accurate query for the same stock.
    if (path && (!out[entry.insee] || entry.localityOf)) out[entry.insee] = path;
  }
  return out;
}

/** What is still unconfigured, for the seed script to shout about. */
export function coverageReport(): { portal: string; missing: string[] }[] {
  const byInsee = new Map(
    GULF_OF_SAINT_TROPEZ.filter((c) => !c.localityOf).map((c) => [c.insee, c.label]),
  );
  const all = [...byInsee.keys()];

  const lux = luxuryEstatePathsByInsee();

  return [
    {
      portal: "luxuryestate",
      missing: all.filter((i) => !lux[i]).map((i) => byInsee.get(i) ?? i),
    },
    {
      portal: "etreproprio",
      missing: all.filter((i) => !ETREPROPRIO_SLUGS[i]).map((i) => byInsee.get(i) ?? i),
    },
    {
      portal: "smc",
      missing: all
        .filter((i) => !SMC_COMMUNES.some((c) => c.insee === i))
        .map((i) => byInsee.get(i) ?? i),
    },
    {
      portal: "superimmo",
      missing: all
        .filter((i) => !SUPERIMMO_COMMUNES.some((c) => c.insee === i))
        .map((i) => byInsee.get(i) ?? i),
    },
    {
      portal: "green-acres",
      missing: all
        .filter((i) => !GREEN_ACRES_COMMUNES.some((c) => c.insee === i))
        .map((i) => byInsee.get(i) ?? i),
    },
  ];
}
