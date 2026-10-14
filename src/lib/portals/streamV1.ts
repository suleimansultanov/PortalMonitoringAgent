import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Stream.Estate V1 (api.stream.estate), behind a meter.
 *
 * WHY THIS FILE EXISTS. V1 is billed per ITEM, in writing from Thomas at
 * Stream.Estate (2026-10-05): every result returned is one item, the same
 * property returned again is another, and only a count request
 * (`itemsPerPage=0`) is free. The client's plan is Starter: 15 000 items a
 * month, then EUR 0.003 each on his card. The gulf's history is far larger —
 * 75 458+ sale properties counted on 2026-10-13 with four communes at the
 * 10 000-per-query ceiling — so a loop that pages "until it ends" spends the
 * month in minutes and then keeps spending.
 *
 * Every request to V1 therefore goes through `call`, and `call` enforces five
 * things that no caller can switch off by forgetting:
 *
 *  1. A LEDGER, in a store. Items received are appended after every response
 *     and before the next request, so a crash cannot lose count. On the Mac
 *     the store is a file; on the nightly runner it is a table, because the
 *     runner's disk is gone by morning and the month's count must not be.
 *  2. A CAP. A paid request is refused BEFORE it is sent if the period's
 *     total plus the page it asks for would pass the cap. The default cap is
 *     below the plan's 15 000; passing the plan's size needs `allowOverage`.
 *  3. A CACHE, where the store has one. A paid response is kept under a name
 *     derived from the query; the same question again reads it and sends
 *     nothing. Re-running, resuming and analysing are free.
 *  4. NO RETRY of a paid request. A request that failed in transit may still
 *     have been served and billed; it is counted at the worst case and the
 *     run stops, for a person to look.
 *  5. A FREE REQUEST THAT RETURNS ITEMS IS A FAULT. If `itemsPerPage=0` ever
 *     comes back with members, they are counted and the run stops at once —
 *     at most one page lost, instead of 260 "free" counts that were not.
 *
 * The ledger is ours, not theirs. Reconciled 2026-10-14: one page of La Môle,
 * 27 items here, and their dashboard is the figure to check it against.
 */

export const V1_BASE = "https://api.stream.estate";
/** Their maximum page size. */
export const V1_PAGE = 30;
/** Starter, per month. */
export const V1_PLAN_ITEMS = 15_000;
/** Left unspent by default: room for a mistake that is not this file's. */
export const V1_DEFAULT_RESERVE = 1_000;
/** The client's plan renews on the 14th (2026-10-14 → 2026-11-13). */
export const V1_DEFAULT_ANCHOR_DAY = 14;

export type LedgerEntry = {
  at: Date;
  /** Count request (free) or a page (paid). */
  paid: boolean;
  /** The query, canonical. Never the key. */
  query: string;
  /** Items believed billed by this request, worst case included. */
  items: number;
  /** Counted without proof: a paid request that failed in transit. */
  uncertain: boolean;
  note?: string;
};

export type Totals = { items: number; uncertain: number; paidRequests: number; freeRequests: number };

/** Where the ledger lives. The meter does not care which. */
export type LedgerStore = {
  totals(since: Date): Promise<Totals>;
  append(entry: LedgerEntry): Promise<void>;
  /** A paid response by its canonical query, where the store keeps them. */
  getCached?(key: string): Promise<string | null>;
  putCached?(key: string, body: string): Promise<void>;
};

export class BudgetError extends Error {}
export class BillingFault extends Error {}

export type V1Response = {
  total: number;
  items: Record<string, unknown>[];
  /** True when the answer came from the store and nothing was sent. */
  fromCache: boolean;
  /** Items this call added to the ledger. */
  spent: number;
};

export type V1Client = {
  call(query: URLSearchParams): Promise<V1Response>;
  /** The period's totals from the store — the truth, not a copy held here. */
  totals(): Promise<Totals>;
  remaining(): Promise<number>;
  cap: number;
  periodStart: Date;
};

/** The query, canonical: the same question in any parameter order is one cache entry. */
export function canonical(query: URLSearchParams): string {
  return [...query.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
}

const cacheKey = (query: URLSearchParams) => createHash("sha1").update(canonical(query)).digest("hex");

/**
 * The start of the billing period `now` falls in: the most recent `anchorDay`
 * of a month, at midnight UTC. On the 13th of November with the 14th as
 * anchor, that is the 14th of October.
 */
export function periodStart(now: Date, anchorDay = V1_DEFAULT_ANCHOR_DAY): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonth = new Date(Date.UTC(y, m, anchorDay));
  return now >= thisMonth ? thisMonth : new Date(Date.UTC(y, m - 1, anchorDay));
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The file store: `ledger.jsonl`, one entry a line, appended; paid responses
 * under `responses/`. For the Mac. An older `ledger.json` (one object, a
 * capped log) is converted on first use and kept beside it.
 */
export function diskLedgerStore(dir: string): LedgerStore {
  const file = path.join(dir, "ledger.jsonl");

  const convertLegacy = () => {
    const legacy = path.join(dir, "ledger.json");
    if (fs.existsSync(file) || !fs.existsSync(legacy)) return;
    try {
      const j = JSON.parse(fs.readFileSync(legacy, "utf8")) as { log?: { at: string; query: string; items: number; note?: string }[] };
      const lines = (j.log ?? []).map((e) =>
        JSON.stringify({
          at: e.at,
          paid: !/(^|&)itemsPerPage=0(&|$)/.test(e.query),
          query: e.query,
          items: e.items,
          uncertain: /worst case/i.test(e.note ?? ""),
          ...(e.note ? { note: e.note } : {}),
        }),
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
      fs.renameSync(legacy, path.join(dir, "ledger-legacy.json"));
    } catch {
      // unreadable: left where it is, and the new ledger starts empty — said in the next run's totals
    }
  };

  const entries = (): LedgerEntry[] => {
    convertLegacy();
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Omit<LedgerEntry, "at"> & { at: string })
      .map((e) => ({ ...e, at: new Date(e.at) }));
  };

  return {
    async totals(since) {
      const t: Totals = { items: 0, uncertain: 0, paidRequests: 0, freeRequests: 0 };
      for (const e of entries()) {
        if (e.at < since) continue;
        t.items += e.items;
        if (e.uncertain) t.uncertain += e.items;
        if (e.paid) t.paidRequests += 1;
        else t.freeRequests += 1;
      }
      return t;
    },
    async append(entry) {
      convertLegacy();
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ ...entry, at: entry.at.toISOString() })}\n`);
    },
    async getCached(key) {
      const f = path.join(dir, "responses", `${key}.json`);
      return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
    },
    async putCached(key, body) {
      const d = path.join(dir, "responses");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${key}.json`), body);
    },
  };
}

/**
 * A store's ledger with a cache on disk beside it: the database counts what
 * every process spends, the Mac keeps what it paid for. For the CLI tools.
 */
export function withDiskCache(store: LedgerStore, dir: string): LedgerStore {
  const disk = diskLedgerStore(dir);
  return { totals: (s) => store.totals(s), append: (e) => store.append(e), getCached: disk.getCached, putCached: disk.putCached };
}

// ─────────────────────────────────────────────────────────────────────────────

export function createV1Client(opts: {
  store: LedgerStore;
  apiKey: () => string;
  /** Items the period may reach. Defaults to the plan minus the reserve. */
  cap?: number;
  /** Required to set a cap above the plan: the items beyond it are charged to the client's card. */
  allowOverage?: boolean;
  /** Day of the month the plan renews on. */
  anchorDay?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): V1Client {
  const now = opts.now ?? (() => new Date());
  const doFetch = opts.fetchImpl ?? fetch;
  const cap = opts.cap ?? V1_PLAN_ITEMS - V1_DEFAULT_RESERVE;
  if (cap > V1_PLAN_ITEMS && !opts.allowOverage) {
    throw new BudgetError(
      `a cap of ${cap} is above the plan's ${V1_PLAN_ITEMS} items: everything past it is billed to the client's card. ` +
        `Say so explicitly (--allow-overage) or lower the cap.`,
    );
  }
  const since = periodStart(now(), opts.anchorDay);
  const store = opts.store;

  const record = (paid: boolean, query: URLSearchParams, items: number, uncertain = false, note?: string) =>
    store.append({ at: now(), paid, query: canonical(query), items, uncertain, ...(note ? { note } : {}) });

  return {
    cap,
    periodStart: since,
    totals: () => store.totals(since),
    remaining: async () => Math.max(0, cap - (await store.totals(since)).items),

    async call(query: URLSearchParams): Promise<V1Response> {
      const perPageRaw = query.get("itemsPerPage");
      if (perPageRaw === null) {
        // Their default is 10. A request that does not say what it asks for is not sent.
        throw new BudgetError("itemsPerPage is not set — every V1 request must state how many items it asks for");
      }
      const perPage = Number(perPageRaw);
      if (!Number.isInteger(perPage) || perPage < 0 || perPage > V1_PAGE) {
        throw new BudgetError(`itemsPerPage=${perPageRaw} is not a whole number between 0 and ${V1_PAGE}`);
      }
      const paid = perPage > 0;
      const key = cacheKey(query);

      if (paid && store.getCached) {
        const cached = await store.getCached(key);
        if (cached) {
          try {
            const j = JSON.parse(cached) as Record<string, unknown>;
            if (Array.isArray(j["hydra:member"])) {
              return { total: Number(j["hydra:totalItems"] ?? 0), items: j["hydra:member"] as Record<string, unknown>[], fromCache: true, spent: 0 };
            }
          } catch {
            // An unreadable file is not an answer; fall through and ask — within the cap.
          }
        }
      }

      // Read from the store, not from memory: another process may have spent since this one started.
      if (paid) {
        const t = await store.totals(since);
        if (t.items + perPage > cap) {
          throw new BudgetError(
            `refused before sending: ${t.items} items counted since ${since.toISOString().slice(0, 10)}, ` +
              `this page asks for up to ${perPage}, and the cap is ${cap}`,
          );
        }
      }

      let res: Response;
      let text: string;
      try {
        res = await doFetch(`${V1_BASE}/documents/properties?${query.toString()}`, {
          headers: { "X-API-KEY": opts.apiKey(), Accept: "application/ld+json" },
        });
        text = await res.text();
      } catch (err) {
        if (paid) {
          await record(true, query, perPage, true, `failed in transit — counted at the worst case: ${(err as Error).message}`);
          throw new BillingFault(
            `a paid request failed in transit and may have been billed; ${perPage} items counted at the worst case. ` +
              `Not retried — check their dashboard before running again. (${(err as Error).message})`,
          );
        }
        throw err;
      }

      if (!res.ok) {
        // Refused requests return no items. Recorded, not counted, and not retried.
        await record(paid, query, 0, false, `HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      let j: Record<string, unknown>;
      try {
        j = JSON.parse(text) as Record<string, unknown>;
      } catch {
        if (paid) {
          await record(true, query, perPage, true, "200 with a body that is not JSON — counted at the worst case");
          throw new BillingFault(`a paid request answered 200 with a body we cannot read; ${perPage} items counted at the worst case`);
        }
        throw new Error("a count request answered with a body that is not JSON");
      }
      const items = Array.isArray(j["hydra:member"]) ? (j["hydra:member"] as Record<string, unknown>[]) : [];
      const total = Number(j["hydra:totalItems"] ?? 0);

      if (!paid) {
        if (items.length > 0) {
          await record(false, query, items.length, false, "A COUNT REQUEST RETURNED ITEMS");
          throw new BillingFault(
            `itemsPerPage=0 came back with ${items.length} items — count requests are not free the way we were told. ` +
              `Counted, and stopping before any more are sent.`,
          );
        }
        await record(false, query, 0);
        return { total, items, fromCache: false, spent: 0 };
      }

      // Kept before it is interpreted, so what we paid for is on disk whatever happens next.
      if (store.putCached) await store.putCached(key, text);
      await record(true, query, items.length);
      return { total, items, fromCache: false, spent: items.length };
    },
  };
}
