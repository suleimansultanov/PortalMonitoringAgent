import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { collectOneSource, schedulePortalCollection } from "@/inngest/functions/collectPortals";

/**
 * A collection pass walks a whole portal at one request per second, so it runs
 * far longer than a normal request. Node runtime, not edge, and the longest
 * duration the platform allows.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [schedulePortalCollection, collectOneSource],
});
