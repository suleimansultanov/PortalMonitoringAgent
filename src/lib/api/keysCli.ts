import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clientApiKeys, clients } from "@/lib/db/schema";
import { generateKey } from "./keys";

/**
 * Issuing and withdrawing client API keys.
 *
 *   npm run key:create -- --client=med-estates --name="production"
 *   npm run key:list
 *   npm run key:revoke -- --prefix=pma_live_ab12cd
 *
 * A command rather than a screen, deliberately. Issuing a key is something we
 * do when a client is onboarded — a handful of times a year — and every screen
 * that exists has to be guarded, tested and kept working forever. The command
 * is the smaller thing that cannot be left unguarded by accident.
 */

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

async function create(): Promise<void> {
  const slug = arg("client");
  const name = arg("name") ?? "unnamed";
  if (!slug) {
    console.error("Usage: npm run key:create -- --client=<slug> --name=<label>");
    process.exit(2);
  }

  const [client] = await db.select().from(clients).where(eq(clients.slug, slug)).limit(1);
  if (!client) {
    const all = await db.select({ slug: clients.slug }).from(clients);
    console.error(
      `No client "${slug}". Existing: ${all.map((c) => c.slug).join(", ") || "(none)"}`,
    );
    process.exit(1);
  }

  const issued = generateKey();
  await db.insert(clientApiKeys).values({
    clientId: client.id,
    name,
    prefix: issued.prefix,
    keyHash: issued.keyHash,
  });

  console.log(`\n  client   ${client.slug} — ${client.name}`);
  console.log(`  label    ${name}`);
  console.log(`  communes ${client.communeInsee.length}`);
  console.log(`\n  ${issued.key}\n`);
  /**
   * Said plainly, because the natural assumption is that it can be looked up
   * later. Only the hash is stored — if this line is lost, the key is not
   * recoverable and the answer is to issue another and revoke this one.
   */
  console.log("  Shown once. Only its hash is stored, so it cannot be recovered.");
  console.log("  Put it in the client instance's environment now.\n");
}

async function list(): Promise<void> {
  const rows = await db
    .select({
      prefix: clientApiKeys.prefix,
      name: clientApiKeys.name,
      slug: clients.slug,
      lastUsedAt: clientApiKeys.lastUsedAt,
      revokedAt: clientApiKeys.revokedAt,
      createdAt: clientApiKeys.createdAt,
    })
    .from(clientApiKeys)
    .innerJoin(clients, eq(clients.id, clientApiKeys.clientId))
    .orderBy(desc(clientApiKeys.createdAt));

  if (rows.length === 0) {
    console.log("\n  No keys issued.\n");
    return;
  }

  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");
  console.log("");
  for (const r of rows) {
    console.log(
      `  ${r.prefix.padEnd(16)} ${r.slug.padEnd(14)} ${r.name.padEnd(20)} ` +
        `created ${day(r.createdAt)}  last used ${day(r.lastUsedAt)}` +
        (r.revokedAt ? `  REVOKED ${day(r.revokedAt)}` : ""),
    );
  }
  console.log("");
  /**
   * The reason `last_used_at` is worth a column at all: a key nobody has used
   * for months is either a client who stopped, or a key issued twice and only
   * one of them wired up. Both are worth knowing before revoking anything.
   */
  console.log("  'last used' is approximate — written at most once an hour.\n");
}

async function revoke(): Promise<void> {
  const prefix = arg("prefix");
  if (!prefix) {
    console.error("Usage: npm run key:revoke -- --prefix=pma_live_ab12cd");
    process.exit(2);
  }

  const updated = await db
    .update(clientApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(clientApiKeys.prefix, prefix), isNull(clientApiKeys.revokedAt)))
    .returning({ prefix: clientApiKeys.prefix, name: clientApiKeys.name });

  if (updated.length === 0) {
    console.error(`No live key with prefix "${prefix}". Run npm run key:list.`);
    process.exit(1);
  }
  console.log(`\n  revoked ${updated[0].prefix} (${updated[0].name})`);
  console.log("  It stops working on the next request. The row stays, so the key");
  console.log("  is still identifiable if it turns up in a log later.\n");
}

const command = process.argv[2];
const run =
  command === "create" ? create : command === "list" ? list : command === "revoke" ? revoke : null;

if (!run) {
  console.error("Usage: keysCli.ts <create|list|revoke> [--flags]");
  process.exit(2);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
