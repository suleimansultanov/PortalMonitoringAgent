/**
 * Which site a listing URL is on, read off the URL itself.
 *
 * WHY THE HOST AND NOT THE AGGREGATOR'S LABEL. Stream.Estate names each
 * listing's source with a slug, and the slug is derived from the domain the
 * naive way: everything on a `.co.uk` domain is filed as `co`. On 2026-10-07
 * that hid Rightmove (28 listings) and Patrice Besse behind one meaningless
 * label. The URL is the thing a reader clicks, so it is the thing that says
 * where the advert is.
 *
 * WHY IT MATTERS ON SCREEN. A listing collected through an aggregator is
 * stored under the aggregator's source, so without this the card says
 * "Stream.Estate" and the link opens Belles Demeures. The agent wants to know
 * which portal the villa is advertised on; who carried it to us is second.
 */

/** Public suffixes of two labels that occur here. One-label TLDs need no list. */
const TWO_LABEL_SUFFIXES = new Set(["co.uk", "org.uk", "com.au", "co.nz", "com.br", "co.za", "com.es", "com.mx"]);

/**
 * Hosts whose registrable domain carries more than one portal. Propriétés Le
 * Figaro and Figaro Immobilier are both `lefigaro.fr`, and they are two
 * sources here with separate adapters — the keys are ours, so a listing from
 * either lines up with the source we would collect it as directly.
 */
const BY_HOST: Record<string, string> = {
  "proprietes.lefigaro.fr": "figaro",
  "immobilier.lefigaro.fr": "figaro-immobilier",
};

/** Display names where the domain does not spell the brand. Anything else shows its host. */
const NAMES: Record<string, string> = {
  bellesdemeures: "Belles Demeures",
  bienici: "Bien'ici",
  century21: "Century 21",
  etreproprio: "Etreproprio",
  figaro: "Propriétés Le Figaro",
  "figaro-immobilier": "Figaro Immobilier",
  "french-property": "French Property",
  "green-acres": "Green-Acres",
  "guy-hoquet": "Guy Hoquet",
  idealista: "Idealista",
  jamesedition: "JamesEdition",
  knightfrank: "Knight Frank",
  kretzrealestate: "Kretz",
  lamaisondeluxe: "La Maison de Luxe",
  leboncoin: "Leboncoin",
  "lux-residence": "Lux-Residence",
  luxuryestate: "LuxuryEstate",
  maisonsetappartements: "Maisons et Appartements",
  notaires: "Notaires de France",
  orpi: "Orpi",
  pap: "PAP",
  paruvendu: "ParuVendu",
  "patrice-besse": "Patrice Besse",
  remax: "RE/MAX",
  rightmove: "Rightmove",
  seloger: "SeLoger",
  "sothebysrealty-france": "Sotheby's Realty",
  superimmo: "Superimmo",
  vizzit: "Vizzit",
  zoopla: "Zoopla",
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * The site's key: the label before the public suffix, so
 * `immobilier.notaires.fr` → `notaires` and `rightmove.co.uk` → `rightmove`.
 * Matches Stream.Estate's own slugs wherever theirs are right.
 */
export function portalKey(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  if (BY_HOST[host]) return BY_HOST[host];
  const labels = host.split(".");
  if (labels.length < 2) return null;
  const suffixLabels = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
  return labels[labels.length - suffixLabels - 1] ?? null;
}

/** Key and display name, or null when the URL does not parse. */
export function portalOf(url: string): { key: string; name: string } | null {
  const key = portalKey(url);
  if (!key) return null;
  return { key, name: NAMES[key] ?? hostOf(url)! };
}
