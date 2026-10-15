import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";
import { tooManyRequests } from "@/lib/api/guard";
import { clientIp, loginRefusal } from "@/lib/api/rateLimit";

/**
 * next-auth's own endpoints — sign in, sign out, session, CSRF.
 *
 * Node runtime, not edge: the Credentials provider reaches Postgres through
 * `pg`, which cannot run on the edge. The middleware is the edge half and only
 * reads the cookie.
 */
export const runtime = "nodejs";

export const { GET } = handlers;

/**
 * A credentials POST over the failed-login limit is answered 429 with
 * `Retry-After` here, before next-auth turns it into a redirect to
 * `/login?error=…`. `authorize` refuses it as well (lib/auth/index.ts) — that
 * is the check the login form's server action meets, since it calls
 * next-auth directly and never passes through this route.
 */
export async function POST(req: NextRequest): Promise<Response> {
  if (req.nextUrl.pathname.endsWith("/callback/credentials")) {
    const form = await req
      .clone()
      .formData()
      .catch(() => null);
    const email = form?.get("email");
    if (typeof email === "string") {
      const wait = await loginRefusal(email, clientIp(req.headers));
      if (wait !== null) return tooManyRequests(wait);
    }
  }
  return handlers.POST(req);
}
