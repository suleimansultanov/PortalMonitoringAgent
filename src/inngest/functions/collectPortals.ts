import { inngest } from "../client";
import { getBoolSetting, setSetting, SETTING_KEYS } from "@/lib/settings/store";
import { activeSources, communesForSource, runSource } from "@/lib/portals/runner/run";
import { resolveCommuneIdentities } from "@/lib/portals/matching/resolve";
import { db } from "@/lib/db/client";
import { portalSources } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Scheduled collection.
 *
 * Two functions rather than one: a scheduler that decides WHICH sources to
 * collect, and a worker that collects ONE. The split is what allows the
 * concurrency limit below to be keyed per source — thirteen portals progress
 * in parallel while no single portal ever sees two of our requests at once.
 */

/**
 * NO CRON HERE. THE SCHEDULE LIVES IN GITHUB ACTIONS.
 *
 * `.github/workflows/collect.yml` owns the daily run, because a full crawl
 * takes tens of minutes at one request per second and serverless functions are
 * capped at five.
 *
 * These functions remain for triggering a collection by hand — from an admin
 * screen, or in response to something else happening. Adding a cron trigger
 * back would mean two schedules pointing at the same portals, and we would be
 * crawling twice nightly without anyone noticing until a portal complained.
 */
export const schedulePortalCollection = inngest.createFunction(
  {
    id: "portals/schedule-collection",
    name: "Portals — manual dispatch",
    concurrency: 1,
    retries: 1,
  },
  [{ event: "portals/collect-requested" }],
  async ({ event, step }) => {
    // Opt-in. This reaches out to third parties and writes to their logs, so it
    // stays dormant until someone switches it on.
    const enabled = await step.run("check-enabled", () =>
      getBoolSetting(SETTING_KEYS.COLLECTION_ENABLED, false),
    );
    if (!enabled) return { status: "disabled" as const };

    // A direct request names its source; the cron walks all enabled ones.
    const requested = (event as { data?: { sourceKey?: string } }).data?.sourceKey;

    const sources = await step.run("list-sources", async () => {
      if (requested) return [{ key: requested }];
      return (await activeSources()).map((s) => ({ key: s.key }));
    });

    if (sources.length === 0) return { status: "no-sources" as const };

    await step.sendEvent(
      "dispatch",
      sources.map((s) => ({
        name: "portals/collect-source" as const,
        data: { sourceKey: s.key },
      })),
    );

    await step.run("record", () =>
      setSetting(SETTING_KEYS.LAST_COLLECTION_AT, new Date().toISOString()),
    );

    return { status: "dispatched" as const, sources: sources.map((s) => s.key) };
  },
);

export const collectOneSource = inngest.createFunction(
  {
    id: "portals/collect-source",
    name: "Portals — collect one source",
    /**
     * One pass per source at a time. Two concurrent passes over the same portal
     * would not corrupt anything — the diff and the unique index both hold —
     * but they would double our request rate at a site that granted permission
     * on the understanding we would be reasonable.
     */
    concurrency: { limit: 1, key: "event.data.sourceKey" },
    /**
     * NOT retried. A pass that failed halfway has already stored what it
     * fetched; re-running it re-fetches pages we hold and re-approaches a
     * portal that may have just told us to stop. The next scheduled pass picks
     * up whatever was missed, because the diff is computed fresh each time.
     */
    retries: 0,
    timeouts: { finish: "2h" },
  },
  { event: "portals/collect-source" },
  async ({ event, step }) => {
    const { sourceKey } = event.data;

    const communes = await step.run("resolve-communes", async () => {
      const [source] = await db
        .select({ id: portalSources.id })
        .from(portalSources)
        .where(eq(portalSources.key, sourceKey))
        .limit(1);
      if (!source) return [];
      return communesForSource(source.id);
    });

    if (communes.length === 0) {
      // No client subscribes to this source, so there is nothing to collect
      // for. Not an error — sources are enabled before clients attach to them.
      return { status: "no-subscribers" as const, sourceKey };
    }

    /**
     * Wrapped in step.run, and it must be.
     *
     * Inngest re-invokes the handler and replays completed steps from stored
     * state. Code OUTSIDE a step runs again on every pass — so an unwrapped
     * collection would start a second crawl of the same portal partway through
     * the first. That exact mistake cost two duplicate runs in the sibling
     * project before it was found.
     */
    const summary = await step.run("collect", () =>
      runSource({ sourceKey, communeInsee: communes, mode: "scheduled" }),
    );

    /**
     * Re-cluster the communes this pass touched.
     *
     * Deliberately after collection rather than during it: a new listing can
     * reveal that two properties we had as separate are one, because the portal
     * that arrived third is often the one carrying the mandate reference tying
     * the first two together. Resolving incrementally per listing would miss
     * that and leave the split in place until something else happened to
     * disturb it.
     *
     * Skipped when the pass aborted — clustering a half-collected commune
     * produces splits that then have to be undone.
     */
    if (summary.status === "done") {
      await step.run("resolve-identities", async () => {
        const results = [];
        for (const insee of communes) {
          results.push(await resolveCommuneIdentities(insee));
        }
        return results;
      });
    }

    return { sourceKey, ...summary };
  },
);
