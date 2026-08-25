// Run with: npm run db:migrate
//
// Applies every drizzle/*.sql in filename order, recording what has been
// applied in a `_migrations` table.
//
// Deliberately NOT drizzle-orm's migrator. That one is driven by
// `drizzle/meta/_journal.json`, which drizzle-kit maintains when it generates
// migrations for you. We write migrations by hand, so the journal becomes a
// second thing to keep in sync with the first — and the failure mode is a
// migration that silently never runs. A filename and a table are enough.

import path from "node:path";
import fs from "node:fs/promises";
import { Pool } from "pg";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const pool = new Pool({ connectionString: url, max: 1 });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "_migrations" (
      "name"       text PRIMARY KEY,
      "applied_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ name: string }>(`SELECT name FROM "_migrations"`);
  const applied = new Set(rows.map((r) => r.name));

  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    console.log(`[migrate] applying ${file}`);

    /**
     * One transaction per file. Our migrations are idempotent, so a half-applied
     * file would survive a re-run — but a half-applied file that also got
     * recorded as applied would not, and that is the case worth preventing.
     */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO "_migrations" ("name") VALUES ($1)`, [file]);
      await client.query("COMMIT");
      ran += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  console.log(ran === 0 ? "[migrate] nothing to do" : `[migrate] applied ${ran} migration(s)`);
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
