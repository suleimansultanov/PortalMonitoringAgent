import { sql } from "drizzle-orm";
import { dbErrorMessage } from "./errors";
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
    /**
     * `dbErrorMessage`, not `err.message`.
     *
     * This file printed the raw message, which for anything going through
     * drizzle is the wrapper — "Failed query:" plus the entire SQL, with the
     * one useful line hidden on `cause`. `errors.ts` was written in this
     * project precisely to undo that, and this entry point was the one place
     * not using it: the command whose whole job is to answer "what is wrong
     * with my connection" was the command that would not say.
     */
    console.error("\n[db:info] failed:", dbErrorMessage(err));

    /**
     * Connection-level failures do not come wrapped, and their `code` is the
     * quickest route to the cause — so it is printed rather than described.
     */
    const code = (err as { code?: string; cause?: { code?: string } })?.code
      ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code) console.error(`[db:info] code: ${code}`);

    console.error(
      "\n  28P01  the password is wrong. If the connection string was typed into a\n" +
        "         shell, check it survived: an unencoded @ splits the URL, and in zsh\n" +
        "         a ! inside double quotes is history expansion. Percent-encode the\n" +
        "         password (@ = %40, ! = %21) or let the script prompt for it.\n" +
        "  3D000  the database in the connection string does not exist.\n" +
        "  ENOTFOUND / ETIMEDOUT  the host is wrong or unreachable.\n" +
        "  08P01 / unsupported startup parameter  you are on the transaction pooler\n" +
        "         (:6543). Use the session pooler (:5432).\n",
    );
    process.exit(1);
  });
