import { sourceStats, lastSyncAt, overview, type SourceStat } from "@/lib/api/queries";
import { Card, Stat, Warnings } from "@/components/ui";
import { SourceGraph } from "@/components/SourceGraph";

/**
 * Sources.
 *
 * The screen that would have caught three weeks of quiet under-collection in an
 * afternoon.
 *
 * Every portal we read has, at some point, stopped short and looked finished: a
 * page ceiling reached mid-commune, a pagination parameter accepted and
 * ignored, an index error read as the end of the results. None of them threw,
 * none appeared in a log, and each was found by hand days later by someone
 * counting files on a laptop.
 *
 * What makes truncation findable is not any single number but the shape of
 * several together — when a source was last read, how much of it we have not
 * re-read since, whether its last pass aborted, and how much is arriving now
 * versus a week ago. A source that has stopped growing while its neighbours
 * have not is the signature, and it is visible here at a glance.
 *
 * The screen states the limits of its own numbers, for the same reason the
 * Overview does: an agent will not act on a figure they cannot check, and the
 * first unexplained one that turns out wrong costs more trust than the feature
 * was worth.
 */

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const [sources, synced, head] = await Promise.all([
    sourceStats(),
    lastSyncAt(),
    overview(),
  ]);

  const live = sources.filter((s) => s.active > 0);
  const totalActive = live.reduce((n, s) => n + s.active, 0);
  /**
   * A source whose live stock more than half arrived in the last day is being
   * backfilled, not watched. Its "new" figures describe our catching up and
   * say nothing about the market, so they are reported as such rather than
   * summed into a headline.
   */
  const backfilling = live.filter((s) => s.newLast24h > s.active * 0.5);
  const settled = live.filter((s) => s.newLast24h <= s.active * 0.5);

  const warnings: string[] = [];

  const syncAge = synced ? Date.now() - synced.getTime() : null;
  if (synced === null) {
    warnings.push(
      "No sync to the hosted database has ever been recorded. Everything below " +
        "describes the collector's own database — the deployed site may be showing " +
        "something older.",
    );
  } else if (syncAge !== null && syncAge > 24 * 3600_000) {
    warnings.push(
      `The hosted database was last updated ${relative(synced)}. What the client ` +
        `sees is that old, whatever this screen says.`,
    );
  }

  for (const s of sources.filter((x) => x.lastRun?.status === "aborted")) {
    warnings.push(
      `${s.name}'s last pass aborted — ${s.lastRun?.abortedReason ?? "no reason recorded"}`,
    );
  }

  for (const s of sources.filter((x) => x.lastRun?.status === "running")) {
    warnings.push(
      `${s.name} has a pass still marked running since ${relative(s.lastRun!.startedAt)}. ` +
        `Either it is collecting right now, or it was interrupted and never closed its record.`,
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Sources</h1>

      <Warnings items={warnings} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/*
          Sites, not adapters. One SMC adapter serves Maisons et Appartements
          and Résidences Immobilier, so "4 portals" undercounts what is actually
          being read — and the count of sites is the one anybody asks for.
        */}
        <Stat
          label="Sites collecting"
          value={live.reduce((n, s) => n + Math.max(1, s.hosts.length), 0)}
          hint={`through ${live.length} adapter${live.length === 1 ? "" : "s"}`}
        />
        <Stat
          label="Active listings"
          value={totalActive.toLocaleString("en-GB")}
          hint="before deduplication"
        />
        {/*
          Sources still backfilling are excluded rather than counted. On the day
          a portal is first collected every one of its listings is "new", and
          adding those up produced "4,378 new in 24 hours" against 7,179 live —
          a number that reads as a market doubling overnight and is really just
          us catching up. What is left is movement we can actually stand behind.
        */}
        <Stat
          label="New in 24 hours"
          value={settled.reduce((n, s) => n + s.newLast24h, 0)}
          hint={
            backfilling.length > 0
              ? `${backfilling.length} source${backfilling.length === 1 ? "" : "s"} still backfilling, excluded`
              : "first seen by us, not published"
          }
        />
        <Stat
          label="Hosted data"
          value={synced ? relative(synced) : "never"}
          hint={synced ? "last push to Supabase" : "no sync recorded"}
          tone={synced === null || (syncAge ?? 0) > 24 * 3600_000 ? "accent" : undefined}
        />
      </div>

      <SourceGraph
        sources={sources}
        properties={head.activeProperties}
        syncedLabel={synced ? relative(synced) : "never synced"}
        syncStale={synced === null || (syncAge ?? 0) > 24 * 3600_000}
      />

      <div className="space-y-4">
        {sources.map((s) => (
          <SourceCard key={s.key} s={s} />
        ))}
      </div>

      <Card title="How to read this">
        <div className="space-y-2 px-5 py-4 text-[13px] leading-relaxed text-[var(--color-muted)]">
          <p>
            <strong className="text-[var(--color-ink)]">Active</strong> is what we believe is on
            the market now. <strong className="text-[var(--color-ink)]">Ever seen</strong> counts
            everything the source has shown us, including what has since gone — the gap between
            them is our record of the market moving, not an error.
          </p>
          <p>
            <strong className="text-[var(--color-ink)]">New</strong> means first seen{" "}
            <em>by us</em>. A listing published in April and collected yesterday counts as new
            yesterday. Only Superimmo publishes a real publication date; for the others, days on
            market run from our first sighting and will read short until we have been watching
            longer.
          </p>
          <p>
            <strong className="text-[var(--color-ink)]">Not re-read in 7 days</strong> is the one
            to watch. A source whose stale count climbs while nothing new arrives has stopped
            being collected, whatever its totals say — and that is what every truncation this
            project has hit looked like from the outside.
          </p>
          <p>
            There is deliberately no &ldquo;listings on the portal&rdquo; column. We cannot know
            that number without asking the portal, and a guess printed beside a measurement gets
            read as a measurement.
          </p>
        </div>
      </Card>
    </div>
  );
}

function SourceCard({ s }: { s: SourceStat }) {
  const run = s.lastRun;
  const bad = run?.status === "aborted" || run?.status === "error";

  return (
    <Card
      title={s.name}
      aside={
        <div className="flex items-center gap-2 text-[11px]">
          {!s.enabled && (
            <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[var(--color-faint)]">
              not scheduled
            </span>
          )}
          <span className="font-mono text-[var(--color-faint)]">{s.key}</span>
        </div>
      }
    >
      <div className="grid gap-x-8 gap-y-3 px-5 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Active" value={s.active.toLocaleString("en-GB")} />
        <Field label="Ever seen" value={s.everSeen.toLocaleString("en-GB")} />
        <Field label="Delisted" value={s.delisted.toLocaleString("en-GB")} />
        <Field label="Communes with stock" value={`${s.communes} of 12`} />

        <Field
          label="New — 24 hours"
          value={s.active > 0 && s.newLast24h > s.active * 0.5 ? "backfill" : s.newLast24h}
        />
        <Field
          label="New — 7 days"
          value={s.active > 0 && s.newLast7d > s.active * 0.5 ? "backfill" : s.newLast7d}
        />
        <Field
          label="Not re-read in 7 days"
          value={s.stale.toLocaleString("en-GB")}
          tone={s.active > 0 && s.stale > s.active / 2 ? "warn" : undefined}
        />
        <Field label="Watching since" value={s.firstSeenAt ? dateOnly(s.firstSeenAt) : "—"} />
      </div>

      <div className="border-t border-[var(--color-line-soft)] px-5 py-3.5 text-[13px]">
        {run === null ? (
          <span className="text-[var(--color-faint)]">Never collected.</span>
        ) : (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-faint)]">
                Last pass
              </span>
              <span className={bad ? "text-[var(--color-warn)]" : ""}>{run.status}</span>
              <span className="text-[var(--color-faint)]">·</span>
              <span className="text-[var(--color-muted)]">{relative(run.startedAt)}</span>
              {run.completedAt && (
                <>
                  <span className="text-[var(--color-faint)]">·</span>
                  <span className="text-[var(--color-muted)]">
                    took {duration(run.startedAt, run.completedAt)}
                  </span>
                </>
              )}
            </div>
            <div className="text-[var(--color-muted)]">
              found {run.seen.toLocaleString("en-GB")} · added {run.added} · delisted {run.gone} ·
              failed {run.failed} · {run.communes} communes
            </div>
            {run.abortedReason && (
              <div className="text-[var(--color-warn)]">{run.abortedReason}</div>
            )}
            {run.error && !run.abortedReason && (
              <div className="text-[var(--color-warn)]">{run.error.slice(0, 200)}</div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "warn";
}) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-faint)]">
        {label}
      </div>
      <div className={`mt-0.5 ${tone === "warn" ? "text-[var(--color-warn)]" : ""}`}>{value}</div>
    </div>
  );
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "3 h ago" — vaguer than a timestamp on purpose; the age is the point. */
function relative(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function duration(a: Date, b: Date): string {
  const secs = Math.round((b.getTime() - a.getTime()) / 1000);
  if (secs < 90) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} min`;
  return `${(mins / 60).toFixed(1)} h`;
}
