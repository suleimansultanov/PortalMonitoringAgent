import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { portalAgencies } from "@/lib/db/schema";

/**
 * Agency identity.
 *
 * Half of deduplication rests on this. The mandate reference is only a useful
 * key as `(agency, reference)` — references are short and agency-local, so
 * "2365" from SGI International and "2365" from Tardieu are different
 * properties entirely.
 *
 * Portals make this easier than expected: several publish a full
 * `RealEstateAgent` block with a postal address in a consistent format, and the
 * addresses agree across unrelated sites. What was budgeted as manual merging
 * turns out to be mostly a normalisation problem.
 */

/**
 * Strip everything that varies without meaning: case, accents, punctuation,
 * and the legal-form noise agencies append inconsistently.
 *
 * "BARNES SAINT-TROPEZ", "Barnes Saint Tropez" and "Barnes St-Tropez SARL"
 * are one agency, and the portals will spell it all three ways in a week.
 */
export function normaliseAgencyName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(sarl|sas|sasu|eurl|sci|snc|s\.?a\.?r\.?l|ei|eirl)\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/\bst\b/g, "saint")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type AgencyInput = {
  name: string;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
  phone?: string | null;
};

/**
 * Find or create the agency, then fill in any detail we did not have before.
 *
 * Enrichment matters because portals publish different subsets: one gives a
 * name only, another the same agency with an address and phone. Whichever we
 * meet first should not lock in the poorer version.
 */
export async function resolveAgency(input: AgencyInput): Promise<string | null> {
  const name = input.name?.trim();
  if (!name) return null;

  const nameNormalized = normaliseAgencyName(name);
  if (!nameNormalized) return null;

  const postalCode = input.postalCode?.trim() || null;

  const [existing] = await db
    .select()
    .from(portalAgencies)
    .where(
      and(
        eq(portalAgencies.nameNormalized, nameNormalized),
        postalCode === null
          ? isNull(portalAgencies.postalCode)
          : eq(portalAgencies.postalCode, postalCode),
      ),
    )
    .limit(1);

  if (existing) {
    const patch: Partial<typeof portalAgencies.$inferInsert> = {};
    if (!existing.address && input.address) patch.address = input.address;
    if (!existing.city && input.city) patch.city = input.city;
    if (!existing.phone && input.phone) patch.phone = input.phone;

    if (Object.keys(patch).length > 0) {
      await db
        .update(portalAgencies)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(portalAgencies.id, existing.id));
    }
    return existing.id;
  }

  /**
   * Two concurrent ingests can both miss the read above and both insert. The
   * unique index on (name_normalized, postal_code) is declared NULLS NOT
   * DISTINCT precisely so the second one collides instead of quietly creating
   * a duplicate agency — which would then split one agency's listings in two
   * and break every count built on them.
   */
  const [created] = await db
    .insert(portalAgencies)
    .values({
      name,
      nameNormalized,
      address: input.address ?? null,
      postalCode,
      city: input.city ?? null,
      phone: input.phone ?? null,
    })
    .onConflictDoUpdate({
      target: [portalAgencies.nameNormalized, portalAgencies.postalCode],
      set: { updatedAt: new Date() },
    })
    .returning({ id: portalAgencies.id });

  return created?.id ?? null;
}
