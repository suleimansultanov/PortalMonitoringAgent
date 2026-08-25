import { defineConfig } from "drizzle-kit";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

/**
 * NOTE: `drizzle-kit generate` is NOT how migrations are authored here.
 *
 * Migrations in `drizzle/` are written by hand as idempotent SQL, the same
 * convention as the Vault project. Generated migrations drift from what is
 * actually applied to Supabase and give no place to put `IF NOT EXISTS`, which
 * is what makes a re-run safe. This config exists for `drizzle-kit studio` and
 * for diffing against the schema when you want to check yourself.
 */
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/portaldb",
  },
  strict: true,
  verbose: true,
});
