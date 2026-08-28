import "server-only";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyers, clients } from "@/lib/db/schema";

/**
 * INVENTED BUYERS. NOT REAL PEOPLE.
 *
 *   npm run seed:buyers            add or update them
 *   npm run seed:buyers -- --clear remove them and nothing else
 *
 * These exist so the matcher, the API and the Matches screen could be built
 * before Med-Estates answers how buyer criteria are stored in GoHighLevel. The
 * CRM's shape decides how the columns get filled; it does not decide what the
 * columns are. So the real work proceeds and the import is plugged in later.
 *
 * THREE THINGS KEEP THESE FROM BECOMING A PROBLEM
 *
 * 1. `is_test_data = true` on every row. Client-facing queries filter on it, and
 *    `--clear` deletes on it, so removal is exact rather than a guess about
 *    which rows looked fake.
 * 2. The prefix below is in the NAME, so anyone looking at a screen, an export
 *    or a database row sees it without knowing the schema.
 * 3. No real contact details. The emails are on `example.invalid`, a domain
 *    reserved by the RFCs precisely so it can never be delivered to. An invented
 *    buyer that reaches a real agent as a real lead is worse than an empty
 *    screen, and a plausible-looking address is how that happens.
 *
 * The briefs themselves are modelled on what this market actually looks like —
 * Dutch and Belgian families, a Swiss couple downsizing, a developer hunting
 * plots — so that the scoring is exercised against realistic shapes rather than
 * against twelve variations of the same buyer.
 */

export const TEST_PREFIX = "TESTDATA —";

const TEST_BUYERS = [
  {
    name: "Familie van der Berg",
    agent: "Mark Daggers",
    budgetMinEur: 4_000_000,
    budgetMaxEur: 6_500_000,
    communeInsee: ["83101", "83119", "83065"],
    bedroomsMin: 5,
    areaMinM2: 250,
    landMinM2: 2_000,
    propertyTypes: ["Maison"],
    mustHave: ["pool"],
    niceToHave: ["sea_view", "guest_house"],
    notesRaw:
      "Family of five, second home. Wants Ramatuelle or Gassin, walking distance " +
      "to a beach is a plus. Pool non-negotiable. Budget flexible to 7M for the right one.",
  },
  {
    name: "M. et Mme Lefèvre",
    agent: "Mark Daggers",
    budgetMinEur: 1_200_000,
    budgetMaxEur: 2_000_000,
    communeInsee: ["83115", "83042"],
    bedroomsMin: 3,
    areaMinM2: 120,
    propertyTypes: ["Maison", "Appartement"],
    mustHave: [],
    niceToHave: ["garden", "garage", "sea_view"],
    notesRaw: "Retiring to the coast. Sainte-Maxime preferred, Cogolin acceptable. No stairs if possible.",
  },
  {
    name: "Hendriks Holding BV",
    agent: "Med-Estates desk",
    budgetMinEur: 800_000,
    budgetMaxEur: 3_000_000,
    communeInsee: ["83101", "83119", "83065", "83068"],
    bedroomsMin: null,
    areaMinM2: null,
    landMinM2: 1_500,
    propertyTypes: ["Terrain"],
    mustHave: [],
    niceToHave: ["sea_view"],
    notesRaw: "Developer. Building plots only, minimum 1500 m². Will look at anything with a permit.",
  },
  {
    name: "Sophie & Thomas Weber",
    agent: "Mark Daggers",
    budgetMinEur: 2_500_000,
    budgetMaxEur: 4_000_000,
    communeInsee: ["83119"],
    bedroomsMin: 4,
    areaMinM2: 180,
    propertyTypes: ["Maison"],
    mustHave: ["sea_view"],
    niceToHave: ["pool", "walking_distance_beach"],
    notesRaw: "Saint-Tropez only. Sea view is the whole point — will not consider without.",
  },
  {
    name: "Claudia Bianchi",
    agent: "Med-Estates desk",
    budgetMinEur: null,
    budgetMaxEur: 1_500_000,
    communeInsee: ["83115", "83107"],
    bedroomsMin: 2,
    areaMinM2: 80,
    propertyTypes: ["Appartement"],
    mustHave: [],
    niceToHave: ["sea_view", "garage"],
    notesRaw: "Apartment, Sainte-Maxime or Les Issambres. Ceiling 1.5M, no flexibility.",
  },
  {
    name: "The Okonkwo Family",
    agent: "Mark Daggers",
    budgetMinEur: 6_000_000,
    budgetMaxEur: 12_000_000,
    communeInsee: ["83101", "83119"],
    bedroomsMin: 6,
    areaMinM2: 400,
    landMinM2: 5_000,
    propertyTypes: ["Maison"],
    mustHave: ["pool", "sea_view"],
    niceToHave: ["guest_house", "air_conditioning"],
    notesRaw: "Trophy property. Pampelonne side preferred. Privacy matters more than proximity.",
  },
  {
    name: "Jan & Marieke Visser",
    agent: "Med-Estates desk",
    budgetMinEur: 900_000,
    budgetMaxEur: 1_600_000,
    communeInsee: ["83063", "83094"],
    bedroomsMin: 3,
    areaMinM2: 140,
    landMinM2: 1_000,
    propertyTypes: ["Maison"],
    mustHave: [],
    niceToHave: ["pool", "garden"],
    notesRaw: "Inland is fine — La Garde-Freinet, Plan-de-la-Tour. Quiet, some land, village within walking distance.",
  },
  {
    name: "Alexandre Rousseau",
    agent: "Mark Daggers",
    budgetMinEur: 3_000_000,
    budgetMaxEur: 5_000_000,
    communeInsee: ["83068", "83042"],
    bedroomsMin: 4,
    areaMinM2: 200,
    propertyTypes: ["Maison"],
    mustHave: ["pool"],
    niceToHave: ["renovated", "garage"],
    notesRaw: "Grimaud or Cogolin. Does not want a renovation project — turnkey only.",
  },
  {
    name: "Nordic Ventures AS",
    agent: "Med-Estates desk",
    budgetMinEur: 2_000_000,
    budgetMaxEur: 8_000_000,
    communeInsee: [],
    bedroomsMin: null,
    areaMinM2: 150,
    propertyTypes: [],
    mustHave: [],
    niceToHave: ["sea_view", "pool"],
    /**
     * Deliberately vague — no communes, no type, no bedrooms.
     *
     * A buyer like this exists in every CRM, and they are the case that breaks
     * naive scoring: with nothing stated, everything either matches perfectly or
     * nothing does. Worth having one in the fixture set so the normalisation is
     * exercised rather than assumed.
     */
    notesRaw: "Opportunistic. Anywhere on the gulf, will look at anything that makes sense as an investment.",
  },
  {
    name: "Isabelle Moreau",
    agent: "Mark Daggers",
    budgetMinEur: 4_500_000,
    budgetMaxEur: 5_500_000,
    communeInsee: ["83048", "83036"],
    bedroomsMin: 5,
    areaMinM2: 300,
    landMinM2: 3_000,
    propertyTypes: ["Maison"],
    mustHave: ["pool", "walking_distance_beach"],
    niceToHave: ["sea_view", "guest_house"],
    notesRaw: "La Croix-Valmer or Cavalaire. Must be able to walk to the beach with children.",
  },
];

function slugEmail(name: string): string {
  const slug = name
    .normalize("NFD")
    // Combining diacritics as escapes, not literals: literal marks are
    // invisible in a diff and get mangled by editors. Same convention as
    // normaliseCommuneName in communes.ts.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
  // .invalid is reserved by RFC 2606 and can never resolve. A plausible-looking
  // address is exactly how invented data turns into a real email one day.
  return `${slug}@example.invalid`;
}

export async function seedTestBuyers(clear = false): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.slug, "med-estates")).limit(1);
  if (!client) {
    throw new Error("Client med-estates not found — run `npm run db:seed` first.");
  }

  if (clear) {
    const removed = await db
      .delete(buyers)
      .where(and(eq(buyers.clientId, client.id), eq(buyers.isTestData, true)))
      .returning({ id: buyers.id });
    console.log(`\n[buyers] removed ${removed.length} test buyers. Real ones untouched.\n`);
    return;
  }

  for (const b of TEST_BUYERS) {
    const name = `${TEST_PREFIX} ${b.name}`;
    /**
     * The CRM id doubles as the natural key here, so re-running updates in
     * place instead of stacking up copies. `test:` prefixed so it can never
     * collide with a real GoHighLevel id.
     */
    const crmContactId = `test:${slugEmail(b.name)}`;

    await db
      .insert(buyers)
      .values({
        clientId: client.id,
        isTestData: true,
        name,
        email: slugEmail(b.name),
        phone: null,
        crmContactId,
        agent: b.agent,
        budgetMinEur: b.budgetMinEur ?? null,
        budgetMaxEur: b.budgetMaxEur ?? null,
        communeInsee: b.communeInsee,
        bedroomsMin: b.bedroomsMin ?? null,
        roomsMin: null,
        areaMinM2: b.areaMinM2 ?? null,
        landMinM2: b.landMinM2 ?? null,
        propertyTypes: b.propertyTypes,
        mustHave: b.mustHave,
        niceToHave: b.niceToHave,
        notesRaw: b.notesRaw,
        /**
         * 'manual' — these were typed by hand, not read from a CRM and not
         * extracted from prose. When the real import lands it writes 'fields'
         * or 'extracted', and the difference is how much the screen should
         * invite someone to check the numbers.
         */
        criteriaSource: "manual",
        active: true,
      })
      .onConflictDoUpdate({
        target: [buyers.clientId, buyers.crmContactId],
        set: {
          name,
          budgetMinEur: b.budgetMinEur ?? null,
          budgetMaxEur: b.budgetMaxEur ?? null,
          communeInsee: b.communeInsee,
          bedroomsMin: b.bedroomsMin ?? null,
          areaMinM2: b.areaMinM2 ?? null,
          landMinM2: b.landMinM2 ?? null,
          propertyTypes: b.propertyTypes,
          mustHave: b.mustHave,
          niceToHave: b.niceToHave,
          notesRaw: b.notesRaw,
          updatedAt: new Date(),
        },
      });
  }

  console.log(`\n[buyers] ${TEST_BUYERS.length} TEST buyers seeded for med-estates.`);
  console.log(`         Every row: is_test_data = true, name prefixed "${TEST_PREFIX}",`);
  console.log(`         address on example.invalid so nothing can ever be sent.`);
  console.log(`\n         Remove with:  npm run seed:buyers -- --clear\n`);
}

if (process.argv[1]?.endsWith("seedBuyers.ts")) {
  seedTestBuyers(process.argv.includes("--clear"))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[buyers] failed:", (err as Error).message);
      process.exit(1);
    });
}
