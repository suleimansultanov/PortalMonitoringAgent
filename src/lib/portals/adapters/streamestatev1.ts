import { z } from "zod";
import { GULF_OF_SAINT_TROPEZ } from "../communes";
import { portalKey } from "../portalOf";
import {
  BudgetError,
  createV1Client,
  V1_DEFAULT_ANCHOR_DAY,
  V1_DEFAULT_RESERVE,
  V1_PAGE,
  V1_PLAN_ITEMS,
  type V1Client,
} from "../streamV1";
import { emptyListing, type DiscoverContext, type DiscoveredListing, type ParseResult, type PortalAdapter } from "../types";

/**
 * Stream.Estate V1 (api.stream.estate) — the paid API, read for what V2 lacks.
 * Written 2026-10-14, the day the client's Starter plan went live.
 *
 * WHY, WHEN V2 IS FREE. V2 starts on 24 June 2026 and, in the gulf, carries
 * no Propriétés Le Figaro, Figaro Immobilier or Superimmo at all. V1 does:
 * 107 of 711 live adverts in a September sample were Figaro's. Both Figaro
 * sites refuse our collector from every address, so this is the only route
 * to them that is not a letter. V1 also holds listings created before June
 * that are still live and absent from V2.
 *
 * WHAT IT COSTS, AND THE SHAPE THAT FOLLOWS. One item per property returned,
 * 15 000 a month, then the client's card. So this adapter never reads the
 * market whole each night the way every other one does. It reads the stock
 * ONCE — properties not expired and touched in the last `freshDays` — and
 * then, every night, only what their API says changed since our last pass:
 * created, re-priced, expired. Measured for nothing on 2026-10-13: 5 455 in
 * stock, ~131 created, ~26 re-priced and ~46 expired a day. About 11 500
 * items the first month, ~6 000 after.
 *
 * A changes-only pass sees a fraction of the market by design. Two things
 * keep the runner from reading that as the market vanishing: the source's
 * `changesOnly` config, which turns the abort guard off and marks the pass
 * incomplete so nothing is delisted for being unseen; and `ctx.gone`, through
 * which the properties their API reports expired are delisted BY NAME. There
 * is no Sunday full sweep for this source — four of them would be the month.
 *
 * Every request goes through the meter in `streamV1.ts`: a ledger in the
 * database, a cap checked before each paid page, no retries. When the cap is
 * reached the pass stops, says so, and the next night carries on.
 *
 * THEIR DATES ARE THEIRS. `createdAt` is when Stream.Estate first saw a
 * listing, not when the portal published it (Thomas, in writing, 2026-10-09).
 * It is kept in `raw` and never stored as `publishedAt`.
 */

const SOURCE_KEY = "stream-estate-v1";

/** Portals we collect directly, as their URLs name them: a property seen only there is already ours. */
const OWN_SOURCES = ["vizzit", "bienici", "luxuryestate", "green-acres", "etreproprio"];

/**
 * Where a commune is asked for by something narrower than its INSEE code:
 * 83107 is all of Roquebrune-sur-Argens, the client's place is Les Issambres,
 * and the postcode REPLACES the INSEE code — sent together they are a union.
 */
const LOCATION: Record<string, { param: string; value: string }> = {
  "83107": { param: "includedZipcodes[]", value: "83380" },
};

const PROPERTY_TYPES: Record<number, string> = {
  0: "Appartement",
  1: "Maison",
  2: "Immeuble",
  3: "Parking",
  4: "Bureau",
  5: "Terrain",
  6: "Commerce",
};

// ── Their shapes, loosely: everything else passes through untouched ──────────
const Advert = z
  .object({
    uuid: z.string().optional(),
    url: z.string().optional().nullable(),
    expired: z.boolean().optional().nullable(),
    createdAt: z.string().optional().nullable(),
    price: z.number().optional().nullable(),
    contactReference: z.string().optional().nullable(),
    contact: z.object({ agency: z.string().optional().nullable(), reference: z.string().optional().nullable() }).passthrough().optional().nullable(),
    publisher: z.object({ name: z.string().optional().nullable() }).passthrough().optional().nullable(),
    picturesRemote: z.array(z.string()).optional().nullable(),
    events: z
      .array(
        z
          .object({
            createdAt: z.string().optional().nullable(),
            fieldName: z.string().optional().nullable(),
            fieldOldValue: z.unknown().optional(),
            fieldNewValue: z.unknown().optional(),
            percentVariation: z.number().optional().nullable(),
          })
          .passthrough(),
      )
      .optional()
      .nullable(),
  })
  .passthrough();

const Property = z
  .object({
    uuid: z.string(),
    createdAt: z.string().optional().nullable(),
    expired: z.boolean().optional().nullable(),
    transactionType: z.number().optional().nullable(),
    propertyType: z.number().optional().nullable(),
    price: z.number().optional().nullable(),
    surface: z.number().optional().nullable(),
    landSurface: z.number().optional().nullable(),
    room: z.number().optional().nullable(),
    bedroom: z.number().optional().nullable(),
    title: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    pictures: z.array(z.string()).optional().nullable(),
    city: z.object({ insee: z.string().optional().nullable(), name: z.string().optional().nullable(), zipcode: z.string().optional().nullable() }).passthrough().optional().nullable(),
    location: z.object({ lat: z.number(), lon: z.number() }).passthrough().optional().nullable(),
    adverts: z.array(Advert).optional().nullable(),
  })
  .passthrough();
type PropertyT = z.infer<typeof Property>;

/** The document stored per property: what parse needs, nothing that moves on its own. */
export type StreamV1Record = {
  id: string;
  property: Record<string, unknown>;
  /** Live adverts only: a listing taken down is not a place the property is shown. */
  listings: { source: string; url: string; firstSeenByThem: string | null; price: number | null; agency: string | null; reference: string | null }[];
  /** Price changes on any of its adverts, as their events record them. */
  priceEvents: { at: string; from: number | null; to: number | null; pct: number | null; url: string | null }[];
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const toNum = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export function toRecord(p: PropertyT): StreamV1Record {
  const listings: StreamV1Record["listings"] = [];
  const priceEvents: StreamV1Record["priceEvents"] = [];
  for (const a of p.adverts ?? []) {
    const url = str(a.url);
    for (const e of a.events ?? []) {
      if (e.fieldName !== "price") continue;
      priceEvents.push({ at: str(e.createdAt) ?? "", from: toNum(e.fieldOldValue), to: toNum(e.fieldNewValue), pct: e.percentVariation ?? null, url });
    }
    if (a.expired || !url) continue;
    const source = portalKey(url) ?? str(a.publisher?.name)?.toLowerCase() ?? "unnamed";
    listings.push({
      source,
      url,
      firstSeenByThem: str(a.createdAt),
      price: num(a.price),
      agency: str(a.contact?.agency),
      reference: str(a.contactReference) ?? str(a.contact?.reference),
    });
  }
  // `updatedAt` and `lastCrawledAt` move on every re-crawl; `adverts` is folded above.
  const { updatedAt: _u, lastCrawledAt: _l, lastCrawledAdvert: _a, adverts: _ads, ...property } = p as Record<string, unknown>;
  return { id: p.uuid, property, listings, priceEvents };
}

/** The listing to link to: on a portal we do not collect, else any. Newest by their first sighting. */
function primary(rec: StreamV1Record, own: string[]) {
  const byDate = [...rec.listings].sort((a, b) => (b.firstSeenByThem ?? "").localeCompare(a.firstSeenByThem ?? ""));
  return byDate.find((l) => !own.includes(l.source)) ?? byDate[0] ?? null;
}

function base(insee: string): URLSearchParams {
  const q = new URLSearchParams();
  const loc = LOCATION[insee];
  if (loc) q.append(loc.param, loc.value);
  else q.append("includedInseeCodes[]", insee);
  q.set("transactionType", "0"); // sale
  return q;
}

/** Their format: `2021-05-07 12:42:42`, read in their own time zone; an hour's slack covers the difference. */
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

export type V1Deps = {
  client: (config: Record<string, unknown>) => V1Client | Promise<V1Client>;
  lastPassAt: () => Promise<Date | null>;
  /** Whether we already hold live listings from this source in a commune. */
  hasStock: (communeInsee: string) => Promise<boolean>;
  now?: () => Date;
};

export function makeStreamEstateV1Adapter(deps: V1Deps): PortalAdapter {
  const now = deps.now ?? (() => new Date());
  return {
    key: SOURCE_KEY,
    name: "Stream.Estate V1",
    hosts: ["api.stream.estate"],
    discoveryMode: "index",
    /** Ours: their limit is per item, not per minute. */
    defaultCrawlDelayMs: 500,

    async *discover(ctx: DiscoverContext): AsyncIterable<DiscoveredListing> {
      const own = (ctx.config.ownSources as string[] | undefined) ?? OWN_SOURCES;
      const freshDays = Number(ctx.config.freshDays ?? 30);
      const client = await deps.client(ctx.config);
      const since = await deps.lastPassAt();
      const t = await client.totals();
      console.log(
        `[${SOURCE_KEY}] period from ${client.periodStart.toISOString().slice(0, 10)}: ${t.items} items counted, cap ${client.cap}, ` +
          `${await client.remaining()} left — ${since ? `changes since ${since.toISOString().slice(0, 16)}` : `no completed pass yet: taking the stock (updated ≤${freshDays}d)`}`,
      );

      let stopped: string | null = null;
      const walk = async function* (insee: string, q: URLSearchParams, what: string) {
        q.set("order[createdAt]", "asc"); // a property created while we walk lands on the last page, not amid the ones read
        q.set("itemsPerPage", String(V1_PAGE));
        for (let page = 1; ; page++) {
          q.set("page", String(page));
          let r;
          try {
            r = await client.call(q);
          } catch (err) {
            if (err instanceof BudgetError) {
              stopped = `${what} for ${insee}, page ${page}: ${err.message}`;
              return;
            }
            throw err;
          }
          for (const raw of r.items) {
            const parsed = Property.safeParse(raw);
            if (parsed.success) yield parsed.data;
          }
          if (r.items.length < V1_PAGE || page * V1_PAGE >= r.total) return;
          if (!r.fromCache) await new Promise((res) => setTimeout(res, 300));
        }
      };

      for (const insee of ctx.communeInsee) {
        if (stopped) {
          ctx.incomplete(insee, `not asked: ${stopped}`);
          continue;
        }
        const seen = new Set<string>();
        let kept = 0;
        let gone = 0;
        const dropped = { ours: 0, noListing: 0, wrongCommune: 0 };
        const take = (p: PropertyT): DiscoveredListing | null => {
          if (seen.has(p.uuid)) return null;
          seen.add(p.uuid);
          const insee_ = str(p.city?.insee);
          if (insee_ && insee_ !== insee) {
            dropped.wrongCommune += 1;
            return null;
          }
          if (p.transactionType !== 0) return null;
          const rec = toRecord(p);
          if (rec.listings.length === 0) {
            dropped.noListing += 1;
            return null;
          }
          if (rec.listings.every((l) => own.includes(l.source))) {
            dropped.ours += 1;
            return null;
          }
          kept += 1;
          return { externalId: rec.id, url: primary(rec, own)!.url, communeHint: insee, document: JSON.stringify(rec) };
        };

        // Per commune: a pass that stopped at the cap leaves the communes it never reached without stock.
        const stock = !since || !(await deps.hasStock(insee));
        if (stock) {
          const q = base(insee);
          q.set("expired", "false");
          q.set("fromUpdatedAt", new Date(now().getTime() - freshDays * 86_400_000).toISOString().slice(0, 10));
          for await (const p of walk(insee, q, "stock")) {
            const d = take(p);
            if (d) yield d;
          }
        } else {
          // Changes since the last pass, with an hour's slack: their clock, their zone.
          const from = stamp(new Date(since!.getTime() - 3_600_000));
          const created = base(insee);
          created.set("fromDate", from);
          created.set("expired", "false");
          for await (const p of walk(insee, created, "created")) {
            const d = take(p);
            if (d) yield d;
          }
          const repriced = base(insee);
          repriced.set("eventPriceVariationFromCreatedAt", from);
          repriced.set("expired", "false");
          for await (const p of walk(insee, repriced, "re-priced")) {
            const d = take(p);
            if (d) yield d;
          }
          const expired = base(insee);
          expired.set("expired", "true");
          expired.set("fromExpiredAt", from);
          for await (const p of walk(insee, expired, "expired")) {
            if (seen.has(p.uuid)) continue;
            seen.add(p.uuid);
            gone += 1;
            ctx.gone?.(p.uuid);
          }
          // A changes-only pass by definition did not see the rest: nothing is delisted for being absent.
          ctx.incomplete(insee, `changes only, since ${since!.toISOString().slice(0, 16)}`);
        }
        if (stopped) ctx.incomplete(insee, stopped);
        console.log(
          `[${SOURCE_KEY}] ${insee}: ${kept} taken of ${seen.size} read${gone ? `, ${gone} reported gone` : ""} — ` +
            `already ours ${dropped.ours}, no live advert ${dropped.noListing}, other commune ${dropped.wrongCommune}`,
        );
      }
      const after = await client.totals();
      console.log(`[${SOURCE_KEY}] ${after.items - t.items} items this pass; ${after.items} counted this period${stopped ? ` — STOPPED: ${stopped}` : ""}`);
    },

    parse(doc: string, url: string): ParseResult {
      let rec: StreamV1Record;
      try {
        rec = JSON.parse(doc) as StreamV1Record;
      } catch {
        return { status: "failed", error: "document is not a Stream.Estate V1 record" };
      }
      if (!rec?.id || !rec.property) return { status: "failed", error: "record has no id" };
      const p = rec.property as Record<string, unknown>;
      if (p.transactionType !== 0) return { status: "failed", error: "not for sale" };

      const lead = primary(rec, OWN_SOURCES);
      const listing = emptyListing(rec.id, url || lead?.url || "");
      const typeCode = typeof p.propertyType === "number" ? p.propertyType : null;
      const isPlot = typeCode === 5;
      listing.propertyType = typeCode !== null ? (PROPERTY_TYPES[typeCode] ?? null) : null;
      listing.title = str(p.title);
      listing.description = str(p.description);
      listing.priceEur = num(p.price);
      const surface = num(p.surface);
      const land = num(p.landSurface);
      listing.areaM2 = isPlot ? null : surface;
      listing.landM2 = land ?? (isPlot ? surface : null);
      listing.rooms = num(p.room);
      listing.bedrooms = num(p.bedroom);

      /**
       * The commune by their INSEE code, under the client's label — their
       * name for La Môle is "Môle", which resolves to nothing. 83107 under
       * the Les Issambres postcode is Les Issambres.
       */
      const city = (p.city ?? {}) as Record<string, unknown>;
      const insee = str(city.insee);
      const zip = str(city.zipcode);
      const entry = GULF_OF_SAINT_TROPEZ.find((c) => c.insee === insee && (c.localityOf ? zip === "83380" : true)) ?? GULF_OF_SAINT_TROPEZ.find((c) => c.insee === insee);
      listing.communeRaw = entry?.label ?? str(city.name);
      listing.postalCode = zip;

      // The agency: the name most of the live adverts agree on, and the reference most carry.
      const names = new Map<string, number>();
      const refs = new Map<string, number>();
      for (const l of rec.listings) {
        if (l.agency) names.set(l.agency, (names.get(l.agency) ?? 0) + 1);
        if (l.reference) refs.set(l.reference, (refs.get(l.reference) ?? 0) + 1);
      }
      listing.agencyName = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      listing.agencyRef = [...refs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      const pictures = Array.isArray(p.pictures) ? p.pictures.filter((x): x is string => typeof x === "string" && /^https:\/\//.test(x)) : [];
      listing.imageUrls = [...new Set(pictures)];
      listing.imageUrl = listing.imageUrls[0] ?? null;

      // Their dates are theirs: first detection, not publication. Kept in raw, never as publishedAt.
      listing.raw = {
        source: SOURCE_KEY,
        sources: [...new Set(rec.listings.map((l) => l.source))],
        listings: rec.listings.map((l) => ({ source: l.source, url: l.url, publishedAt: null, firstSeenByThem: l.firstSeenByThem })),
        priceEvents: rec.priceEvents,
        firstSeenByThem: str(p.createdAt),
        propertyTypeCode: typeCode,
        cityInsee: insee,
        location: p.location ?? null,
      };

      const missing: string[] = [];
      if (listing.priceEur === null) missing.push("priceEur");
      if (listing.areaM2 === null && !(isPlot && listing.landM2 !== null)) missing.push("areaM2");
      if (!listing.agencyName) missing.push("agencyName");
      return missing.length === 0 ? { status: "ok", listing } : { status: "partial", listing, missing };
    },
  };
}

/**
 * The adapter the registry holds: the ledger in the database, the key from
 * the environment, the cap from the source's config. Built lazily so that a
 * process that never runs this source never touches either.
 */
export const streamEstateV1Adapter: PortalAdapter = makeStreamEstateV1Adapter({
  client: async (config) => {
    const keyEnv = (config.apiKeyEnv as string) ?? "STREAM_ESTATE_API_KEY";
    const key = process.env[keyEnv]?.trim();
    if (!key) throw new Error(`${keyEnv} is not set — the client's V1 key, in .env.local and in the repository's secrets`);
    const plan = Number(config.monthlyItems ?? V1_PLAN_ITEMS);
    const reserve = Number(config.reserve ?? V1_DEFAULT_RESERVE);
    // One ledger for every process that can spend — the table — so the Mac and the runner share the cap.
    // Loaded here, not at the top: `streamV1Db` opens the database, and the tests never need it.
    const { dbLedgerStore } = await import("../streamV1Db");
    return createV1Client({
      store: dbLedgerStore(SOURCE_KEY),
      apiKey: () => key,
      cap: plan - reserve,
      anchorDay: Number(config.periodAnchorDay ?? V1_DEFAULT_ANCHOR_DAY),
    });
  },
  lastPassAt: async () => (await import("../streamV1Db")).lastCompletedPassAt(SOURCE_KEY),
  hasStock: async (insee) => (await import("../streamV1Db")).hasStock(SOURCE_KEY, insee),
});
