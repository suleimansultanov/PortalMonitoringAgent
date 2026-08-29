import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth/config";

/**
 * One guard in front of everything.
 *
 * Deliberately a middleware rather than a check inside each page. There are six
 * screens and four API routes today and there will be more; a rule that has to
 * be remembered on every new file is a rule that will eventually be forgotten
 * on one, and the forgotten one is the leak. Here the default is closed and the
 * exceptions are listed in `PUBLIC_PREFIXES`, where they can be read.
 *
 * Only `authConfig` is imported — the edge-safe half. Importing `@/lib/auth`
 * here would drag `pg` and `bcryptjs` into the edge bundle and break the build.
 */
export default NextAuth(authConfig).auth;

export const config = {
  /**
   * Everything except next-auth's own endpoints, the login page, the Inngest
   * webhook (it authenticates with a signing key and has no cookie) and static
   * assets.
   *
   * Note this is a denylist of paths to SKIP, not an allowlist of paths to
   * protect. A new screen is guarded the moment it exists, without anyone
   * touching this line — which is the whole point.
   */
  matcher: [
    "/((?!api/auth|api/inngest|login|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|txt|xml)$).*)",
  ],
};
