import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Portal Monitoring Agent — schema.
 *
 * THE SHAPE, IN ONE PARAGRAPH
 * Market data is shared; client data is scoped. A villa in Ramatuelle is the
 * same villa no matter who is watching it, so `portal_listings`, `properties`
 * and `portal_agencies` carry no client column. Only what a client subscribes
 * to, who their buyers are, and what we send them is per-client. Two clients
 * watching the same coast means one crawl, not two — which matters because the
 * portals granted permission on the understanding that we would be reasonable.
 *
 * THE OTHER LOAD-BEARING DECISION
 * `portal_listing_events` is append-only and every metric is derived from it.
 * Current state answers "what is on the market"; only the event log answers
 * "how long did it take to sell" or "when did they cut the price", and those
 * are the questions the product exists for.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tenancy
// ─────────────────────────────────────────────────────────────────────────────

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /**
     * INSEE codes of the communes this client watches. INSEE rather than names
     * because portals spell communes inconsistently — "Saint-Tropez",
     * "St-Tropez", "SAINT TROPEZ" — and a listing in Ramatuelle is routinely
     * labelled Saint-Tropez by the agency writing it.
     */
    communeInsee: text("commune_insee").array().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ slugUnique: uniqueIndex("clients_slug_unique").on(t.slug) }),
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("member"), // 'admin' | 'member'
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ emailUnique: uniqueIndex("users_email_unique").on(t.email) }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────────────────

export const portalSources = pgTable(
  "portal_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable key used by the adapter registry, e.g. "luxuryestate", "aviv". */
    key: text("key").notNull(),
    name: text("name").notNull(),
    /**
     * Hosts this source covers. Deliberately an array: one source is often
     * several brands. SeLoger's search results carry Belles Demeures listings
     * inline, so a single crawl covers both — they are one source, two hosts.
     */
    hosts: text("hosts").array().notNull().default([]),
    /** 'sitemap' | 'index' — how we enumerate what is currently live. */
    discoveryMode: text("discovery_mode").notNull(),
    baseUrl: text("base_url").notNull(),
    /** Honour the portal's own robots.txt. Several ask for 1s; Superimmo for 10s. */
    crawlDelayMs: integer("crawl_delay_ms").notNull().default(1000),
    enabled: boolean("enabled").notNull().default(false),
    /**
     * Why we are allowed to collect from this source, in plain words: "open
     * robots.txt" or "written permission from AVIV, 2026-08-25, contact X".
     * Kept in the database rather than a wiki because the day someone asks,
     * the answer needs to be next to the thing doing the collecting.
     */
    permissionNote: text("permission_note"),
    /** Adapter-specific settings: URL templates, commune slug maps, ceilings. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ keyUnique: uniqueIndex("portal_sources_key_unique").on(t.key) }),
);

export const clientSources = pgTable(
  "client_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => portalSources.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUnique: uniqueIndex("client_sources_pair_unique").on(t.clientId, t.sourceId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Collection
// ─────────────────────────────────────────────────────────────────────────────

export const portalRuns = pgTable(
  "portal_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => portalSources.id, { onDelete: "cascade" }),
    /** 'scheduled' | 'manual' | 'backfill' */
    mode: text("mode").notNull().default("scheduled"),
    /** 'running' | 'done' | 'error' | 'aborted' */
    status: text("status").notNull().default("running"),
    communeInsee: text("commune_insee").array().notNull().default([]),
    seenCount: integer("seen_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    goneCount: integer("gone_count").notNull().default(0),
    fetchedCount: integer("fetched_count").notNull().default(0),
    parsedCount: integer("parsed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    /**
     * Set when the sanity guard trips: a source returning far fewer listings
     * than yesterday is being blocked, not emptying. We stop and emit no
     * `delisted` events, because writing four hundred false delistings takes a
     * week to notice and months to clean out of the reports.
     */
    abortedReason: text("aborted_reason"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    sourceStartedIdx: index("portal_runs_source_started_idx").on(t.sourceId, t.startedAt),
  }),
);

export const portalSnapshots = pgTable(
  "portal_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => portalSources.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => portalRuns.id, { onDelete: "set null" }),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    /** The page exactly as served. Parsers change; this is what we re-parse against. */
    s3Key: text("s3_key").notNull(),
    byteSize: integer("byte_size"),
    /**
     * Hash of the fetched body. If today's page is byte-identical to the last
     * one we stored, parsing again cannot produce a different answer — so we
     * skip it. On a market this static that is most pages, most days.
     */
    contentHash: text("content_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lookupIdx: index("portal_snapshots_lookup_idx").on(t.sourceId, t.externalId, t.fetchedAt),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Agencies
// ─────────────────────────────────────────────────────────────────────────────

export const portalAgencies = pgTable(
  "portal_agencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /**
     * Lowercased, accent-stripped, punctuation-free. "BARNES SAINT-TROPEZ",
     * "Barnes Saint Tropez" and "barnes st-tropez" are one agency, and the
     * portals will spell it all three ways in the same week.
     */
    nameNormalized: text("name_normalized").notNull(),
    /**
     * Postal address as published in the portals' own markup. Several of them
     * emit a full `RealEstateAgent` block, and the addresses agree across
     * portals — which makes this the cleanest way to recognise the same agency
     * on two unrelated sites.
     */
    address: text("address"),
    postalCode: text("postal_code"),
    city: text("city"),
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identityIdx: uniqueIndex("portal_agencies_identity_unique").on(t.nameNormalized, t.postalCode),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Properties — the deduplicated entity the product actually shows
// ─────────────────────────────────────────────────────────────────────────────

export const properties = pgTable(
  "properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title"),
    description: text("description"),
    /** Hotlinked from the portal, never copied — the photography is the agency's. */
    imageUrl: text("image_url"),
    /** The rest of the gallery, in the portal's own order. */
    imageUrls: text("image_urls").array().notNull().default([]),
    priceEur: bigint("price_eur", { mode: "number" }),
    areaM2: numeric("area_m2"),
    landM2: numeric("land_m2"),
    rooms: integer("rooms"),
    bedrooms: integer("bedrooms"),
    propertyType: text("property_type"),
    communeInsee: text("commune_insee"),
    agencyId: uuid("agency_id").references(() => portalAgencies.id, { onDelete: "set null" }),
    /** The agency's own mandate reference. Our strongest cross-portal key. */
    agencyRef: text("agency_ref"),
    /** Powers the "× N portals" badge. Denormalised; recomputed on merge. */
    sourceCount: integer("source_count").notNull().default(1),
    /** 'active' | 'delisted' — never 'sold'. See the note on events below. */
    status: text("status").notNull().default("active"),
    firstListedAt: timestamp("first_listed_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    delistedAt: timestamp("delisted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    communeIdx: index("properties_commune_idx").on(t.communeInsee),
    refIdx: index("properties_agency_ref_idx").on(t.agencyId, t.agencyRef),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Listings — one row per (source, external id)
// ─────────────────────────────────────────────────────────────────────────────

export const portalListings = pgTable(
  "portal_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => portalSources.id, { onDelete: "cascade" }),
    /**
     * The portal's own identifier, taken from the URL. Never from a `sku`
     * field: Maisons et Appartements puts the AGENCY id in `sku`, so using it
     * as a key collapses every BARNES listing into one row.
     */
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),

    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    /** 0–1. How sure the matcher was, kept so a merge can be questioned later. */
    matchConfidence: numeric("match_confidence"),
    /** Which signals fired: exact agency ref, description similarity, price, area. */
    matchSignals: jsonb("match_signals").$type<Record<string, unknown>>(),

    /** 'active' | 'delisted' */
    status: text("status").notNull().default("active"),

    title: text("title"),
    description: text("description"),
    imageUrl: text("image_url"),
    imageUrls: text("image_urls").array().notNull().default([]),

    /**
     * Always euros, always taken from the portal's structured markup — never
     * from the rendered page. JamesEdition shows the same villa as $10,381,272
     * on screen while its markup says 8,900,000 EUR; parsing the screen means
     * recording a price change every time the exchange rate moves.
     */
    priceEur: bigint("price_eur", { mode: "number" }),
    pricePerM2: integer("price_per_m2"),

    areaM2: numeric("area_m2"),
    landM2: numeric("land_m2"),
    rooms: integer("rooms"),
    bedrooms: integer("bedrooms"),
    bathrooms: integer("bathrooms"),
    propertyType: text("property_type"),

    communeInsee: text("commune_insee"),
    communeRaw: text("commune_raw"),
    postalCode: text("postal_code"),
    /**
     * Stored, never used for matching. Only Propriétés Le Figaro publishes
     * coordinates and they are rounded to two decimals with the postcode
     * embedded in the geo object — a postcode centroid, roughly a kilometre,
     * identical for every property in the commune.
     */
    lat: numeric("lat"),
    lon: numeric("lon"),

    agencyId: uuid("agency_id").references(() => portalAgencies.id, { onDelete: "set null" }),
    agencyRef: text("agency_ref"),

    /** As published: 'InStock' etc. Worth watching for a transition to sold. */
    availability: text("availability"),
    /** Only a few portals publish these; where they do, days-on-market works from day one. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    delistedAt: timestamp("delisted_at", { withTimezone: true }),

    /** 'ok' | 'partial' | 'failed' — a failed parse keeps the row and the raw page. */
    parseStatus: text("parse_status").notNull().default("ok"),
    parseError: text("parse_error"),
    /** Extracted structured markup, kept so fields can be re-derived without refetching. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceExternalUnique: uniqueIndex("portal_listings_source_external_unique").on(
      t.sourceId,
      t.externalId,
    ),
    propertyIdx: index("portal_listings_property_idx").on(t.propertyId),
    communeStatusIdx: index("portal_listings_commune_status_idx").on(t.communeInsee, t.status),
    /** Blocking key for the matcher: same agency, same mandate reference. */
    agencyRefIdx: index("portal_listings_agency_ref_idx").on(t.agencyId, t.agencyRef),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Events — append only, and the source of every metric
// ─────────────────────────────────────────────────────────────────────────────

export const portalListingEvents = pgTable(
  "portal_listing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => portalListings.id, { onDelete: "cascade" }),
    /** Denormalised so property-level history is one index scan. */
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => portalSources.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => portalRuns.id, { onDelete: "set null" }),

    /**
     * 'listed' | 'price_changed' | 'delisted' | 'relisted' | 'availability_changed' | 'updated'
     *
     * There is deliberately no 'sold'. A portal shows a listing disappearing,
     * and that happens when it sells, when the owner withdraws it, when the
     * agency's subscription lapses, and when it moves to a competitor. We
     * cannot tell which, so we record what we saw and let anything that claims
     * otherwise be labelled an estimate in the UI.
     */
    type: text("type").notNull(),
    priceFrom: bigint("price_from", { mode: "number" }),
    priceTo: bigint("price_to", { mode: "number" }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    listingIdx: index("portal_listing_events_listing_idx").on(t.listingId, t.occurredAt),
    propertyIdx: index("portal_listing_events_property_idx").on(t.propertyId, t.occurredAt),
    typeIdx: index("portal_listing_events_type_idx").on(t.type, t.occurredAt),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Buyers and matches — the client side of the product
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a buyer is looking for, in OUR shape.
 *
 * Deliberately defined before we know how Med-Estates stores this in GoHighLevel,
 * because the CRM's shape decides how these columns get FILLED, not what they
 * should be. If their custom fields line up, filling is a mapping; if the
 * criteria are prose in a notes field, filling needs an extraction step. Either
 * way the matcher, the API and the screens are written against this table and do
 * not change.
 *
 * `criteriaSource` records which of those happened for each row, because a
 * budget somebody typed into a field and a budget a model guessed from
 * "around 3M, flexible if they love it" deserve different amounts of trust, and
 * the second kind needs to be reviewable rather than silently authoritative.
 */
export const buyers = pgTable(
  "buyers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /**
     * TEST DATA FLAG.
     *
     * True for the invented buyers seeded so the matcher and the Matches screen
     * could be built before the real ones arrive from GHL. Every query that
     * feeds a number a human might act on must either exclude these or label
     * them — an invented buyer that reaches a real agent as a real lead is worse
     * than an empty screen.
     *
     * `npm run seed:buyers -- --clear` removes exactly these rows and nothing
     * else, which is why it is a column and not a naming convention.
     */
    isTestData: boolean("is_test_data").notNull().default(false),

    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    /** The buyer's id in the client's CRM, so a record can be traced back. */
    crmContactId: text("crm_contact_id"),
    /** Which agent owns the relationship. Free text until GHL tells us better. */
    agent: text("agent"),

    /** Euros. Either end may be null — plenty of buyers state only a ceiling. */
    budgetMinEur: bigint("budget_min_eur", { mode: "number" }),
    budgetMaxEur: bigint("budget_max_eur", { mode: "number" }),

    /** INSEE codes, same vocabulary as `clients.communeInsee`. Empty = anywhere. */
    communeInsee: text("commune_insee").array().notNull().default([]),

    bedroomsMin: integer("bedrooms_min"),
    roomsMin: integer("rooms_min"),
    areaMinM2: integer("area_min_m2"),
    landMinM2: integer("land_min_m2"),

    /** 'Maison' | 'Appartement' | 'Terrain' … as the portals spell them. */
    propertyTypes: text("property_types").array().notNull().default([]),

    /**
     * Two lists, not one, and the distinction is the whole point of the screen.
     *
     * A missing must-have disqualifies. A missing nice-to-have lowers the score
     * and gets said out loud — "no pool, but everything else fits" is a call an
     * agent might still make, and collapsing both into one list takes that
     * judgement away from them.
     */
    mustHave: text("must_have").array().notNull().default([]),
    niceToHave: text("nice_to_have").array().notNull().default([]),

    /** The original CRM text, kept verbatim so an extraction can be checked. */
    notesRaw: text("notes_raw"),
    /** 'fields' | 'extracted' | 'manual' — how much to trust the columns above. */
    criteriaSource: text("criteria_source").notNull().default("manual"),

    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index("buyers_client_idx").on(t.clientId, t.active),
    testIdx: index("buyers_test_idx").on(t.isTestData),
    crmUnique: uniqueIndex("buyers_crm_unique").on(t.clientId, t.crmContactId),
  }),
);

/**
 * One row per (buyer, property) the matcher proposed.
 *
 * Keyed on the property rather than the listing: the same villa on four portals
 * is one thing to show an agent, and proposing it four times is how a useful
 * feature becomes noise people switch off.
 */
export const buyerMatches = pgTable(
  "buyer_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => buyers.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),

    /** 0–100. Never shown on its own — see `reasons`. */
    score: integer("score").notNull(),

    /**
     * Why it matched, and why it did not, in a form the screen can render as
     * sentences: `[{ field: 'budget', ok: true, detail: '4.99M within 4–6M' }]`.
     *
     * An agent will not act on a number they cannot check. A score with no
     * explanation gets ignored the first time it is wrong, and after that the
     * feature is dead however good the arithmetic is.
     */
    reasons: jsonb("reasons").$type<Record<string, unknown>[]>().notNull().default([]),

    /** 'new' | 'seen' | 'sent' | 'dismissed' */
    status: text("status").notNull().default("new"),
    /** Kept when dismissed: the best signal we will ever get about the scoring. */
    dismissedReason: text("dismissed_reason"),

    /** The generated outreach draft, if one was produced. */
    draftMessage: text("draft_message"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUnique: uniqueIndex("buyer_matches_pair_unique").on(t.buyerId, t.propertyId),
    buyerIdx: index("buyer_matches_buyer_idx").on(t.buyerId, t.status, t.score),
    statusIdx: index("buyer_matches_status_idx").on(t.status, t.createdAt),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Market reports — frozen snapshots, not live queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row per period per client: the market as it stood, kept.
 *
 * WHY STORE IT RATHER THAN COMPUTE IT
 *
 * The Reports screen was recomputing everything from current data, which meant
 * it could only ever answer "what does the market look like today". Asking "what
 * did June look like" had no answer at all — the rows that were active in June
 * have since changed price, been delisted, or come back.
 *
 * Some of that IS reconstructable from `portal_listing_events`, which is
 * append-only for exactly this reason. But not all of it: a property first seen
 * in July tells us nothing about June, and our own coverage changed underneath —
 * a commune that shows fewer listings in June than July is more likely to mean
 * "we had not crawled it yet" than "the market was thinner".
 *
 * So a report is FROZEN at generation, with the coverage it was generated under
 * recorded alongside. A number that was right when written stays right, and a
 * comparison between two months carries the caveat that makes it honest.
 */
export const marketReports = pgTable(
  "market_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /** 'monthly' | 'weekly' | 'adhoc' */
    kind: text("kind").notNull().default("monthly"),
    /** First day of the period. The natural key together with client and kind. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    /** Human label: "August 2026". Stored so the list needs no date formatting. */
    label: text("label").notNull(),

    /** Headline figures, so a list of reports renders without opening each. */
    activeCount: integer("active_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    delistedCount: integer("delisted_count").notNull().default(0),
    priceCutCount: integer("price_cut_count").notNull().default(0),
    medianPriceEur: bigint("median_price_eur", { mode: "number" }),
    medianPricePerM2: integer("median_price_per_m2"),
    medianDaysOnMarket: integer("median_days_on_market"),

    /** Per-commune and per-agency tables, frozen as generated. */
    communes: jsonb("communes").$type<Record<string, unknown>[]>().notNull().default([]),
    agencies: jsonb("agencies").$type<Record<string, unknown>[]>().notNull().default([]),
    /** Notable movements: the price cuts and delistings worth reading. */
    movements: jsonb("movements").$type<Record<string, unknown>[]>().notNull().default([]),

    /**
     * What the numbers could NOT see, recorded at generation time.
     *
     * How many communes had been crawled, which sources were enabled. Without
     * this, comparing two months silently compares two different coverages, and
     * "the market grew 40%" turns out to mean "we switched a portal on".
     */
    coverage: jsonb("coverage").$type<Record<string, unknown>>().notNull().default({}),
    warnings: text("warnings").array().notNull().default([]),

    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    periodUnique: uniqueIndex("market_reports_period_unique").on(
      t.clientId,
      t.kind,
      t.periodStart,
    ),
    clientIdx: index("market_reports_client_idx").on(t.clientId, t.periodStart),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Settings — encrypted key/value, ported from Vault
// ─────────────────────────────────────────────────────────────────────────────

export const settings = pgTable(
  "settings",
  {
    key: text("key").primaryKey(),
    value: text("value"),
    encrypted: boolean("encrypted").notNull().default(false),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * API keys for client instances.
 *
 * See `drizzle/0006_api_keys.sql` for why the key is hashed rather than
 * encrypted, and why a fast hash is the correct choice for a random token.
 *
 * The row carries no scope of its own. What a key may read comes from the
 * client it belongs to — `clients.commune_insee` and `client_sources` — so
 * there is exactly one place where a client's reach is defined, and issuing a
 * second key cannot accidentally widen it.
 */
export const clientApiKeys = pgTable(
  "client_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** Human label. Rotation means two live keys, and they must be tellable apart. */
    name: text("name").notNull(),
    /** First characters, in the clear, so a key can be named in a log or a list. */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Revoked, never deleted — a key seen in a log later is still identifiable. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUnique: uniqueIndex("client_api_keys_hash_unique").on(t.keyHash),
    clientIdx: index("client_api_keys_client_idx").on(t.clientId),
  }),
);
