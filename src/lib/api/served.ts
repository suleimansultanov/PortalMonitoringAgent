import { sql, type SQL } from "drizzle-orm";
import { portalListings, portalSources, properties } from "@/lib/db/schema";

/**
 * WHAT IS SERVED: listings from sources still being collected, and only
 * properties that have at least one.
 *
 * A collector switched off (Propriétés Le Figaro since 16 September,
 * JamesEdition, SMC, Superimmo on 2026-10-14) leaves its rows in the
 * database, active, and nobody checks them again. Serving them tells a
 * client a villa is on Figaro at a price nobody has looked at for a month.
 * The same portals now reach us through Stream.Estate, whose rows are
 * served under the portal's name — so "Figaro" in the API means Figaro as
 * read last night, never Figaro as it was in September. The rows stay: a
 * source switched back on serves them again, and nothing was deleted.
 *
 * `sourceIds` narrows it to what one client subscribes to (`client_sources`).
 * Null means every enabled source — our own screens before they were scoped.
 * An EMPTY list serves nothing: a client subscribed to no source has bought
 * no market, and falling back to "everything" would be the quiet way to give
 * it one.
 *
 * In its own file because two readers need the same answer — /api/v1 and our
 * screens — and the day they disagree, the client's app and our dashboard
 * show two different markets with nothing to say which is right.
 */
export function servedProperty(sourceIds: string[] | null, notAgencies: string[] = []): SQL {
  const scoped =
    sourceIds === null
      ? sql``
      : sourceIds.length === 0
        ? sql` and false`
        : sql` and l.source_id in (${sql.join(sourceIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
  // `notAgencies`: the client's own (clients.own_agency_names, resolved to ids). A property
  // only the client itself is selling is not served back to it.
  const notOwn =
    notAgencies.length === 0
      ? sql``
      : sql` and (l.agency_id is null or l.agency_id not in (${sql.join(notAgencies.map((id) => sql`${id}::uuid`), sql`, `)}))`;
  return sql`exists (
  select 1 from ${portalListings} l
  join ${portalSources} s on s.id = l.source_id
  where l.property_id = ${properties.id} and l.status = 'active' and s.enabled${scoped}${notOwn}
)`;
}

/** Every enabled source, unscoped. */
export const SERVED_PROPERTY = servedProperty(null);
