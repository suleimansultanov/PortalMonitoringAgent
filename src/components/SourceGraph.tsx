import type { SourceStat } from "@/lib/api/queries";

/**
 * The collector, drawn.
 *
 * Five cards stacked down a page answer "how is each portal doing". They do not
 * answer the question people actually arrive with, which is "what is plugged in
 * and what is not" — and that one is a shape, not a column of numbers.
 *
 * Left to right, because that is the direction the data moves: portals feed
 * listings, deduplication turns listings into properties, a sync pushes those
 * to the site the client opens. Three stages, and each is a place things have
 * gone wrong: a portal stops answering, a merge collapses two houses into one,
 * a sync does not run and the site quietly shows yesterday.
 *
 * STATE IS CARRIED BY THE LINE, NOT THE COLOUR. A solid line is a source we
 * collect from; a dashed one is a portal that refuses us or has no adapter yet.
 * The palette validator is the reason: the obvious green/amber pair separates by
 * ΔE 5.6 under protanopia against this surface, well under the floor of 8, so
 * colour alone would leave the single most important distinction on this screen
 * invisible to a good number of people. Every node also carries its state in
 * words.
 *
 * Deliberately not a force-directed graph. Positions are computed, stable and
 * readable at a glance; a layout that rearranges itself between visits makes
 * people re-learn the picture every time, and there is no relationship here
 * that physics would reveal.
 */

/**
 * Portals with no adapter, so no row in `portal_sources` to read this from.
 *
 * Hardcoded, and the only hardcoded thing on this screen. They are here because
 * a picture of what we collect that silently omits what we cannot collect is
 * the more misleading of the two drawings — "five portals" reads as "the
 * market" until you know there are nine. `docs/PORTAL-ROADMAP.md` is where the
 * reasoning lives and where this list should be reconciled when it changes.
 */
const UNREACHED = [
  { name: "SeLoger", detail: "403 · permission granted, never served" },
  { name: "Belles Demeures", detail: "same engine as SeLoger" },
  { name: "JamesEdition", detail: "403 on every path" },
  { name: "Propriétés Le Figaro", detail: "their robots.txt itself returns 403" },
];

const W = 720;
const NODE_W = 232;
const NODE_H = 78;
const GAP = 14;
const LEFT_X = 8;
const HUB_X = 468;
const HUB_W = 210;

export function SourceGraph({
  sources,
  properties,
  syncedLabel,
  syncStale,
}: {
  sources: SourceStat[];
  properties: number;
  syncedLabel: string;
  syncStale: boolean;
}) {
  const live = sources.filter((s) => s.active > 0);
  const idle = sources.filter((s) => s.active === 0);
  const rows = [...live, ...idle];

  const topPad = 18;
  const leftH = rows.length * NODE_H + (rows.length - 1) * GAP;
  const unreachedH = UNREACHED.length * 34 + 34;
  /**
   * The client's view sits BELOW the hub rather than to its right.
   *
   * Side by side it needed 930px of viewBox, and inside a panel narrower than
   * that the last node — the one that says whether the client is looking at
   * today's data — was the first thing clipped off the edge. Stacking costs a
   * little height, which a page scrolls, instead of width, which cuts.
   */
  const H = topPad * 2 + Math.max(leftH + 30 + unreachedH, 340);

  const maxActive = Math.max(1, ...live.map((s) => s.active));
  const hubY = topPad + leftH / 2;
  const totalActive = live.reduce((n, s) => n + s.active, 0);

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={
          `Collection pipeline: ${live.length} portals feeding ${totalActive} listings, ` +
          `deduplicated to ${properties} properties, last pushed to the site ${syncedLabel}.`
        }
        style={{ minWidth: 620, display: "block" }}
      >
        {rows.map((s, i) => {
          const y = topPad + i * (NODE_H + GAP);
          const connected = s.active > 0;
          /**
           * Width by share of listings, floored at 1.5px. A hairline for a
           * small source is honest; an invisible one is not, and a source
           * dropping to nothing is exactly what this picture is for.
           */
          const w = connected ? 1.5 + (s.active / maxActive) * 6.5 : 1.5;
          return (
            <path
              key={`edge-${s.key}`}
              d={curve(LEFT_X + NODE_W, y + NODE_H / 2, HUB_X, hubY)}
              fill="none"
              stroke={connected ? "var(--color-up)" : "var(--color-faint)"}
              strokeWidth={w}
              strokeOpacity={connected ? 0.55 : 0.4}
              strokeDasharray={connected ? undefined : "5 5"}
            />
          );
        })}

        {rows.map((s, i) => (
          <SourceNode key={s.key} s={s} y={topPad + i * (NODE_H + GAP)} />
        ))}

        {/* Portals with no adapter: drawn, but plainly outside the pipeline. */}
        <g transform={`translate(${LEFT_X}, ${topPad + leftH + 34})`}>
          <text x={4} y={0} className="fill-[var(--color-faint)]" fontSize={10.5} letterSpacing="0.16em">
            NOT CONNECTED
          </text>
          {UNREACHED.map((u, i) => (
            <g key={u.name} transform={`translate(0, ${18 + i * 34})`}>
              <rect
                width={NODE_W}
                height={28}
                rx={7}
                fill="none"
                stroke="var(--color-line)"
                strokeDasharray="5 5"
              />
              <text x={12} y={13} className="fill-[var(--color-muted)]" fontSize={12}>
                {u.name}
              </text>
              <text x={12} y={23.5} className="fill-[var(--color-faint)]" fontSize={9.5}>
                {u.detail}
              </text>
            </g>
          ))}
        </g>

        {/* The hub: listings become properties here. */}
        <g transform={`translate(${HUB_X}, ${hubY - 62})`}>
          <rect width={210} height={124} rx={12} fill="var(--color-raised)" stroke="var(--color-line)" />
          <text x={16} y={24} className="fill-[var(--color-faint)]" fontSize={10} letterSpacing="0.16em">
            DEDUPLICATION
          </text>
          <text x={16} y={56} className="fill-[var(--color-ink)]" fontSize={26} fontWeight={600}>
            {properties.toLocaleString("en-GB")}
          </text>
          <text x={16} y={73} className="fill-[var(--color-muted)]" fontSize={11}>
            properties
          </text>
          <text x={16} y={97} className="fill-[var(--color-faint)]" fontSize={10.5}>
            from {totalActive.toLocaleString("en-GB")} listings
          </text>
          <text x={16} y={111} className="fill-[var(--color-faint)]" fontSize={10.5}>
            one house, listed several times
          </text>
        </g>

        <path
          d={`M ${HUB_X + HUB_W / 2} ${hubY + 62} L ${HUB_X + HUB_W / 2} ${hubY + 96}`}
          fill="none"
          stroke={syncStale ? "var(--color-warn)" : "var(--color-up)"}
          strokeWidth={4}
          strokeOpacity={0.55}
          strokeDasharray={syncStale ? "6 5" : undefined}
        />

        {/* What the client actually opens. */}
        <g transform={`translate(${HUB_X - 4}, ${hubY + 96})`}>
          <rect
            width={196}
            height={92}
            rx={12}
            fill="var(--color-raised)"
            stroke={syncStale ? "var(--color-warn)" : "var(--color-line)"}
          />
          <text x={16} y={24} className="fill-[var(--color-faint)]" fontSize={10} letterSpacing="0.16em">
            THE CLIENT&rsquo;S VIEW
          </text>
          <text
            x={16}
            y={50}
            fontSize={15}
            fontWeight={600}
            className={syncStale ? "fill-[var(--color-warn)]" : "fill-[var(--color-ink)]"}
          >
            {syncedLabel}
          </text>
          <text x={16} y={68} className="fill-[var(--color-muted)]" fontSize={10.5}>
            last push to the hosted site
          </text>
          <text x={16} y={82} className="fill-[var(--color-faint)]" fontSize={10}>
            {syncStale ? "everything left of here is newer" : "in step with the collector"}
          </text>
        </g>
      </svg>
    </div>
  );
}

function SourceNode({ s, y }: { s: SourceStat; y: number }) {
  const connected = s.active > 0;
  const initial = s.name.replace(/[^A-Za-z]/g, "").slice(0, 1).toUpperCase();
  const sites = s.hosts.length > 1 ? `${s.hosts.length} sites` : s.hosts[0] ?? "";

  return (
    <g transform={`translate(${LEFT_X}, ${y})`}>
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={12}
        fill="var(--color-raised)"
        stroke={connected ? "var(--color-line)" : "var(--color-line-soft)"}
        strokeDasharray={connected ? undefined : "5 5"}
      />
      <circle
        cx={30}
        cy={NODE_H / 2}
        r={15}
        fill="none"
        stroke={connected ? "var(--color-up)" : "var(--color-faint)"}
        strokeWidth={1.5}
        strokeOpacity={0.7}
      />
      <text
        x={30}
        y={NODE_H / 2 + 4.5}
        textAnchor="middle"
        fontSize={13}
        fontWeight={600}
        className={connected ? "fill-[var(--color-up)]" : "fill-[var(--color-faint)]"}
      >
        {initial}
      </text>

      <text x={57} y={24} className="fill-[var(--color-ink)]" fontSize={13} fontWeight={500}>
        {s.name}
      </text>
      <text x={57} y={38} className="fill-[var(--color-faint)]" fontSize={9.5}>
        {sites}
      </text>

      {/*
        One <text> with two <tspan>s rather than two elements at computed x
        positions. Guessing where a number ends from its character count is how
        "2,758" and its unit end up overlapping at one width and drifting apart
        at another; letting the text engine advance the cursor is exact.
      */}
      <text x={57} y={58}>
        {connected ? (
          <>
            <tspan className="fill-[var(--color-ink)]" fontSize={15} fontWeight={600}>
              {s.active.toLocaleString("en-GB")}
            </tspan>
            <tspan className="fill-[var(--color-muted)]" fontSize={10} dx={6}>
              live
            </tspan>
          </>
        ) : (
          <tspan className="fill-[var(--color-faint)]" fontSize={12}>
            refused · nothing collected
          </tspan>
        )}
      </text>

      {/* State in words, because the line style alone is not a label. */}
      <text x={57} y={70} className="fill-[var(--color-muted)]" fontSize={10}>
        {!connected
          ? "adapter written · the portal refuses us"
          : backfilling(s)
            ? "first collected — no market movement yet"
            : s.newLast24h > 0
              ? `+${s.newLast24h} today · +${s.newLast7d} this week`
              : `nothing new today · +${s.newLast7d} this week`}
      </text>

      <title>
        {`${s.name} — ${connected ? `${s.active} live listings` : "not collecting"}`}
      </title>
    </g>
  );
}

/**
 * Is this source's "new" count backfill rather than the market moving?
 *
 * A listing counts as new when WE first see it, which is the only honest
 * definition available — no portal tells us when it was published, bar
 * Superimmo. The consequence is that the day a source is first collected, every
 * one of its listings is "new today", and the screen reads as a market that
 * added two thousand properties overnight.
 *
 * Half the source's live stock arriving inside a day is not a market. It is us
 * catching up, and saying so is worth more than a number that is arithmetically
 * correct and completely misleading.
 */
function backfilling(s: SourceStat): boolean {
  return s.active > 0 && s.newLast24h > s.active * 0.5;
}

/** A flat S-curve. Straight lines through nine sources read as a bar chart. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}
