import Link from "next/link";
import { listProperties, listSourceOptions, featureLabel, COMMUNE_LABELS } from "@/lib/api/queries";
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

type Search = {
  commune?: string;
  source?: string;
  new?: string;
  q?: string;
  page?: string;
};

/** Four across on a wide screen, so a page always ends on a full row. */
const PAGE_SIZE = 48;

export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const newWithinDays = sp.new ? Number(sp.new) : undefined;
  const q = sp.q?.trim() || undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const [{ rows, total, totalListings }, sources] = await Promise.all([
    listProperties({
      communeInsee: sp.commune ? [sp.commune] : undefined,
      source: sp.source,
      q,
      newWithinDays: Number.isFinite(newWithinDays) ? newWithinDays : undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    listSourceOptions(),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const merged = totalListings - total;

  /**
   * Every filter keeps the others.
   *
   * The chips used to be plain links to `/listings?commune=X`, so choosing a
   * commune silently threw away the portal filter and the search — the classic
   * way a filter bar teaches people not to trust it. Changing any one of them
   * also returns to page one, because staying on page nine of a result set that
   * now has two pages shows an empty screen, and an empty screen in this
   * product reads as "no market here".
   */
  const href = (changes: Partial<Search>): string => {
    const next = new URLSearchParams();
    const merged_: Search = { ...sp, ...changes, page: undefined };
    for (const [k, v] of Object.entries(merged_)) {
      if (v !== undefined && v !== "") next.set(k, String(v));
    }
    const qs = next.toString();
    return qs ? `/listings?${qs}` : "/listings";
  };

  /**
   * Where the cards point back to.
   *
   * Carried on the card link rather than worked out on the other side: the
   * detail page cannot know which page of which filter you were reading, and
   * guessing from the Referer header breaks the moment somebody opens a card in
   * a new tab. Passed explicitly, "← Listings" returns to the exact screen —
   * page nine of Ramatuelle with a search still in the box.
   */
  const fromQuery = (() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v !== undefined && v !== "") params.set(k, String(v));
    }
    const qs = params.toString();
    return qs ? `?from=${encodeURIComponent(qs)}` : "";
  })();

  const pageHref = (n: number): string => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v !== undefined && v !== "" && k !== "page") next.set(k, String(v));
    }
    if (n > 1) next.set("page", String(n));
    const qs = next.toString();
    return qs ? `/listings?${qs}` : "/listings";
  };

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
              <div className="tnum mt-0.5">deduplicated from {totalListings} portal entries</div>
            )}
            {total > PAGE_SIZE && (
              <div className="tnum mt-0.5 text-[var(--color-faint)]">
                showing {from}–{to}
              </div>
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

      {/*
        A plain GET form. No client component, no debounce, no state to get out
        of step with the URL — the address bar IS the state, so a filtered
        search can be pasted into a message and opens the same screen.
      */}
      <form method="GET" action="/listings" className="mb-4 flex flex-wrap items-center gap-2">
        {(["commune", "source", "new"] as const).map((k) =>
          sp[k] ? <input key={k} type="hidden" name={k} value={sp[k]} /> : null,
        )}
        <div className="relative flex-1 sm:max-w-md">
          <input
            type="search"
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search title, description, agency or ref…"
            className="w-full rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2 pr-20 text-[12px] outline-none placeholder:text-[var(--color-faint)] focus:border-[var(--color-faint)]"
          />
          <button
            type="submit"
            className="absolute right-1 top-1 rounded-full bg-[var(--color-ink)] px-3 py-1 text-[11px] font-medium text-[var(--color-canvas)]"
          >
            Search
          </button>
        </div>
        {q && (
          <Link
            href={href({ q: undefined })}
            className="text-[11px] text-[var(--color-muted)] underline underline-offset-4 hover:text-[var(--color-ink)]"
          >
            clear “{q}”
          </Link>
        )}
      </form>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
          Seen
        </span>
        <Filter href={href({ new: undefined })} active={!sp.new} label="Any time" />
        <Filter href={href({ new: "7" })} active={sp.new === "7"} label="Last 7 days" />
        <Filter href={href({ new: "30" })} active={sp.new === "30"} label="Last 30 days" />

        <span className="mx-2 h-4 w-px bg-[var(--color-line)]" />

        <span className="mr-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
          Portal
        </span>
        <Filter href={href({ source: undefined })} active={!sp.source} label="All portals" />
        {sources.map((s) => (
          <Filter
            key={s.key}
            href={href({ source: s.key })}
            active={sp.source === s.key}
            label={`${s.name} · ${s.properties}`}
          />
        ))}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
          Commune
        </span>
        <Filter href={href({ commune: undefined })} active={!sp.commune} label="All" />
        {Object.entries(COMMUNE_LABELS).map(([insee, label]) => (
          <Filter
            key={insee}
            href={href({ commune: insee })}
            active={sp.commune === insee}
            label={label}
          />
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty
          title="Nothing here yet"
          detail={
            q
              ? `Nothing matches “${q}”. The descriptions are in French — an English ` +
                `word will not find them. Try the agency name, the mandate reference, ` +
                `or a French term like “piscine” or “vue mer”.`
              : sp.source
              ? `No properties from this portal under the current filters. Portals cover ` +
                `different communes, so a portal filter and a commune filter together ` +
                `often describe somewhere nobody has crawled yet.`
              : sp.commune
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
                href={`/listings/${r.id}${fromQuery}`}
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

              <Link href={`/listings/${r.id}${fromQuery}`} className="block p-4">
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
                {byPortal(r.portals).map((p) => (
                  <a
                    key={p.source}
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent-soft)] hover:text-[var(--color-accent-soft)]"
                    title={
                      p.count > 1
                        ? `${p.count} listings on this portal were merged into this property — open one`
                        : undefined
                    }
                  >
                    {p.source}
                    {p.count > 1 && ` ×${p.count}`}
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

      {pages > 1 && (
        <nav className="mt-8 flex flex-wrap items-center justify-center gap-1.5">
          <PageLink href={pageHref(page - 1)} disabled={page === 1} label="← Prev" />
          {pageWindow(page, pages).map((n, i) =>
            n === null ? (
              <span key={`gap-${i}`} className="px-1 text-[11px] text-[var(--color-faint)]">
                …
              </span>
            ) : (
              <PageLink key={n} href={pageHref(n)} label={String(n)} active={n === page} />
            ),
          )}
          <PageLink href={pageHref(page + 1)} disabled={page === pages} label="Next →" />
        </nav>
      )}
    </div>
  );
}

function PageLink({
  href,
  label,
  active,
  disabled,
}: {
  href: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
}) {
  const className =
    "tnum rounded-full border px-3 py-1.5 text-[11px] transition-colors " +
    (active
      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
      : "border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:border-[var(--color-faint)] hover:text-[var(--color-ink)]");

  // A disabled control is rendered as a span, not a dimmed link. A link that
  // looks inactive but still navigates is worse than no link at all.
  if (disabled) {
    return (
      <span className={className + " pointer-events-none opacity-35"} aria-disabled="true">
        {label}
      </span>
    );
  }
  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  );
}

/**
 * First, last, and a window around the current page — `null` marks a gap.
 *
 * Fifty pages of results will not fit as fifty chips, and a bare "Page 7 of 50"
 * makes the end of the list unreachable without seven clicks.
 */
function pageWindow(page: number, pages: number): (number | null)[] {
  const out = new Set<number>([1, pages, page - 1, page, page + 1]);
  const sorted = [...out].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);

  const withGaps: (number | null)[] = [];
  let previous = 0;
  for (const n of sorted) {
    if (previous && n - previous > 1) withGaps.push(null);
    withGaps.push(n);
    previous = n;
  }
  return withGaps;
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

/**
 * One chip per portal, not one per merged listing.
 *
 * These were rendered straight from the listing list, so a property holding
 * twenty-one Green-Acres listings drew twenty-one identical GREEN-ACRES chips
 * and buried the card. The count is kept rather than hidden: two portals
 * carrying the same villa is the product working, while one portal carrying it
 * twenty-one times is a deduplication fault, and a card that quietly collapsed
 * both to a single tidy chip would hide exactly the failure worth seeing.
 */
function byPortal(
  portals: { source: string; url: string }[],
): { source: string; url: string; count: number }[] {
  const out = new Map<string, { source: string; url: string; count: number }>();
  for (const p of portals) {
    const seen = out.get(p.source);
    if (seen) seen.count += 1;
    else out.set(p.source, { source: p.source, url: p.url, count: 1 });
  }
  return [...out.values()];
}
