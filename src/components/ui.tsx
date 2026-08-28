/**
 * The few shared pieces the screens need.
 *
 * Deliberately small. A component library is not this project's problem, and
 * the parts that carry meaning — the test-data badge, the caveat block, the
 * empty state that explains itself — deserve more attention than another
 * button variant.
 */

export function PageTitle({
  eyebrow,
  title,
  subtitle,
  aside,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-8">
      <div>
        {eyebrow && (
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-faint)]">
            {eyebrow}
          </div>
        )}
        <h1 className="display text-[32px] leading-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-[var(--color-muted)]">{subtitle}</p>}
      </div>
      {aside && <div className="shrink-0 pt-2">{aside}</div>}
    </div>
  );
}

export function Card({
  title,
  children,
  aside,
}: {
  title?: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
      {title && (
        <header className="flex items-center justify-between border-b border-[var(--color-line-soft)] px-5 py-3.5">
          <h2 className="text-sm font-medium">{title}</h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "accent" | "muted";
}) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-4">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-faint)]">
        {label}
      </div>
      <div
        className="tnum mt-2 text-[28px] font-light leading-none"
        style={{
          color:
            tone === "accent"
              ? "var(--color-accent-soft)"
              : tone === "muted"
                ? "var(--color-muted)"
                : undefined,
        }}
      >
        {value}
      </div>
      {hint && <div className="mt-2 text-xs text-[var(--color-muted)]">{hint}</div>}
    </div>
  );
}

/**
 * The test-data badge.
 *
 * Loud on purpose. The invented buyers exist so the product could be built
 * before the real ones arrived, and the one way that becomes a real problem is
 * a fabricated lead reaching an agent looking genuine. This is the last line of
 * defence after the database flag and the name prefix.
 */
export function TestBadge() {
  return (
    <span className="rounded border border-[var(--color-test)]/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--color-test)]">
      test data
    </span>
  );
}

export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[var(--color-line)] bg-[var(--color-raised)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
      {children}
    </span>
  );
}

/**
 * Caveats, sitting above the numbers they qualify.
 *
 * Each one exists because a figure on the page means something narrower than
 * its label suggests, and none of that is visible from the number itself.
 * Putting them in documentation instead is how an agent ends up telling a
 * client "on the market six days" about a villa listed since March.
 */
export function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-6 rounded-xl border border-[var(--color-warn)]/25 bg-[var(--color-warn)]/[0.06] px-5 py-3.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-warn)]">
        Read before trusting the numbers
      </div>
      <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-[var(--color-ink)]/70">
        {items.map((w, i) => (
          <li key={i}>— {w}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * An empty state that says WHY it is empty.
 *
 * "No results" is the least useful sentence a product can print. Here, empty
 * almost always means a commune has not been crawled yet rather than that the
 * market is quiet — and those call for completely different reactions.
 */
export function Empty({ title, detail }: { title: string; detail?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-6 py-16 text-center">
      <div className="text-sm font-medium">{title}</div>
      {detail && (
        <div className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-[var(--color-muted)]">
          {detail}
        </div>
      )}
    </div>
  );
}

export function money(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `€${m % 1 === 0 ? m.toFixed(0) : m.toFixed(2).replace(/0$/, "")}M`;
  }
  if (n >= 1000) return `€${Math.round(n / 1000)}k`;
  return `€${n}`;
}

export function m2(n: number | null): string {
  return n === null ? "—" : `${new Intl.NumberFormat("fr-FR").format(Math.round(n))} m²`;
}

/** "3d ago", "today" — the badge in the mockup's card corner. */
export function ago(days: number | null): string {
  if (days === null) return "";
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}
