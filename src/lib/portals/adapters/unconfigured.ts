import type { DiscoverContext } from "../types";

/**
 * The communes of this pass an adapter can actually address — and, for every
 * one it cannot, a warning and `ctx.incomplete()`.
 *
 * WHY THIS IS ONE FUNCTION AND NOT ELEVEN LOOPS. The runner's delisting
 * baseline is every commune the pass was ASKED for (`inThisPass` in
 * `runner/run.ts`), not every commune the adapter visited — it cannot know the
 * difference. So a requested INSEE code the adapter has no slug, path, zone or
 * token for is, to the runner, a commune that was walked and found empty, and
 * that night it delists the whole of that commune's stock for the source.
 *
 * The abort guard does not fire: it counts listings, and one commune of twelve
 * is a healthy-looking total. That was the state of seven adapters until
 * 2026-10-15 (review 1.6) — each printed "skipping" and carried on, so taking
 * a commune's slug out of a config "to fix later" would have emptied it
 * overnight while the run reported `done`. Four others (Vizzit, Bien'ici,
 * Zoopla, Figaro Immobilier) called `incomplete()` inline, each in its own
 * words. One function means one pattern to copy for the next adapter, and a
 * registry-wide test (`unconfigured.test.ts`) holds every adapter to it.
 *
 * Reported per commune, as `incomplete()` always is: the unaddressed commune is
 * shielded from delisting and nothing else is. A commune a source permanently
 * cannot address — JamesEdition has no area page for La Môle — is therefore
 * reported incomplete every night, and that is the point: it is what keeps a
 * La Môle listing that reached us through a neighbour's page from being
 * delisted for not being on a page that does not exist.
 *
 * Returns the addressable INSEE codes in the order the pass asked for them.
 */
export function addressableCommunes(
  ctx: Pick<DiscoverContext, "communeInsee" | "incomplete">,
  opts: {
    /** The adapter key, for the log line. */
    source: string;
    /** What the config lacks, in the portal's own terms: "area slug", "Bien'ici zone". */
    what: string;
    /** True when the adapter can build an address for this INSEE code. */
    has: (insee: string) => boolean;
  },
): string[] {
  const addressable: string[] = [];
  for (const insee of ctx.communeInsee) {
    if (opts.has(insee)) {
      addressable.push(insee);
      continue;
    }
    console.warn(
      `[${opts.source}] no ${opts.what} configured for INSEE ${insee} — ` +
        `reported incomplete, so nothing there is delisted`,
    );
    ctx.incomplete(insee, `no ${opts.what} configured for this commune`);
  }
  return addressable;
}
