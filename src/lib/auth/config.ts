import type { DefaultSession, NextAuthConfig } from "next-auth";
// Imported for its side effect on the type system: a module cannot be
// augmented below unless it is part of the program. Without this line the
// `next-auth/jwt` augmentation is silently dropped and `token.role` types as
// `{}`, which fails in the session callback with a message about neither.
import type { JWT } from "next-auth/jwt";

/**
 * The edge-safe half of the auth configuration.
 *
 * Split on purpose, and the split is load-bearing. `middleware.ts` runs on the
 * edge runtime, where `pg` and `bcryptjs` cannot load at all — pull the full
 * config in there and the build fails with an error that points at neither the
 * middleware nor the database. So everything the middleware actually needs (the
 * cookie, the JWT shape, where to send an anonymous visitor) lives here with no
 * database import, and the Credentials provider that talks to Postgres is added
 * in `./index.ts`, which only ever runs in Node.
 *
 * Keep this file free of anything that touches the database, the filesystem or
 * a Node built-in. If you are unsure, it belongs in `./index.ts`.
 */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      clientId: string | null;
    } & DefaultSession["user"];
  }

  interface User {
    role?: string;
    clientId?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: string;
    clientId?: string | null;
  }
}

/**
 * Twelve hours. Long enough that nobody is asked to log in twice in a working
 * day, short enough that a laptop left open in a café is not a standing
 * invitation. There is no refresh: the session simply ends.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

/** Paths that must stay reachable without a session. */
export const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  /**
   * Inngest authenticates every request with its own signing key and has no
   * cookie to present. Putting a login in front of it does not make it safer —
   * it makes the job runner silently stop working, which is the kind of failure
   * that is noticed a week later in missing data.
   */
  "/api/inngest",
];

export const authConfig = {
  /**
   * Vercel serves preview deployments on a different hostname each time, and
   * without this next-auth refuses the callback as a host mismatch. AUTH_URL
   * still wins where it is set.
   */
  trustHost: true,

  pages: { signIn: "/login" },

  /**
   * JWT rather than a database session table. The Credentials provider cannot
   * use a database session anyway, and a stateless cookie is one less query on
   * every request against a pooled Supabase connection we are already careful
   * with.
   *
   * The cost is real and worth naming: revoking a user takes effect on their
   * next sign-in, not immediately. Setting `users.active = false` stops the
   * next login, not the session already in someone's browser. If that ever
   * matters, this is the line to revisit.
   */
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },

  // Filled in by ./index.ts. The middleware needs no provider to read a cookie.
  providers: [],

  callbacks: {
    authorized({ auth, request }) {
      if (auth?.user) return true;

      /**
       * An API request gets a 401, not a redirect. Redirecting an unauthorised
       * fetch to the login page answers 200 with a page of HTML, and whoever is
       * debugging it then spends an hour wondering why their JSON parser is
       * complaining about "<".
       */
      if (request.nextUrl.pathname.startsWith("/api/")) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      return false;
    },

    jwt({ token, user }) {
      // `user` is present only on the request that signs in. Afterwards the
      // token carries these forward on its own.
      if (user) {
        token.role = user.role ?? "member";
        token.clientId = user.clientId ?? null;
      }
      return token;
    },

    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.role = token.role ?? "member";
        session.user.clientId = token.clientId ?? null;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
