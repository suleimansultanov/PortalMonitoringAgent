import { redirect } from "next/navigation";
import { scopeRefusal } from "@/lib/auth/tenant";
import { signOutAction } from "@/lib/auth/actions";

/**
 * Where a signed-in account without a client lands.
 *
 * Every screen shows one client's market and is refused to an account that
 * has none (lib/auth/scope.ts) — never "everything" in its place. This page
 * needs a session and nothing else, so it cannot loop: /login sends anyone
 * signed in back to `/`, which would send them here again.
 *
 * It says what to run, because on 2026-10-15 the account most likely to see
 * it was the operator's own: the only one in production, an admin created
 * before any account had a client.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "No access — Market Analysis" };

const WHY: Record<string, string> = {
  "no-client": "This account is not linked to a client, so there is no market to show it.",
  "inactive-client": "The client this account belongs to is switched off.",
  "inactive-user": "This account has been deactivated.",
  "unknown-user": "This account no longer exists.",
};

export default async function NoAccessPage() {
  const refusal = await scopeRefusal();
  // Linked since the redirect: no reason to stay.
  if (refusal === null) redirect("/portal");

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-[480px] flex-col justify-center">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-faint)]">
        No access
      </div>
      <h1 className="display text-[26px] leading-tight">{WHY[refusal] ?? WHY["no-client"]}</h1>

      {refusal === "no-client" && (
        <p className="mt-4 text-sm text-[var(--color-muted)]">
          Whoever runs the collector can link it, without changing its password:
          <code className="mt-2 block rounded bg-[var(--color-raised)] px-2 py-1.5 text-[12px]">
            npm run user:create -- --email=… --client=&lt;slug&gt; --link
          </code>
          <span className="mt-2 block">It takes effect on the next page load.</span>
        </p>
      )}

      <form action={signOutAction} className="mt-6">
        <button
          type="submit"
          className="rounded-full border border-[var(--color-line)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
