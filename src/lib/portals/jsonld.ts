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

/**
 * Containers whose children are real nodes, not properties of the parent.
 *
 * `@graph` is the documented one. `itemListElement` and `item` are how SMC
 * buries the agency block — `ItemList → itemListElement[] → item →
 * RealEstateAgent` — and without descending into them the agency's postal
 * address and phone are simply invisible. That cost a failing test to find,
 * which is the cheapest place to find it.
 */
function pushFlattened(node: unknown, out: JsonLdNode[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) pushFlattened(n, out);
    return;
  }

  const obj = node as JsonLdNode;

  if (Array.isArray(obj["@graph"])) {
    // A @graph wrapper carries nothing of its own beyond its children.
    for (const n of obj["@graph"] as unknown[]) pushFlattened(n, out);
    return;
  }

  // The wrapper itself is still worth keeping — an ItemList may carry a url or
  // a count someone wants — so this pushes rather than returns.
  out.push(obj);

  if (Array.isArray(obj.itemListElement)) {
    for (const n of obj.itemListElement as unknown[]) pushFlattened(n, out);
  }
  // ListItem wraps its payload in `item`.
  if (obj.item && typeof obj.item === "object") {
    pushFlattened(obj.item, out);
  }
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

/**
 * `address` is sometimes a PostalAddress object, sometimes a bare string.
 *
 * When it is a string the postcode is dug out of it rather than left null, and
 * that is not cosmetic: agency identity is `(normalised name, postcode)`. Every
 * agency whose address arrived as prose would otherwise share a NULL postcode
 * and collide with every other one — turning "BARNES Saint-Tropez" and "BARNES
 * Cannes" into a single agency, and every count built on them into nonsense.
 */
export function readAddress(v: unknown): {
  full: string | null;
  street: string | null;
  locality: string | null;
  postalCode: string | null;
} {
  if (typeof v === "string") {
    const full = v.trim() || null;
    if (!full) return { full: null, street: null, locality: null, postalCode: null };

    // French postcodes are five digits. Anchored on word boundaries so a house
    // number or a floor area cannot be mistaken for one.
    const m = full.match(/\b(\d{5})\b/);
    if (!m) return { full, street: null, locality: null, postalCode: null };

    const postalCode = m[1];
    const after = full.slice((m.index ?? 0) + postalCode.length).replace(/^[,\s]+/, "").trim();
    const before = full.slice(0, m.index ?? 0).replace(/[,\s]+$/, "").trim();

    return {
      full,
      street: before || null,
      locality: after || null,
      postalCode,
    };
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
