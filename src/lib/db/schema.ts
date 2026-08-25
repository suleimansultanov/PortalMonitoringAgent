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
