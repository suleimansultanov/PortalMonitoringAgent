import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, schema, withDbRetry } from "@/lib/db/client";

/**
 * Creating and updating the people who can sign in.
 *
 * There is no self-service registration and there should not be. This is one
 * agency's market data; accounts are handed out, not requested.
 */

/**
 * Twelve rounds. Ten is the common default and is fine; twelve costs about
 * 200 ms on the machines this runs on, which nobody notices once per login and
 * makes an offline guess through a leaked table four times more expensive.
 */
export const BCRYPT_ROUNDS = 12;

export type Role = "admin" | "member";

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Refuse the passwords that make the rest of this pointless. Deliberately not a
 * complexity ruleset — length is what actually helps, and forcing a punctuation
 * mark mostly produces `Password1!`.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (/^[0-9]+$/.test(password)) return "Password must not be only digits.";
  if (["password", "changeme", "letmein"].some((w) => password.toLowerCase().includes(w))) {
    return "Password contains a word that is on every guessing list.";
  }
  return null;
}

export async function resolveClientId(slug: string): Promise<string> {
  const [client] = await withDbRetry(() =>
    db.select().from(schema.clients).where(eq(schema.clients.slug, slug)).limit(1),
  );
  if (!client) throw new Error(`No client with slug "${slug}". Run npm run db:seed first.`);
  return client.id;
}

/**
 * Create the account, or reset the password on one that already exists.
 *
 * Upsert rather than create, because the realistic use is "I have forgotten the
 * demo password" and a command that fails with "already exists" at that moment
 * just sends someone into psql with a bcrypt one-liner.
 */
export async function upsertUser(opts: {
  email: string;
  password: string;
  name?: string;
  role?: Role;
  clientSlug?: string;
}): Promise<{ id: string; email: string; role: string; created: boolean }> {
  const email = normaliseEmail(opts.email);

  const problem = passwordProblem(opts.password);
  if (problem) throw new Error(problem);

  const passwordHash = await hashPassword(opts.password);
  const clientId = opts.clientSlug ? await resolveClientId(opts.clientSlug) : null;

  const [existing] = await withDbRetry(() =>
    db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1),
  );

  if (existing) {
    const [updated] = await withDbRetry(() =>
      db
        .update(schema.users)
        .set({
          passwordHash,
          active: true,
          updatedAt: new Date(),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.role ? { role: opts.role } : {}),
          ...(clientId ? { clientId } : {}),
        })
        .where(eq(schema.users.id, existing.id))
        .returning(),
    );
    return { id: updated.id, email: updated.email, role: updated.role, created: false };
  }

  const [created] = await withDbRetry(() =>
    db
      .insert(schema.users)
      .values({
        email,
        name: opts.name ?? null,
        passwordHash,
        role: opts.role ?? "member",
        clientId,
      })
      .returning(),
  );

  return { id: created.id, email: created.email, role: created.role, created: true };
}

/** Leaves the row and its history in place; only stops the next sign-in. */
export async function deactivateUser(email: string): Promise<boolean> {
  const result = await withDbRetry(() =>
    db
      .update(schema.users)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(schema.users.email, normaliseEmail(email)))
      .returning(),
  );
  return result.length > 0;
}

export async function listUsers() {
  return withDbRetry(() =>
    db
      .select({
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        active: schema.users.active,
        lastLoginAt: schema.users.lastLoginAt,
      })
      .from(schema.users),
  );
}
