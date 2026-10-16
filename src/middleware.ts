import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth/config";

/**
 * One guard in front of everything.
 *
 * Deliberately a middleware rather than a check inside each page. There are six
 * screens and four API routes today and there will be more; a rule that has to
 * be remembered on every new file is a rule that will eventually be forgotten
 * on one, and the forgotten one is the leak. Here the default is closed and the
 * exceptions are listed once, in `PUBLIC_PATHS` / `PUBLIC_ROOTS`
 * (lib/auth/config.ts), where `authorized` reads them.
 *
 * Only `authConfig` is imported — the edge-safe half. Importing `@/lib/auth`
 * here would drag `pg` and `bcryptjs` into the edge bundle and break the build.
 */
export default NextAuth(authConfig).auth;

export const config = {
  /**
   * Which requests reach the guard at all: everything but the build's own
   * assets, which are skipped for cost alone — every chunk of every page would
   * otherwise be an edge invocation. WHO MAY SKIP THE LOGIN is not decided
   * here. It is `isPublicPath` in lib/auth/config.ts, and
   * src/middleware.test.ts fails if this line ever skips a path that list does
   * not make public.
   *
   * Until 2026-10-15 this line was the list, with a global tail that let any
   * path ending in `.png` past the login. Next requires the matcher to be a
   * literal, so it cannot import the list — which is exactly why it no longer
   * carries one.
   *
   * Note this is a denylist of paths to SKIP, not an allowlist of paths to
   * protect. A new screen is guarded the moment it exists, without anyone
   * touching this line — which is the whole point.
   */
  matcher: ["/((?!_next/static/|_next/image$|favicon\\.ico$).*)"],
};
