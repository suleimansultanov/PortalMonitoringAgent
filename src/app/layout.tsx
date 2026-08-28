import type { Metadata } from "next";
import Link from "next/link";
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
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
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
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-8 py-8">{children}</main>
      </body>
    </html>
  );
}
