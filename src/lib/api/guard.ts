import "server-only";
import { NextResponse } from "next/server";
import { keyFromRequest, resolveKey, type KeyScope } from "./keys";

/**
 * The guard on every /api/v1 route.
 *
 * `middleware.ts` deliberately skips this prefix: its NextAuth check is a
 * browser mechanism, and it runs on the edge where a database lookup is not
 * available. So the key check lives here, in the Node runtime, and every v1
 * route calls it as its first statement.
 *
 * That makes it a rule to remember on each new file — the exact shape the
 * middleware comment warns about. It is accepted here because the alternative
 * is worse: an edge middleware cannot read the keys table, so the choice is
 * between one line per route and a second cache of credentials at the edge.
 * The mitigation is that a route which forgets this returns market data with no
 * client scope at all, which the first test against it makes obvious.
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
