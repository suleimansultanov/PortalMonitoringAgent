import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, withDbRetry } from "@/lib/db/client";
import { AI_MODEL, AI_SCHEMA, AI_SYSTEM, AiAnswer, GENERIC_TITLE, acceptAnswer, advertText, callCost, type Accepted } from "./aiFacts";

/**
 * Read what adverts state in their prose into the fields their pages leave
 * empty — see aiFacts.ts for what may be written and why.
 *
 *   npm run ai:facts -- --estimate                 how many, and roughly what it would cost; no call
 *   npm run ai:facts -- --max-usd=1.5              read them, never spending more than that
 *   npm run ai:facts -- --max-usd=0.05 --limit=20  a small paid check
 *
 * The nightly calls `fillFromText` for what it touched, with a small cap. A
 * listing is read once: its answer is kept in `raw.ai` even when it fills
 * nothing, so the same advert is never paid for twice. Needs ANTHROPIC_API_KEY;
 * without it the step reports itself skipped and nothing else changes.
 *
 * THE CAP IS CHECKED BEFORE EACH CALL, against what has been spent plus a
 * call's worth of headroom, so a run stops at or under it. The balance this was
 * built against was $3.
 */

const HOME_TYPES_ONLY = sql`coalesce(l.property_type, '') not in ('Terrain', 'Parking', 'Commerce', 'Bureau', 'Immeuble')`;
/** Roughly one call, with headroom: measured $0.00027 uncached on 2026-11-10. */
const ONE_CALL_USD = 0.0004;

const Candidate = z.object({
  id: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  property_type: z.string().nullable(),
  area_m2: z.coerce.number().nullable(),
  land_m2: z.coerce.number().nullable(),
  rooms: z.number().nullable(),
  bedrooms: z.number().nullable(),
});
type Candidate = z.infer<typeof Candidate>;

/** Live listings of sources still collected, in a commune, with text worth reading, not read before, with something to find. */
async function candidates(opts: { since?: Date; limit?: number }): Promise<Candidate[]> {
  const since = opts.since ? sql`and (l.first_seen_at >= ${opts.since} or l.updated_at >= ${opts.since})` : sql``;
  const limit = opts.limit ? sql`limit ${opts.limit}` : sql``;
  const res = await withDbRetry(() =>
    db.execute(sql`
      select l.id, l.title, l.description, l.property_type, l.area_m2, l.land_m2, l.rooms, l.bedrooms
      from portal_listings l join portal_sources s on s.id = l.source_id and s.enabled
      where l.status = 'active' and l.commune_insee is not null
        and length(coalesce(l.description, '')) >= 80
        and l.raw -> 'ai' is null
        and ((l.bedrooms is null and ${HOME_TYPES_ONLY})
          or (l.area_m2 is null and coalesce(l.property_type, '') not in ('Terrain', 'Parking'))
          or l.property_type is null
          or l.title ~* ${GENERIC_TITLE.source})
        ${since}
      order by l.first_seen_at desc
      ${limit}`),
  );
  return z.array(Candidate).parse(res.rows);
}

async function write(c: Candidate, accepted: Accepted, record: Record<string, unknown>): Promise<void> {
  await withDbRetry(() =>
    db.execute(sql`
      update portal_listings set
        area_m2 = coalesce(area_m2, ${accepted.areaM2 ?? null}::numeric),
        land_m2 = coalesce(land_m2, ${accepted.landM2 ?? null}::numeric),
        rooms = coalesce(rooms, ${accepted.rooms ?? null}::integer),
        bedrooms = coalesce(bedrooms, ${accepted.bedrooms ?? null}::integer),
        property_type = coalesce(${accepted.propertyType ?? null}::text, property_type),
        price_per_m2 = case
          when price_per_m2 is null and price_eur is not null and ${accepted.areaM2 ?? null}::numeric > 0
          then round(price_eur / ${accepted.areaM2 ?? null}::numeric) else price_per_m2 end,
        raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('ai', ${JSON.stringify(record)}::jsonb),
        updated_at = now()
      where id = ${c.id}::uuid`),
  );
}

export type FillSummary = {
  line: string;
  read: number;
  filled: Record<keyof Accepted, number>;
  spentUsd: number;
  stoppedAtCap: boolean;
  failures: number;
};

export async function fillFromText(opts: { maxUsd: number; limit?: number; since?: Date; concurrency?: number; logFile?: string }): Promise<FillSummary> {
  const filled: Record<keyof Accepted, number> = { bedrooms: 0, areaM2: 0, landM2: 0, rooms: 0, propertyType: 0 };
  const empty = (line: string): FillSummary => ({ line, read: 0, filled, spentUsd: 0, stoppedAtCap: false, failures: 0 });
  // The database first: its client is what loads .env.local, where a local run keeps the key.
  const todo = await candidates({ since: opts.since, limit: opts.limit });
  if (!process.env.ANTHROPIC_API_KEY) return empty("AI facts: skipped — no ANTHROPIC_API_KEY");
  if (todo.length === 0) return empty("AI facts: nothing to read");

  const client = new Anthropic({ maxRetries: 6 });
  const log: unknown[] = [];
  let spent = 0;
  let read = 0;
  let failures = 0;
  let stoppedAtCap = false;
  let next = 0;

  const one = async (c: Candidate) => {
    const res = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: AI_SCHEMA as unknown as Record<string, unknown> } },
      system: [{ type: "text", text: AI_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: advertText(c.title, c.description) }],
    });
    spent += callCost(res.usage);
    if (res.stop_reason === "refusal") throw new Error("refused");
    const text = res.content.find((b) => b.type === "text");
    const answer = AiAnswer.parse(JSON.parse(text && text.type === "text" ? text.text : "null"));
    const { accepted, rejected } = acceptAnswer(
      { title: c.title, description: c.description, propertyType: c.property_type, areaM2: c.area_m2, landM2: c.land_m2, rooms: c.rooms, bedrooms: c.bedrooms },
      answer,
    );
    const quotes = Object.fromEntries(
      (Object.keys(accepted) as (keyof Accepted)[]).map((k) => [k, answer[k === "areaM2" ? "livingAreaM2" : k].quote]),
    );
    await write(c, accepted, {
      model: AI_MODEL,
      at: new Date().toISOString(),
      accepted,
      quotes,
      ...(Object.keys(rejected).length ? { rejected } : {}),
      ...(accepted.propertyType ? { typeBefore: c.property_type } : {}),
    });
    for (const k of Object.keys(accepted) as (keyof Accepted)[]) filled[k]++;
    read++;
    if (opts.logFile) log.push({ id: c.id, title: c.title, accepted, quotes, rejected, usage: res.usage });
  };

  const worker = async () => {
    while (next < todo.length) {
      if (spent + ONE_CALL_USD > opts.maxUsd) {
        stoppedAtCap = true;
        return;
      }
      const c = todo[next++];
      try {
        await one(c);
      } catch (err) {
        failures++;
        if (opts.logFile) log.push({ id: c.id, error: err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : (err as Error).message });
        // A refused key or an empty balance will not get better on the next listing.
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || (err instanceof Anthropic.BadRequestError && /credit|balance/i.test(err.message))) {
          next = todo.length;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker));
  if (opts.logFile) await fs.writeFile(opts.logFile, JSON.stringify(log, null, 1), "utf8");

  const parts = (Object.entries(filled) as [string, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  const line =
    `AI facts: ${read} of ${todo.length} adverts read, filled ${parts.length ? parts.join(", ") : "nothing"}; ` +
    `$${spent.toFixed(3)} spent (cap $${opts.maxUsd})${stoppedAtCap ? " — stopped at the cap" : ""}${failures ? `; ${failures} failed` : ""}`;
  return { line, read, filled, spentUsd: spent, stoppedAtCap, failures };
}

async function main(): Promise<void> {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (process.argv.includes("--estimate")) {
    const all = await candidates({});
    const chars = all.reduce((n, c) => n + (c.title?.length ?? 0) + (c.description?.length ?? 0), 0);
    console.log(`${all.length} adverts to read, ${Math.round(chars / Math.max(1, all.length))} characters each on average; ` +
      `about $${(all.length * 0.00027).toFixed(2)} uncached, less with the instructions cached. Nothing was called.`);
    return;
  }
  const maxUsd = Number(arg("max-usd"));
  if (!(maxUsd > 0)) throw new Error("--max-usd=<dollars> is required: the run never spends past it");
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const stamp = new Date().toISOString().slice(0, 16).replace(":", "");
  const logFile = `logs/ai-facts-${stamp}.json`;
  const s = await fillFromText({ maxUsd, limit, logFile });
  console.log(s.line);
  console.log(`Each answer, with its quotes: ${logFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
