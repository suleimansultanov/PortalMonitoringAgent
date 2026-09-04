/**
 * The description of /api/v1, written by hand.
 *
 * Hand-written rather than generated, because the things a client instance most
 * needs to know are not in the types. That `delisted` does not mean sold, that
 * `firstListedAt` is our sighting rather than a publication date, that the
 * cursor is a pair — none of those are shapes, they are meanings, and a
 * generator would produce a schema that is complete and still lets somebody
 * build the wrong thing.
 *
 * Kept next to the routes so that changing one without the other is visible in
 * the same diff.
 */

const CAVEAT =
  "firstListedAt is our first sighting, not the portal's publication date. " +
  "For properties listed before we began collecting it is a lower bound.";

const property = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    title: { type: "string", nullable: true },
    description: { type: "string", nullable: true },
    priceEur: { type: "integer", nullable: true, description: "Asking price in euros, as the portal states it." },
    areaM2: { type: "number", nullable: true },
    landM2: { type: "number", nullable: true },
    rooms: { type: "integer", nullable: true },
    bedrooms: { type: "integer", nullable: true },
    propertyType: { type: "string", nullable: true },
    communeInsee: { type: "string", nullable: true, description: "INSEE code. Communes are keyed on this, never on name — portals spell them inconsistently." },
    imageUrl: { type: "string", nullable: true, description: "Hot-linked from the portal. We do not copy the agency's photography." },
    imageUrls: { type: "array", items: { type: "string" } },
    agencyRef: { type: "string", nullable: true, description: "The agency's own mandate reference, where the portal publishes it." },
    sourceCount: { type: "integer", description: "How many portals carry this property. Higher means the deduplication had more to work with." },
    status: { type: "string", enum: ["active", "delisted"] },
    firstListedAt: { type: "string", format: "date-time", nullable: true, description: CAVEAT },
    lastSeenAt: { type: "string", format: "date-time", nullable: true },
    listings: {
      type: "array",
      description: [
        "One entry per portal currently carrying this property, with what THAT",
        "portal says. The portals disagree — on room counts, on whether an energy",
        "rating exists, on how long the villa has been listed — and the",
        "disagreement is the point: a single averaged view is the one thing a",
        "client could have built without us.",
      ].join(" "),
      items: {
        type: "object",
        properties: {
          source: { type: "string", example: "figaro" },
          sourceName: { type: "string", example: "Propriétés Le Figaro" },
          url: { type: "string" },
          externalId: { type: "string" },
          priceEur: { type: "integer", nullable: true },
          areaM2: { type: "number", nullable: true },
          landM2: { type: "number", nullable: true },
          rooms: { type: "integer", nullable: true },
          bedrooms: { type: "integer", nullable: true },
          bathrooms: { type: "integer", nullable: true },
          agencyRef: { type: "string", nullable: true, description: "The agency's mandate reference." },
          publishedAt: {
            type: "string",
            format: "date-time",
            nullable: true,
            description:
              "When the PORTAL published it. Only a few portals state this; where they do, days-on-market is measured rather than inferred.",
          },
          sourceUpdatedAt: { type: "string", format: "date-time", nullable: true },
          firstSeenAt: { type: "string", format: "date-time", nullable: true },
          lastSeenAt: { type: "string", format: "date-time", nullable: true },
          characteristics: {
            type: "array",
            description:
              "What this portal prints about the property, as it prints it. Label/value pairs rather than a fixed schema, because the portals do not agree on what a characteristic is and normalising would mean choosing which facts survive.",
            items: {
              type: "object",
              properties: { label: { type: "string" }, value: { type: "string" } },
            },
          },
          dpe: { type: "string", nullable: true, example: "A" },
          energyKwhM2Year: { type: "number", nullable: true },
          ges: { type: "string", nullable: true },
          ghgCo2M2Year: { type: "number", nullable: true },
          flags: {
            type: "array",
            items: { type: "string" },
            description: "The portal's own feature tags: pool, terrace, airConditioning.",
          },
        },
      },
    },
    agency: {
      type: "object",
      nullable: true,
      description: "The agency behind the mandate, where the portals name one.",
      properties: {
        name: { type: "string" },
        address: { type: "string", nullable: true },
        postalCode: { type: "string", nullable: true },
        city: { type: "string", nullable: true },
        phone: { type: "string", nullable: true },
      },
    },
  },
} as const;

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Portal Monitoring Agent — collector API",
    version: "1.1.0",
    description: [
      "Market data for client instances: a snapshot to start from, and a stream of",
      "events to stay current.",
      "",
      "**Scope comes from your key, never from the request.** `commune` narrows within",
      "what your key already covers and cannot widen it. Communes outside it are",
      "dropped from the filter rather than rejected — an error would confirm which",
      "communes exist.",
      "",
      "**Pull when the collection moves, not on a clock.** `/status` carries",
      "`lastSuccessfulCollectionAt`; an instance polling on its own schedule will",
      "eventually read while a pass is still running and show a half-collected market",
      "without saying so.",
      "",
      "**`delisted` does not mean sold.** The listing disappeared. That happens when it",
      "sells, when the owner withdraws it, when the agency's subscription lapses and",
      "when it moves to a competitor. We cannot tell which, and neither should you.",
    ].join("\n"),
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "market", description: "Properties and what has happened to them." },
    { name: "health", description: "Whether what you are reading is current." },
  ],
  paths: {
    "/api/v1/status": {
      get: {
        tags: ["health"],
        summary: "Is the market you are about to read current?",
        description:
          "`lastSuccessfulCollectionAt` means the pass finished — not that a row says " +
          "'done'. A pass whose fetching stopped part-way is still recorded as done " +
          "with the reason in `error`, and those are excluded here.",
        responses: {
          200: {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    client: { type: "string", example: "med-estates" },
                    communes: { type: "array", items: { type: "string" } },
                    lastSuccessfulCollectionAt: { type: "string", format: "date-time", nullable: true },
                    properties: { type: "integer", description: "Active properties visible to this key." },
                    sources: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          key: { type: "string" },
                          lastRunAt: { type: "string", format: "date-time", nullable: true },
                          lastOutcome: { type: "string", enum: ["done", "aborted", "error", "running", "never"] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { $ref: "#/components/responses/Unauthorised" },
        },
      },
    },

    "/api/v1/properties": {
      get: {
        tags: ["market"],
        summary: "Snapshot — the current state of everything you may see",
        description:
          "For an instance starting from empty, and for periodic reconciliation. " +
          "Do not poll this daily once you are running: twenty changes are not worth " +
          "re-reading the whole market, and the cost grows with the corpus. Use " +
          "`/api/v1/events` instead.\n\n" +
          "Paged by `id`, not by date. A cursor on a mutable column skips and repeats " +
          "rows while you page, and the nightly pass mutates hundreds of rows — so a " +
          "walk stays complete even if it takes an hour and collection runs during it.",
        parameters: [
          {
            name: "commune",
            in: "query",
            schema: { type: "string" },
            description: "Comma-separated INSEE codes, within your scope. Omit for all of it.",
            example: "83119,83061",
          },
          {
            name: "after",
            in: "query",
            schema: { type: "string", format: "uuid" },
            description: "`nextCursor` from the previous page.",
          },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
        ],
        responses: {
          200: {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    properties: { type: "array", items: property },
                    nextCursor: { type: "string", nullable: true, description: "Null on the last page." },
                    communes: { type: "array", items: { type: "string" }, description: "What was actually queried, after intersecting with your scope." },
                    caveat: { type: "string" },
                  },
                },
              },
            },
          },
          400: { $ref: "#/components/responses/BadQuery" },
          401: { $ref: "#/components/responses/Unauthorised" },
        },
      },
    },

    "/api/v1/events": {
      get: {
        tags: ["market"],
        summary: "Delta — what has happened since a cursor",
        description:
          "What *happened*, not what changed: a price cut and a re-listing are " +
          "different things, and a row's `updated_at` cannot tell them apart. Each " +
          "event carries the full property, so acting on one needs no second call.\n\n" +
          "**The walk:** call with no cursor, act on the page, keep `nextCursor`, call " +
          "again with `since=` until it comes back null.\n\n" +
          "The cursor encodes `(occurred_at, id)` — the pair. A timestamp alone steps " +
          "silently over one of two events written in the same millisecond.\n\n" +
          "A malformed `since` is a 400, not a restart from the beginning: silently " +
          "replaying the whole history would have you announce every property you " +
          "already know as new.",
        parameters: [
          {
            name: "since",
            in: "query",
            schema: { type: "string" },
            description: "`nextCursor` from the previous response. Omit to start from the beginning.",
          },
          {
            name: "type",
            in: "query",
            schema: { type: "string" },
            description: "Comma-separated. One or more of: listed, price_changed, delisted, relisted, availability_changed, updated.",
            example: "listed,price_changed",
          },
          { name: "commune", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
        ],
        responses: {
          200: {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    events: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", format: "uuid" },
                          type: {
                            type: "string",
                            enum: ["listed", "price_changed", "delisted", "relisted", "availability_changed", "updated"],
                            description: "There is deliberately no 'sold'. See the note at the top.",
                          },
                          occurredAt: { type: "string", format: "date-time" },
                          priceFrom: { type: "integer", nullable: true },
                          priceTo: { type: "integer", nullable: true },
                          property: { ...property, nullable: true },
                        },
                      },
                    },
                    nextCursor: { type: "string", nullable: true },
                    caughtUp: { type: "boolean", description: "Null cursor means caught up, not 'no more pages ever'. Call again later." },
                    caveat: { type: "string" },
                  },
                },
              },
            },
          },
          400: { $ref: "#/components/responses/BadQuery" },
          401: { $ref: "#/components/responses/Unauthorised" },
        },
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "`Authorization: Bearer pma_live_…`, or `X-Api-Key`. Issued with " +
          "`npm run key:create`. Shown once — only its hash is stored.",
      },
    },
    responses: {
      Unauthorised: {
        description:
          "Unknown key, revoked, expired, or an inactive client — all answer the same, " +
          "because the differences are only useful to somebody working out which they hit.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { error: { type: "string" }, detail: { type: "string" } },
            },
          },
        },
      },
      BadQuery: {
        description: "A parameter did not parse, or the cursor is malformed.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { error: { type: "string" }, detail: {} },
            },
          },
        },
      },
    },
  },
} as const;
