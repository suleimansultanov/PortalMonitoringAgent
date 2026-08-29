import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema, withDbRetry } from "@/lib/db/client";
import { authConfig } from "./config";

/**
 * The Node half of auth: the one piece that reads the database.
 *
 * Everything here runs in the Node runtime only. See `./config.ts` for why the
 * configuration is split in two.
 */

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

/**
 * A real bcrypt hash of a random string nobody holds.
 *
 * When the email does not exist we still run a comparison against this, so a
 * missing account costs the same ~200 ms as a wrong password. Returning early
 * instead would answer "no such user" in a millisecond and "wrong password" in
 * two hundred, which is a readable answer to "does this person have an
 * account here" for anyone with a stopwatch.
 */
const DUMMY_HASH = "$2a$12$1kFSrWb48xFY91HEXJoAG.R8QSNganlGZY/.uNgI4BfF39gWeOQAO";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },

      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        // Zod at the boundary, as everywhere else in this project. A malformed
        // POST is a failed login, not a 500.
        if (!parsed.success) return null;

        const email = parsed.data.email.trim().toLowerCase();

        const [user] = await withDbRetry(() =>
          db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1),
        );

        const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);

        // One indistinguishable failure for every reason. The person signing in
        // learns nothing from which of these was true, and neither does anyone
        // guessing.
        if (!user || !user.passwordHash || !user.active || !ok) return null;

        // Best effort. A failure to record the timestamp must not fail a
        // legitimate login — it is a nicety, not part of the decision.
        void withDbRetry(() =>
          db
            .update(schema.users)
            .set({ lastLoginAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.users.id, user.id)),
        ).catch((err) => console.warn("[auth] could not record lastLoginAt:", err));

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          clientId: user.clientId,
        };
      },
    }),
  ],
});

/** True when there is a signed-in user. For server components and route handlers. */
export async function requireSession() {
  const session = await auth();
  if (!session?.user) throw new Error("Not authenticated");
  return session;
}
