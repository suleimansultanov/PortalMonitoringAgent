import { EventSchemas, Inngest } from "inngest";

type Events = {
  /** Collect one source now. Omit communes to use every subscriber's union. */
  "portals/collect-requested": {
    data: {
      sourceKey: string;
      communeInsee?: string[];
      mode?: "manual" | "backfill";
      limit?: number;
    };
  };
  /** Fan-out from the daily cron, one per enabled source. */
  "portals/collect-source": {
    data: { sourceKey: string };
  };
};

export const inngest = new Inngest({
  id: "portal-monitoring-agent",
  schemas: new EventSchemas().fromRecord<Events>(),
});
