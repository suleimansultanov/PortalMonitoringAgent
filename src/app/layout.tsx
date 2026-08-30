import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { signOutAction } from "@/lib/auth/actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Market Analysis — Med-Estates",
  description: "New stock, buyer matches and market reports across the Gulf of Saint-Tropez.",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/listings", label: "Listings" },
  { href: "/matches", label: "Matches" },
  { href: "/reports", label: "Reports" },
  { href: "/sources", label: "Sources" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /**
   * The header is hidden when nobody is signed in, so the login page does not
   * show navigation to four screens that will bounce straight back to it.
   *
   * This is presentation only. Access is decided in `src/middleware.ts` — never
   * infer from a missing nav bar that a route is protected.
   */
  const session = await auth();

  return (
    <html lang="en">
      <body>
        {session?.user && (
          <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-[var(--color-canvas)]/95 backdrop-blur">
            <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-8 py-3.5">
              <div className="flex items-center gap-4">
                <span className="text-[10px] font-semibold uppercase leading-[1.1] tracking-[0.18em] text-[var(--color-ink)]">
                  Lead
                  <br />
                  Estate
                </span>
                <span className="h-5 w-px bg-[var(--color-line)]" />
                <span className="display text-[15px]">Market Analysis</span>
              </div>

              <nav className="ml-auto flex items-center gap-1 rounded-full border border-[var(--color-line)] p-1">
                {NAV.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="rounded-full px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>

              <div className="flex items-center gap-3 text-[11px] text-[var(--color-muted)]">
                <span className="hidden sm:inline">{session.user.email}</span>
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className="rounded-full border border-[var(--color-line)] px-3 py-1.5 font-medium uppercase tracking-[0.1em] transition-colors hover:text-[var(--color-ink)]"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </header>
        )}
        <main className="mx-auto max-w-[1600px] px-8 py-8">{children}</main>
      </body>
    </html>
  );
}
