import { sql } from "drizzle-orm";
import { db } from "./client";

/**
 * Where are we actually connected, and what is in there?
 *
 *   npm run db:info
 *
 * Written after a `psql` session and the collector disagreed about whether a
 * table existed. They were talking to different places, and the fastest way to
 * settle that is to ask through the same connection string the collector uses
 * rather than through a second one typed from memory.
 *
 * Read-only.
 */

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const where = await db.execute<Row>(sql`
    select current_database() as database,
           current_schema()   as schema,
           inet_server_addr()::text as host,
           inet_server_port() as port,
           current_user       as "user"
  `);
  const w = where.rows[0] ?? {};
  console.log(`\nconnected to ${w.database}.${w.schema} as ${w.user}`);
  console.log(`  server ${w.host ?? "local socket"}:${w.port ?? "?"}\n`);

  const tables = await db.execute<Row>(sql`
    select table_schema, table_name
    from information_schema.tables
    where table_type = 'BASE TABLE'
      and table_schema not in ('pg_catalog', 'information_schema')
    order by table_schema, table_name
  `);

  if (tables.rows.length === 0) {
    console.log(
      "no tables at all — this database has never been migrated.\n" +
        "Run `npm run db:migrate`, and check DATABASE_URL points where you think.\n",
    );
    return;
  }

  console.log(`${tables.rows.length} tables:\n`);
  for (const t of tables.rows) {
    const schema = String(t.table_schema);
    const name = String(t.table_name);
    // Identifiers cannot be bound as parameters, hence sql.raw — the values
    // come from information_schema, not from user input.
    const c = await db.execute<Row>(sql.raw(`select count(*)::int as n from "${schema}"."${name}"`));
    const n = Number(c.rows[0]?.n ?? 0);
    const label = schema === "public" ? name : `${schema}.${name}`;
    console.log(`  ${String(n).padStart(7)}  ${label}`);
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[db:info] failed:", (err as Error).message);
    console.error(
      "\nIf this says the database does not exist, DATABASE_URL in .env.local is\n" +
        "pointing somewhere that was never created.\n",
    );
    process.exit(1);
  });
