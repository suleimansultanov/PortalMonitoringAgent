import * as cheerio from "cheerio";

/**
 * JSON-LD extraction.
 *
 * Every portal we collect from publishes schema.org markup, because it drives
 * their own rich results in search. That gives us a layer they are commercially
 * motivated to keep stable — unlike their CSS, which changes with the season.
 * Parsers should read this first and fall back to selectors only for fields
 * that genuinely are not here.
 */

export type JsonLdNode = Record<string, unknown> & { "@type"?: unknown };

/**
 * All JSON-LD nodes on a page, flattened.
 *
 * Flattening matters: portals nest these three different ways. Some emit one
 * script per node, some emit an array, and some wrap everything in `@graph`.
 * Callers should not have to care which.
 */
export function extractJsonLd(html: string): JsonLdNode[] {
  const $ = cheerio.load(html);
  const out: JsonLdNode[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).contents().text().trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A malformed block is not worth failing the page over — the useful one
      // is usually a different block entirely.
      return;
    }
    pushFlattened(parsed, out);
  });

  return out;
}

function pushFlattened(node: unknown, out: JsonLdNode[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) pushFlattened(n, out);
    return;
  }
  const obj = node as JsonLdNode;
  if (Array.isArray(obj["@graph"])) {
    for (const n of obj["@graph"] as unknown[]) pushFlattened(n, out);
    // A @graph wrapper carries no data of its own beyond its children.
    return;
  }
  out.push(obj);
}

/** `@type` can be a string or an array. Normalise to a lowercase set. */
export function typesOf(node: JsonLdNode): Set<string> {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : [t];
  return new Set(list.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()));
}

export function nodesOfType(nodes: JsonLdNode[], ...wanted: string[]): JsonLdNode[] {
  const want = new Set(wanted.map((w) => w.toLowerCase()));
  return nodes.filter((n) => [...typesOf(n)].some((t) => want.has(t)));
}

/**
 * The single node describing THIS page's property.
 *
 * This helper exists because of a trap that would otherwise be very expensive.
 * At least one portal emits ten extra property-shaped nodes per page — the
 * "similar listings" carousel at the bottom. They carry bedroom counts and an
 * address but no URL, no price and no identifier. A parser that grabs every
 * property-like node invents ten phantom listings on every page it visits, and
 * the counts look plausible enough that nobody notices for weeks.
 *
 * So: prefer a node that carries an offer or a URL. Anonymous nodes are
 * decoration, not data.
 */
export function primaryOfferNode(nodes: JsonLdNode[]): JsonLdNode | null {
  const candidates = nodesOfType(
    nodes,
    "Product",
    "RealEstateListing",
    "SingleFamilyResidence",
    "House",
    "Apartment",
    "Residence",
  );
  if (candidates.length === 0) return null;

  const identified = candidates.filter((n) => Boolean(n.offers) || typeof n.url === "string");
  if (identified.length === 0) return null;

  // Prefer one that actually has an offer — that is the node with the price.
  return identified.find((n) => Boolean(n.offers)) ?? identified[0];
}

// ── Small readers, all tolerant of the shapes portals actually emit ─────────

export function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    // "1 900 000 €", "9,500,000", "240,62 m²" — strip everything but digits and
    // separators, then decide which separator was decimal.
    const cleaned = v.replace(/[^\d.,-]/g, "");
    if (!cleaned) return null;
    const normalised =
      cleaned.includes(",") && cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
    const n = Number(normalised);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Follow `offers`, which may be an object or an array of them. */
export function firstOffer(node: JsonLdNode): JsonLdNode | null {
  const o = node.offers;
  if (!o || typeof o !== "object") return null;
  if (Array.isArray(o)) return (o.find((x) => x && typeof x === "object") as JsonLdNode) ?? null;
  return o as JsonLdNode;
}

/** `address` is sometimes a PostalAddress object, sometimes a bare string. */
export function readAddress(v: unknown): {
  full: string | null;
  street: string | null;
  locality: string | null;
  postalCode: string | null;
} {
  if (typeof v === "string") {
    return { full: v.trim() || null, street: null, locality: null, postalCode: null };
  }
  if (v && typeof v === "object") {
    const a = v as Record<string, unknown>;
    const street = str(a.streetAddress);
    const locality = str(a.addressLocality);
    const postalCode = str(a.postalCode);
    const full = [street, postalCode, locality].filter(Boolean).join(", ") || null;
    return { full, street, locality, postalCode };
  }
  return { full: null, street: null, locality: null, postalCode: null };
}
