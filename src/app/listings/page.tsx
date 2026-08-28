import Link from "next/link";
import { listProperties, featureLabel, COMMUNE_LABELS } from "@/lib/api/queries";
import { PageTitle, Empty, Warnings, money, m2, ago } from "@/components/ui";

/**
 * Listings — what is on the market, deduplicated, as cards.
 *
 * A server component reading the database directly. The API routes exist for
 * whatever Med-Estates eventually puts in front of this; the screen has no
 * reason to go over HTTP to its own process.
 *
 * THE UNIT IS THE PROPERTY, NOT THE LISTING.
 *
 * One villa on four portals is ONE card with a "× 4 portals" badge. Showing it
 * four times is the fastest way to make the product look broken to somebody who
 * knows this market — and the badge is the pitch, because a pile of raw portal
 * exports is exactly what an agent already has and exactly what wastes their
 * morning.
 */

export const dynamic = "force-dynamic";

type Search = { commune?: string; source?: string; new?: string };

export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const newWithinDays = sp.new ? Number(sp.new) : undefined;

  const { rows, total } = await listProperties({
    communeInsee: sp.commune ? [sp.commune] : undefined,
    source: sp.source,
    newWithinDays: Number.isFinite(newWithinDays) ? newWithinDays : undefined,
    limit: 120,
  });

  const listingCount = rows.reduce((n, r) => n + Math.max(r.portals.length, 1), 0);
  const merged = listingCount - rows.length;

  return (
    <div>
      <PageTitle
        eyebrow="Market"
        title={sp.new ? "New listings" : "Listings"}
        subtitle="Pulled from every monitored portal, deduplicated and matched to your scope"
        aside={
          <div className="text-right text-xs text-[var(--color-muted)]">
            <div className="tnum text-[var(--color-ink)]">{total} unique properties</div>
            {merged > 0 && (
              <div className="tnum mt-0.5">deduplicated from {listingCount} portal entries</div>
            )}
          </div>
        }
      />

      <Warnings
        items={[
          "Days on market count from OUR first sighting, not the portal's publication " +
            "date, except on Superimmo. Anything listed before we started watching " +
            "looks newer than it is.",
        ]}
      />

      <div className="mb-6 flex flex-wrap gap-1.5">
        <Filter href="/listings" active={!sp.commune && !sp.new} label="All" />
        <Filter href="/listings?new=7" active={sp.new === "7"} label="Last 7 days" />
        <Filter href="/listings?new=30" active={sp.new === "30"} label="Last 30 days" />
        <span className="mx-1 w-px bg-[var(--color-line)]" />
        {Object.entries(COMMUNE_LABELS).map(([insee, label]) => (
          <Filter
            key={insee}
            href={`/listings?commune=${insee}`}
            active={sp.commune === insee}
            label={label}
          />
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty
          title="Nothing here yet"
          detail={
            sp.commune
              ? `No stock collected for ${COMMUNE_LABELS[sp.commune] ?? sp.commune}. That almost ` +
                `certainly means this commune has not been crawled yet rather than that the ` +
                `market is empty — Reports shows which sources have actually run.`
              : "No properties collected yet. Run a collection first."
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((r) => (
            <article
              key={r.id}
              className="group overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-accent)]/50"
            >
              {/*
                The photograph opens the property, like the rest of the card.
                It is the biggest target on screen and the obvious thing to
                click; leaving it inert while the text beside it navigated was
                the kind of small wrongness that makes a page feel broken.
              */}
              <Link
                href={`/listings/${r.id}`}
                className="relative block aspect-[4/3] overflow-hidden"
                aria-label={r.headline}
              >
                {r.imageUrl ? (
                  /**
                   * A plain <img>, hotlinked from the portal.
                   *
                   * Not next/image: that proxies and caches every file through
                   * our own server, which turns displaying an agency's
                   * photograph into storing and redistributing it. A direct link
                   * is what `og:image` is published for, and a withdrawn
                   * property's picture then disappears on their schedule rather
                   * than lingering on ours.
                   */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.imageUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                ) : (
                  <div className="no-photo flex h-full w-full items-center justify-center">
                    <span className="text-[11px] uppercase tracking-widest text-[var(--color-faint)]">
                      no photo
                    </span>
                  </div>
                )}

                {r.sourceCount > 1 && (
                  <span
                    className="absolute left-2.5 top-2.5 rounded-md bg-black/70 px-2 py-1 text-[10px] font-medium text-white backdrop-blur"
                    title="The same property found on more than one portal and merged into this one card"
                  >
                    × {r.sourceCount} portals
                  </span>
                )}
                {r.daysOnMarket !== null && (
                  <span className="absolute right-2.5 top-2.5 rounded-md bg-black/70 px-2 py-1 text-[10px] text-white backdrop-blur">
                    {ago(r.daysOnMarket)}
                  </span>
                )}
              </Link>

              <Link href={`/listings/${r.id}`} className="block p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="tnum display text-[22px] leading-none">
                    {money(r.priceEur)}
                  </span>
                  {r.priceEur !== null && r.areaM2 ? (
                    <span className="tnum text-[11px] text-[var(--color-muted)]">
                      {new Intl.NumberFormat("fr-FR").format(
                        Math.round(r.priceEur / r.areaM2),
                      )}{" "}
                      €/m²
                    </span>
                  ) : (
                    r.priceEur === null && (
                      // "Price on request" is information — the agency chose not
                      // to publish. A bare dash would read as a parser failure.
                      <span className="text-[11px] italic text-[var(--color-muted)]">
                        on request
                      </span>
                    )
                  )}
                </div>

                <h3 className="mt-2 line-clamp-2 text-[13px] font-medium leading-snug">
                  {r.headline}
                </h3>

                <div className="mt-1 text-[11px] text-[var(--color-muted)]">
                  {r.communeLabel ?? "—"}
                  {r.agencyName && ` · ${r.agencyName}`}
                </div>

                <div className="tnum mt-2 text-[11px] text-[var(--color-muted)]">
                  {[
                    r.bedrooms !== null && `${r.bedrooms} bd`,
                    r.rooms !== null && `${r.rooms} rooms`,
                    r.areaM2 !== null && m2(r.areaM2),
                    r.landM2 !== null && `${m2(r.landM2)} land`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "no details published"}
                </div>

                {r.features.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {r.features.map((f) => (
                      <span
                        key={f}
                        className="rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]"
                        title="Found in the listing text — a hint, not a verified fact"
                      >
                        {featureLabel(f)}
                      </span>
                    ))}
                  </div>
                )}

              </Link>

              {/*
                The portal links sit OUTSIDE the card's own link. Nesting an <a>
                inside a <Link> is invalid HTML and the browser resolves it by
                dropping one of them — usually the one you wanted.
              */}
              <div className="mx-4 mb-4 flex flex-wrap items-center gap-1.5 border-t border-[var(--color-line-soft)] pt-3">
                {r.portals.map((p) => (
                  <a
                    key={p.url}
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent-soft)] hover:text-[var(--color-accent-soft)]"
                  >
                    {p.source}
                  </a>
                ))}
                {r.agencyRef && (
                  <span className="ml-auto text-[10px] text-[var(--color-faint)]">
                    ref {r.agencyRef}
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Filter({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={
        "rounded-full border px-3 py-1.5 text-[11px] transition-colors " +
        (active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
          : "border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:border-[var(--color-faint)] hover:text-[var(--color-ink)]")
      }
    >
      {label}
    </Link>
  );
}
