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
  // Our `smc` source is these two sites; the same advert seen through an aggregator is the same portal.
  "maisonsetappartements.fr": "smc",
  "residences-immobilier.com": "smc",
  "zoopla.co.uk": "zoopla-overseas",
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
  smc: "Maisons et Appartements",
  "sothebysrealty-france": "Sotheby's Realty",
  superimmo: "Superimmo",
  vizzit: "Vizzit",
  zoopla: "Zoopla",
  "zoopla-overseas": "Zoopla Overseas",
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

/** Sources that carry other portals' listings, with the name to say "via". */
export const AGGREGATORS: Record<string, string> = { "stream-estate": "Stream.Estate" };

/**
 * Listing portals: sites where many agencies advertise. Everything else an
 * aggregator carries is one agency's own website — Tardieu, Orpi, a Century
 * 21 office — and listed one by one they were forty rows of a sources table
 * (2026-10-08) that reads as forty portals. They are shown together as
 * AGENCY_SITES, each still linking to its own site. A portal not on this list
 * shows up there too: add it here when it does.
 */
const PORTALS = new Set([
  "seloger", "leboncoin", "logic-immo", "bellesdemeures", "idealista", "pap", "paruvendu",
  "avendrealouer", "ouestfrance-immo", "superimmo", "green-acres", "vizzit", "bienici",
  "luxuryestate", "etreproprio", "jamesedition", "figaro", "figaro-immobilier", "smc",
  "zoopla", "zoopla-overseas", "rightmove", "lux-residence", "french-property", "lamaisondeluxe",
  "notaires", "mansionglobal", "les-terrains", "lesiteimmo", "properstar", "kyero",
]);
export const AGENCY_SITES = { key: "agency-sites", name: "Agency websites" } as const;

/** What a reader should see a link as: its portal, or "Agency websites" for an agency's own site. */
export function shownAs(url: string): { key: string; name: string } | null {
  const p = portalOf(url);
  if (!p) return null;
  return PORTALS.has(p.key) ? p : { ...AGENCY_SITES };
}

/** One portal carrying a property: where the link goes, and who brought it if not us. */
export type PortalLink = { key: string; name: string; url: string; via?: string; publishedAt?: string | null };

/**
 * Every portal an aggregator row carries, from the URLs in its record.
 *
 * A Stream.Estate row is ONE property with ALL its adverts — SeLoger,
 * Leboncoin and Belles Demeures for the same villa — and is stored as one
 * listing with one link. On 2026-10-08, 665 of 2 158 rows carried two to five
 * portals and showed one. The rest are in `raw.listings`.
 */
export function carriedPortals(source: string, url: string, carried: unknown): PortalLink[] {
  const via = AGGREGATORS[source];
  if (!via) return [];
  const entries: { url: string; publishedAt: string | null }[] = [];
  if (Array.isArray(carried)) {
    for (const c of carried) {
      const o = c && typeof c === "object" ? (c as { url?: unknown; publishedAt?: unknown }) : {};
      if (typeof o.url === "string") {
        entries.push({ url: o.url, publishedAt: typeof o.publishedAt === "string" ? o.publishedAt : null });
      }
    }
  }
  // The row's own link last, so a portal named in the record keeps its publication date.
  entries.push({ url, publishedAt: null });
  const out = new Map<string, PortalLink>();
  for (const e of entries) {
    const p = shownAs(e.url);
    if (p && !out.has(p.key)) out.set(p.key, { key: p.key, name: p.name, url: e.url, via, publishedAt: e.publishedAt });
  }
  return [...out.values()];
}

/**
 * The portals carrying a property, one entry per portal.
 *
 * A portal we collect directly wins over the same portal seen through an
 * aggregator: it is our own reading, and listing Vizzit twice — once ours,
 * once via Stream.Estate — would read as two portals. `names` gives the
 * display name of a direct source (the source's own name).
 */
export function portalLinks(
  listings: { source: string; url: string; carried?: unknown }[],
  names: Record<string, string> = {},
): PortalLink[] {
  const direct = new Map<string, PortalLink>();
  const viaAggregator = new Map<string, PortalLink>();
  for (const l of listings) {
    if (!AGGREGATORS[l.source]) {
      if (!direct.has(l.source)) {
        direct.set(l.source, { key: l.source, name: names[l.source] ?? NAMES[l.source] ?? l.source, url: l.url });
      }
      continue;
    }
    for (const p of carriedPortals(l.source, l.url, l.carried)) {
      if (!viaAggregator.has(p.key)) viaAggregator.set(p.key, p);
    }
  }
  for (const key of direct.keys()) viaAggregator.delete(key);
  return [...direct.values(), ...viaAggregator.values()];
}
