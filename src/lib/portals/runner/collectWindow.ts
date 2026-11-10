import { z } from "zod";

/**
 * The hours a portal asked us to keep (`config.collectWindow`), e.g. LuxuryEstate's
 * 01:00-05:00 Europe/Paris. Read by the run, which warns outside it, and by the
 * morning retry (`retryRule.ts`), which does not go back to a portal outside them.
 */
export type CollectWindow = { from: number; to: number; tz: string };

const windowSchema = z.object({
  collectWindow: z.object({ from: z.number(), to: z.number(), tz: z.string() }).optional(),
});

export function collectWindowOf(config: unknown): CollectWindow | undefined {
  const parsed = windowSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data.collectWindow : undefined;
}

/** The hour at `at` in the window's time zone, 0-23. */
export function hourIn(window: CollectWindow, at: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: window.tz }).format(at)) % 24;
}

/** A window may cross midnight: { from: 22, to: 4 }. */
export function insideCollectWindow(window: CollectWindow, at: Date): boolean {
  const hour = hourIn(window, at);
  return window.from <= window.to ? hour >= window.from && hour < window.to : hour >= window.from || hour < window.to;
}
