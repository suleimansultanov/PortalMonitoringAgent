import { handlers } from "@/lib/auth";

/**
 * next-auth's own endpoints — sign in, sign out, session, CSRF.
 *
 * Node runtime, not edge: the Credentials provider reaches Postgres through
 * `pg`, which cannot run on the edge. The middleware is the edge half and only
 * reads the cookie.
 */
export const runtime = "nodejs";

export const { GET, POST } = handlers;
