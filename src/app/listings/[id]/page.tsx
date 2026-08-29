import Link from "next/link";
import { notFound } from "next/navigation";
import { propertyDetail, featureLabel } from "@/lib/api/queries";
import { Card, Warnings, money, m2, ago } from "@/components/ui";
import { Gallery } from "@/components/Gallery";

/**
 * One property, everything we know about it.
 *
 * The reason this screen exists is the two things a portal cannot show you:
 *
 *   1. What the OTHER portals say about the same villa. A portal shows a price;
 *      we can show that two portals disagree about it — which is either a stale
 *      listing or an agency quietly testing a number, and both are worth an
 *      agent's attention.
 *
 *   2. What has happened to it over time. Price cuts, disappearing, coming back.
 *      That history is the whole argument for monitoring rather than searching.
 *
 * Everything on this page is observed, and where it is inferred it says so.
 */

export const dynamic = "force-dynamic";

/**
 * The filters the listings screen understands. Anything else in `from` is
 * dropped.
 *
 * A whitelist rather than a sanitiser, because `from` arrives in the URL and
 * anyone can put anything in it. Rebuilding the query from known keys means the
 * back link can only ever point at our own listings screen — no scheme, no
 * host, no path, nothing to smuggle a redirect through.
 */
const CARRIED_FILTERS = ["commune", "source", "new", "q", "page"] as const;

function backHref(from: string | undefined): string {
  if (!from) return "/listings";

  const incoming = new URLSearchParams(from);
  const safe = new URLSearchParams();
  for (const key of CARRIED_FILTERS) {
    const value = incoming.get(key);
    if (value) safe.set(key, value);
  }

  const qs = safe.toString();
  return qs ? `/listings?${qs}` : "/listings";
}

export default async function PropertyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const detail = await propertyDetail(id);
  if (!detail) notFound();

  const back = backHref(from);

  const { property: p, listings, events, agency, description } = detail;

  // Do the portals agree on the price? A disagreement is a finding, not noise.
  const prices = listings.map((l) => l.priceEur).filter((x): x is number => x !== null);
  const spread =
    prices.length > 1 ? Math.max(...prices) - Math.min(...prices) : 0;

  const warnings: string[] = [];
  if (spread > 0) {
    warnings.push(
      `Portals disagree on the price by ${money(spread)}. Usually one is stale, ` +
        `occasionally the agency is testing a different number in different places. ` +
        `Check the per-portal figures below before quoting either.`,
    );
  }
  const published = listings.find((l) => l.publishedAt)?.publishedAt ?? null;
  if (!published) {
    warnings.push(
      `No portal here publishes a listing date, so "days on market" counts from ` +
        `our first sighting and is a floor, not a measurement.`,
    );
  }

  return (
    <div>
      <Link
        href={back}
        className="mb-5 inline-block text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
      >
        ← {back === "/listings" ? "Listings" : "Back to results"}
      </Link>

      {/*
        `minmax(0, …)` on both columns, and `min-w-0` on the contents.

        A grid item defaults to `min-width: auto`, which means it refuses to be
        narrower than its content — and the thumbnail strip is twenty 80px
        images in a row. `overflow-x-auto` does not help: the column had already
        blown out to 1600px, swallowing the gutter and pushing the whole sidebar
        off the right of the screen.

        This is the standard flex/grid overflow trap, and it is worth naming
        because the symptom (an empty black gutter, a missing sidebar) points
        nowhere near the cause (a scrollable strip four blocks away).
      */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
        {/* ── Left: the property itself ─────────────────────────────── */}
        <div className="min-w-0 space-y-6">
          <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
            <div className="group relative">
              {/*
                `imageUrl` first, then the gallery. The cover is whatever the
                portal chose for og:image, which is usually the shot the agency
                considers the best one — worth keeping in front even when the
                gallery has its own ordering.
              */}
              <Gallery
                images={[...new Set([p.imageUrl, ...p.imageUrls].filter((x): x is string => !!x))]}
                alt={p.headline}
              />
              {p.sourceCount > 1 && (
                <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
                  × {p.sourceCount} portals
                </span>
              )}
              {p.status !== "active" && (
                <span className="pointer-events-none absolute right-3 top-3 rounded-md bg-[var(--color-down)] px-2.5 py-1 text-[11px] font-medium text-white">
                  delisted
                </span>
              )}
            </div>

            <div className="p-6">
              <div className="flex items-baseline justify-between gap-4">
                <span className="tnum display text-[34px] leading-none">
                  {p.priceEur === null ? "Price on request" : money(p.priceEur)}
                </span>
                {p.priceEur !== null && p.areaM2 && (
                  <span className="tnum text-sm text-[var(--color-muted)]">
                    {new Intl.NumberFormat("fr-FR").format(Math.round(p.priceEur / p.areaM2))} €/m²
                  </span>
                )}
              </div>

              <h1 className="mt-3 text-[17px] font-medium leading-snug">{p.headline}</h1>
              <div className="mt-1.5 text-sm text-[var(--color-muted)]">
                {p.communeLabel ?? "—"}
                {p.propertyType && ` · ${p.propertyType}`}
                {p.agencyRef && ` · mandate ${p.agencyRef}`}
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-[var(--color-line-soft)] pt-5 sm:grid-cols-4">
                <Field label="Bedrooms" value={p.bedrooms} />
                <Field label="Rooms" value={p.rooms} />
                <Field label="Floor area" value={p.areaM2 === null ? null : m2(p.areaM2)} />
                <Field label="Land" value={p.landM2 === null ? null : m2(p.landM2)} />
              </dl>

              {p.features.length > 0 && (
                <div className="mt-5 flex flex-wrap gap-1.5">
                  {p.features.map((f) => (
                    <span
                      key={f}
                      className="rounded border border-[var(--color-line)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]"
                      title="Found in the listing text — a hint, not a verified fact"
                    >
                      {featureLabel(f)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {warnings.length > 0 && <Warnings items={warnings} />}

          {description && (
            <Card title="As the agency describes it">
              <p className="whitespace-pre-line px-5 py-4 text-[13px] leading-relaxed text-[var(--color-ink)]/80">
                {description}
              </p>
            </Card>
          )}

          {/* ── History ─────────────────────────────────────────────── */}
          <Card
            title="History"
            aside={
              <span className="text-[11px] text-[var(--color-muted)]">
                what we have observed, in order
              </span>
            }
          >
            {events.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-[var(--color-muted)]">
                Nothing recorded yet.
              </div>
            ) : (
              <ol className="divide-y divide-[var(--color-line-soft)]">
                {events.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-4 px-5 py-3 text-[13px]">
                    <span className="tnum w-24 shrink-0 text-[11px] text-[var(--color-faint)]">
                      {e.occurredAt.toISOString().slice(0, 10)}
                    </span>
                    <span className="flex-1">{describeEvent(e)}</span>
                    <span className="text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                      {e.source}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        {/* ── Right: where it appears, and who is selling ───────────── */}
        <div className="min-w-0 space-y-6">
          <Card
            title="On these portals"
            aside={
              <span className="text-[11px] text-[var(--color-muted)]">
                {listings.length === 1 ? "one listing" : `${listings.length} listings, merged`}
              </span>
            }
          >
            <div className="divide-y divide-[var(--color-line-soft)]">
              {listings.map((l) => (
                <div key={l.id} className="px-5 py-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] font-medium text-[var(--color-accent-soft)] hover:underline"
                    >
                      {l.sourceName}
                    </a>
                    <span className="tnum text-[13px]">{money(l.priceEur)}</span>
                  </div>

                  <div className="tnum mt-1.5 text-[11px] text-[var(--color-muted)]">
                    {[
                      l.areaM2 !== null && m2(l.areaM2),
                      l.agencyRef && `ref ${l.agencyRef}`,
                      l.status !== "active" && "delisted",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>

                  {/*
                    Publication dates, where the portal actually gives them.
                    Only Superimmo does, and it is the reason that source is
                    worth its very slow crawl.
                  */}
                  {(l.publishedAt || l.sourceUpdatedAt) && (
                    <div className="tnum mt-1 text-[11px] text-[var(--color-muted)]">
                      {l.publishedAt && `published ${l.publishedAt.toISOString().slice(0, 10)}`}
                      {l.sourceUpdatedAt &&
                        ` · updated ${l.sourceUpdatedAt.toISOString().slice(0, 10)}`}
                    </div>
                  )}

                  <div className="tnum mt-1 text-[11px] text-[var(--color-faint)]">
                    first seen {l.firstSeenAt.toISOString().slice(0, 10)} · last seen{" "}
                    {l.lastSeenAt.toISOString().slice(0, 10)}
                  </div>

                  {/*
                    Why we merged it. A dedup that cannot be questioned is a
                    dedup nobody will trust the first time it is wrong.
                  */}
                  {l.matchConfidence !== null && (
                    <div className="mt-2 text-[11px] text-[var(--color-muted)]">
                      merged at {Math.round(l.matchConfidence * 100)}% confidence
                      {signalWords(l.matchSignals).length > 0 && (
                        <> — {signalWords(l.matchSignals).join(", ")}</>
                      )}
                    </div>
                  )}

                  {l.parseStatus !== "ok" && (
                    <div className="mt-2 text-[11px] text-[var(--color-warn)]">
                      parsed as “{l.parseStatus}” — some fields on this portal were not readable
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {agency && (
            <Card title="Agency">
              <div className="px-5 py-4">
                <div className="text-[13px] font-medium">{agency.name}</div>
                {(agency.address || agency.postalCode || agency.city) && (
                  <div className="mt-1 text-[12px] text-[var(--color-muted)]">
                    {[agency.address, [agency.postalCode, agency.city].filter(Boolean).join(" ")]
                      .filter(Boolean)
                      .join(", ")}
                  </div>
                )}
                {agency.phone && (
                  <div className="tnum mt-1 text-[12px] text-[var(--color-muted)]">
                    {agency.phone}
                  </div>
                )}
                <div className="mt-3 border-t border-[var(--color-line-soft)] pt-3 text-[12px] text-[var(--color-muted)]">
                  <span className="tnum text-[var(--color-ink)]">{agency.activeCount}</span> active
                  {agency.activeCount === 1 ? " property" : " properties"} in the communes we watch
                </div>
              </div>
            </Card>
          )}

          <Card title="Timing">
            <dl className="divide-y divide-[var(--color-line-soft)]">
              <Row
                label="First seen by us"
                value={p.firstListedAt ? p.firstListedAt.toISOString().slice(0, 10) : "—"}
              />
              <Row label="On market" value={p.daysOnMarket === null ? "—" : ago(p.daysOnMarket)} />
              <Row
                label="Published by portal"
                value={published ? published.toISOString().slice(0, 10) : "not published"}
              />
              <Row
                label="Last confirmed live"
                value={p.lastSeenAt ? p.lastSeenAt.toISOString().slice(0, 10) : "—"}
              />
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-faint)]">{label}</dt>
      <dd className="tnum mt-1 text-[15px]">{value ?? "—"}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5 text-[12px]">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="tnum">{value}</dd>
    </div>
  );
}

/**
 * An event as a sentence.
 *
 * Deliberately plain: "listed", "cut by €200k", "disappeared from the portal".
 * The last one is phrased as an observation rather than "sold", because a
 * listing vanishes when it sells, when the owner withdraws it, when the
 * agency's subscription lapses and when it moves to a competitor — and we
 * cannot tell which.
 */
function describeEvent(e: {
  type: string;
  priceFrom: number | null;
  priceTo: number | null;
  payload: Record<string, unknown> | null;
}): React.ReactNode {
  switch (e.type) {
    case "listed":
      return (
        <>
          Appeared on the portal
          {e.priceTo !== null && <> at {money(e.priceTo)}</>}
        </>
      );
    case "price_changed": {
      const down = e.priceFrom !== null && e.priceTo !== null && e.priceTo < e.priceFrom;
      const delta =
        e.priceFrom !== null && e.priceTo !== null ? Math.abs(e.priceTo - e.priceFrom) : null;
      return (
        <span className={down ? "text-[var(--color-down)]" : "text-[var(--color-up)]"}>
          Price {down ? "cut" : "raised"} {money(e.priceFrom)} → {money(e.priceTo)}
          {delta !== null && e.priceFrom ? (
            <span className="text-[var(--color-muted)]">
              {" "}
              ({Math.round((delta / e.priceFrom) * 100)}%)
            </span>
          ) : null}
        </span>
      );
    }
    case "delisted":
      return (
        <span title="Could be sold, withdrawn, expired, or moved to another agency — we cannot tell which">
          Disappeared from the portal
          {e.priceFrom !== null && <> (last price {money(e.priceFrom)})</>}
        </span>
      );
    case "relisted":
      return <>Reappeared after being absent</>;
    case "availability_changed":
      return <>Availability changed to {String(e.payload?.to ?? "unknown")}</>;
    default:
      return <>{e.type.replace(/_/g, " ")}</>;
  }
}

/** Turn the stored match signals into words an agent can weigh. */
function signalWords(signals: Record<string, unknown> | null): string[] {
  if (!signals) return [];
  const out: string[] = [];
  if (signals.agencyRefExact) out.push("same mandate reference");
  if (typeof signals.descriptionSimilarity === "number") {
    out.push(`${Math.round(signals.descriptionSimilarity * 100)}% same wording`);
  }
  if (signals.priceEqual) out.push("same price");
  if (signals.areaEqual) out.push("same floor area");
  return out;
}
