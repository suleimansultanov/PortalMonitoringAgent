import "server-only";
import { after, NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { apiRequestLog } from "@/lib/db/schema";
import { dbErrorMessage } from "@/lib/db/errors";
import { keyFromRequest, resolveKey, type KeyScope } from "./keys";
import { bucket, clientIp, hit, LIMITS, pruneNowAndThen } from "./rateLimit";

/**
 * The guard on every /api/v1 route.
 *
 * `middleware.ts` deliberately lets this prefix through without a session
 * (`PUBLIC_ROOTS` in lib/auth/config.ts): its NextAuth check is a browser
 * mechanism, and it runs on the edge where a database lookup is not available.
 * So the key check lives here, in the Node runtime.
 *
 * Every v1 route is written as `export const GET = keyedRoute(async (req,
 * scope) => …)`, so the handler cannot run without a scope, cannot run past
 * its key's rate limit, and is journalled whatever it answers. The rule still
 * lives in each file — an edge middleware cannot read the keys table — and
 * src/lib/api/guard.test.ts fails if a v1 route exports a handler any other
 * way.
 */
export async function authorise(
  req: Request,
): Promise<{ scope: KeyScope } | { response: NextResponse }> {
  const scope = await resolveKey(keyFromRequest(req.headers));
  if (!scope) {
    return {
      response: NextResponse.json(
        {
          error: "unauthorised",
          detail: "Send Authorization: Bearer <key>, or X-Api-Key.",
        },
        {
          status: 401,
          /**
           * One message for unknown, revoked, expired and inactive-client. The
           * differences are only useful to somebody working out which of those
           * they have hit.
           */
          headers: { "WWW-Authenticate": 'Bearer realm="pma"' },
        },
      ),
    };
  }
  return { scope };
}

/** 429, with the seconds until the window turns. */
export function tooManyRequests(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    {
      error: "rate_limited",
      detail: `Too many requests. Retry after ${retryAfterSec} seconds.`,
      retryAfter: retryAfterSec,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

/**
 * Next's generated route types declare `params` as `Promise<unknown>` and
 * reject a handler that promises to know its own shape, so every route is
 * typed this loosely and narrows the params itself.
 */
export type RouteContext = { params: Promise<unknown> };

/**
 * A v1 route: key, then rate limit, then the handler, then the journal.
 *
 * Refused requests are counted too. A key over its limit gets 429 and keeps
 * counting until the window turns; a request with no acceptable key counts
 * against its address, so a script trying keys meets 429 within minutes —
 * and both appear in `api_request_log`, which until 2026-10-15 did not exist:
 * a key being guessed, or a client polling every second, left no trace.
 */
export function keyedRoute(
  handler: (req: NextRequest, scope: KeyScope, context: RouteContext) => Promise<Response>,
): (req: NextRequest, context: RouteContext) => Promise<Response> {
  return async (req, context) => {
    const started = Date.now();
    const ip = clientIp(req.headers);
    let keyId: string | null = null;
    let response: Response;

    try {
      const auth = await authorise(req);
      if ("response" in auth) {
        const verdict = await hit(bucket("v1-unauthorised", ip), LIMITS.v1UnauthorisedPerIp);
        response = verdict.allowed ? auth.response : tooManyRequests(verdict.retryAfterSec);
      } else {
        keyId = auth.scope.keyId;
        const verdict = await hit(bucket("v1-key", keyId), LIMITS.v1PerKey);
        response = verdict.allowed
          ? await handler(req, auth.scope, context)
          : tooManyRequests(verdict.retryAfterSec);
      }
    } catch (err) {
      // The key lookup itself failed. Answered like a failed query, and journalled.
      console.error(`[api/v1] ${req.nextUrl.pathname}`, dbErrorMessage(err));
      response = NextResponse.json({ error: "query failed" }, { status: 500 });
    }

    journal({
      keyId,
      path: req.nextUrl.pathname,
      status: response.status,
      ip,
      durationMs: Date.now() - started,
    });
    return response;
  };
}

/**
 * Written after the response is sent (`after`, which Vercel keeps the
 * function alive for), so the client never waits on its own log line. A
 * journal that cannot be written is logged and dropped: it must never fail
 * the request it describes.
 */
function journal(entry: {
  keyId: string | null;
  path: string;
  status: number;
  ip: string;
  durationMs: number;
}): void {
  const write = async () => {
    try {
      await db.insert(apiRequestLog).values(entry);
      await pruneNowAndThen();
    } catch (err) {
      console.warn("[api/v1] journal not written:", dbErrorMessage(err));
    }
  };
  try {
    after(write);
  } catch {
    // Outside a request scope (a script, a test): write now, unawaited.
    void write();
  }
}

/**
 * Said on every response that carries a date a client might read as a
 * publication date, rather than left in documentation nobody opens twice.
 *
 * `firstListedAt` is when WE first saw a property. Three portals publish a real
 * publication date and four do not, so for most of the corpus this is a floor,
 * not a measurement — and a client instance that quotes it to an agent as
 * "on the market 2 days" will be wrong about anything listed before we started
 * watching.
 */
export const DATE_CAVEAT =
  "firstListedAt is our first sighting, not the portal's publication date. " +
  "For properties listed before we began collecting it is a lower bound, not a " +
  "measurement. delisted means the listing disappeared — it does not mean sold.";
