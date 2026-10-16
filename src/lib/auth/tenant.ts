import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, withDbRetry } from "@/lib/db/client";
import { clients, clientSources, users } from "@/lib/db/schema";
import { auth } from "./index";
import { decideScope, type ClientScope, type ScopeRefusal } from "./scope";

/**
 * The session's client, read from the database on every request. Node only.
 *
 * Not from the JWT, although the token carries a `clientId`. That value is
 * what the account was at sign-in, and a session lasts twelve hours: an
 * account moved to another client, unlinked or deactivated would go on
 * reading the old client's buyers until the cookie expired. For a tenancy
 * check a stale answer is a leak, so the token's copy is never used to scope
 * anything. The cost is one indexed lookup and one small query per request,
 * deduplicated by `cache` across the layout and the page.
 *
 * The scope itself — what is shown — is decided in `./scope.ts`.
 */
const loadScope = cache(async (): Promise<
  { scope: ClientScope } | { refused: ScopeRefusal } | null
> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const [row] = await withDbRetry(() =>
    db
      .select({
        userId: users.id,
        userActive: users.active,
        clientId: clients.id,
        clientSlug: clients.slug,
        clientName: clients.name,
        clientActive: clients.active,
        communeInsee: clients.communeInsee,
      })
      .from(users)
      .leftJoin(clients, eq(clients.id, users.clientId))
      .where(eq(users.id, userId))
      .limit(1),
  );

  const clientId = row?.clientId;
  const subscribed = clientId
    ? await withDbRetry(() =>
        db
          .select({ sourceId: clientSources.sourceId })
          .from(clientSources)
          .where(and(eq(clientSources.clientId, clientId), eq(clientSources.enabled, true))),
      )
    : [];

  return decideScope(row, subscribed.map((s) => s.sourceId));
});

/**
 * For server components: the scope, or a redirect away from the screen.
 *
 * A refused account goes to /no-access, which needs a session and no client —
 * NOT to /login, which sends anyone signed in back to `/`, and round again.
 */
export async function requireClient(): Promise<ClientScope> {
  const result = await loadScope();
  if (!result) redirect("/login");
  if ("refused" in result) redirect("/no-access");
  return result.scope;
}

/** Why the signed-in account has no scope, or null when it has one. For /no-access. */
export async function scopeRefusal(): Promise<ScopeRefusal | null> {
  const result = await loadScope();
  if (!result) return "unknown-user";
  return "refused" in result ? result.refused : null;
}

/**
 * For route handlers: the scope, or the response to send instead.
 *
 * 403 rather than 401 for an account with no client: the caller IS signed in,
 * and a 401 would send a well-behaved client to sign in again, round and
 * round. The middleware has already answered 401 to anyone without a session.
 */
export async function clientForRequest(): Promise<{ scope: ClientScope } | { response: NextResponse }> {
  const result = await loadScope();
  if (!result) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if ("refused" in result) {
    return {
      response: NextResponse.json(
        { error: "forbidden", detail: "This account is not linked to an active client." },
        { status: 403 },
      ),
    };
  }
  return { scope: result.scope };
}
