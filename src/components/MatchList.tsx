"use client";

import { useState } from "react";
import { TestBadge, money, m2 } from "./ui";

/**
 * The Matches list.
 *
 * The design rule this file exists to hold: **the score is never shown without
 * its reasons.** An agent will not act on a number they cannot check, and the
 * first time an unexplained one is wrong they stop reading the screen. So the
 * reasons are not behind a disclosure triangle — they are the row.
 */

type Reason = { field: string; ok: boolean | null; detail: string; disqualifying?: boolean };

export type Match = {
  id: string;
  score: number;
  status: string;
  reasons: Reason[];
  buyer: { id: string; name: string; agent: string | null; isTestData: boolean };
  property: {
    id: string;
    title: string | null;
    headline: string;
    imageUrl: string | null;
    priceEur: number | null;
    areaM2: number | null;
    landM2: number | null;
    bedrooms: number | null;
    propertyType: string | null;
    communeLabel: string | null;
    agencyName: string | null;
    daysOnMarket: number | null;
    sourceCount: number;
    portals: { source: string; url: string }[];
  };
};

export function MatchList({ initial }: { initial: Match[] }) {
  const [matches, setMatches] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, status: "sent" | "dismissed" | "seen") {
    setBusy(id);
    /**
     * Ask for a reason when dismissing.
     *
     * This is the only feedback the scoring will ever get about being wrong.
     * The weights and the threshold are currently an argument between people;
     * a few hundred of these turn them into something with evidence behind it.
     * Skippable — a required field here would only ever collect the word "no".
     */
    let dismissedReason: string | undefined;
    if (status === "dismissed") {
      dismissedReason =
        window.prompt("Why not? (optional — it is how the matching improves)") ?? undefined;
    }

    try {
      const res = await fetch("/api/matches", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status, dismissedReason }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMatches((prev) =>
        status === "dismissed"
          ? prev.filter((m) => m.id !== id)
          : prev.map((m) => (m.id === id ? { ...m, status } : m)),
      );
    } catch (err) {
      // Say so rather than silently leaving the row unchanged. An agent who
      // thinks they dismissed something and finds it back tomorrow stops
      // trusting the buttons.
      alert(`Could not update: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (matches.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-6 py-16 text-center">
        <div className="text-sm font-medium">No open matches</div>
        <div className="mx-auto mt-2 max-w-lg text-sm text-[var(--color-muted)]">
          Either nothing new fits anyone&apos;s brief, or the communes those buyers care
          about have not been crawled yet. The Reports page shows which sources have
          actually run.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {matches.map((m) => (
        <article
          key={m.id}
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{m.buyer.name}</span>
                {m.buyer.isTestData && <TestBadge />}
                {m.buyer.agent && (
                  <span className="text-xs text-[var(--color-muted)]">· {m.buyer.agent}</span>
                )}
              </div>
              <div className="mt-2 truncate text-sm">{m.property.headline}</div>
              <div className="tnum mt-1 text-xs text-[var(--color-muted)]">
                {money(m.property.priceEur)} · {m2(m.property.areaM2)} ·{" "}
                {m.property.bedrooms ?? "—"} beds · {m.property.communeLabel ?? "—"}
                {m.property.agencyName && ` · ${m.property.agencyName}`}
                {m.property.daysOnMarket !== null && ` · seen ${m.property.daysOnMarket}d`}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <ScoreDial score={m.score} />
              <div className="flex flex-col gap-1.5">
                <button
                  disabled={busy === m.id}
                  onClick={() => act(m.id, "sent")}
                  className="rounded border border-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-white disabled:opacity-40"
                >
                  {m.status === "sent" ? "Sent ✓" : "Mark sent"}
                </button>
                <button
                  disabled={busy === m.id}
                  onClick={() => act(m.id, "dismissed")}
                  className="rounded border border-[var(--color-line)] px-3 py-1 text-xs text-[var(--color-muted)] hover:border-[var(--color-down)] hover:text-[var(--color-down)] disabled:opacity-40"
                >
                  Not for them
                </button>
              </div>
            </div>
          </div>

          {/* The reasons ARE the row. Not collapsed, not optional. */}
          <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-[var(--color-line)] pt-3 text-xs">
            {m.reasons.map((r, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <Mark ok={r.ok} />
                <span
                  className={
                    r.ok === false
                      ? "text-[var(--color-muted)]"
                      : r.ok === null
                        ? "italic text-[var(--color-muted)]"
                        : ""
                  }
                >
                  {r.detail}
                </span>
              </li>
            ))}
          </ul>

          {m.property.portals.length > 0 && (
            <div className="mt-3 flex items-center gap-1.5">
              {m.property.portals.map((p) => (
                <a
                  key={p.url}
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded border border-[var(--color-line)] px-2 py-0.5 text-[10px] uppercase text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                >
                  {p.source}
                </a>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

/** ✓ satisfied · ✕ not satisfied · ? we could not tell, which is not the same thing. */
function Mark({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="text-[var(--color-muted)]">?</span>;
  return ok ? (
    <span className="text-[var(--color-accent)]">✓</span>
  ) : (
    <span className="text-[var(--color-muted)]">✕</span>
  );
}

function ScoreDial({ score }: { score: number }) {
  return (
    <div
      className="tnum flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold"
      style={{
        borderColor: score >= 85 ? "var(--color-accent)" : "var(--color-line)",
        color: score >= 85 ? "var(--color-accent)" : "var(--color-ink)",
      }}
      title="Only meaningful next to the reasons below it"
    >
      {score}
    </div>
  );
}
