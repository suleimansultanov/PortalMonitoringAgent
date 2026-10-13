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
 * 66 070 not-expired sale properties counted on 2026-09-25 with three
 * communes at the 10 000-per-query ceiling — so a loop that pages "until it
 * ends" spends the month in minutes and then keeps spending.
 *
 * Every request to V1 therefore goes through `call`, and `call` enforces five
 * things that no caller can switch off by forgetting:
 *
 *  1. A LEDGER on disk. Items received are added after every response and the
 *     file is rewritten before the next request, so a crash cannot lose count.
 *  2. A CAP. A paid request is refused BEFORE it is sent if the ledger plus
 *     the page it asks for would pass the cap. The default cap is below the
 *     plan's 15 000; passing the plan's size needs `allowOverage`.
 *  3. A CACHE. A paid response is written to disk under a name derived from
 *     the query; asking the same question again reads the file and sends
 *     nothing. Re-running, resuming and analysing are free.
 *  4. NO RETRY of a paid request. A request that failed in transit may still
 *     have been served and billed; it is counted at the worst case and the
 *     run stops, for a person to look.
 *  5. A FREE REQUEST THAT RETURNS ITEMS IS A FAULT. If `itemsPerPage=0` ever
 *     comes back with members, they are counted and the run stops at once —
 *     at most one page lost, instead of 260 "free" counts that were not.
 *
 * The ledger is ours, not theirs. Reconcile it against their dashboard after
 * the first paid page: 30 here must be 30 there.
 */

export const V1_BASE = "https://api.stream.estate";
/** Their maximum page size. */
export const V1_PAGE = 30;
/** Starter, per month. */
export const V1_PLAN_ITEMS = 15_000;
/** Left unspent by default: room for a mistake that is not this file's. */
export const V1_DEFAULT_RESERVE = 1_000;

export type Ledger = {
  /** When this count began. Reset it when the plan renews (the 13th). */
  since: string;
  /** Items we believe were billed, worst case included. */
  items: number;
  /** Paid requests sent. */
  paidRequests: number;
  /** Free (count) requests sent. */
  freeRequests: number;
  /** Items counted without proof: a paid request that failed in transit. */
  uncertain: number;
  /** The last entries, newest last: what was asked and what it cost. */
  log: { at: string; query: string; items: number; note?: string }[];
};

export class BudgetError extends Error {}
export class BillingFault extends Error {}

export type V1Response = {
  total: number;
  items: Record<string, unknown>[];
  /** True when the answer came from disk and nothing was sent. */
  fromCache: boolean;
  /** Items this call added to the ledger. */
  spent: number;
};

export type V1Client = {
  call(query: URLSearchParams): Promise<V1Response>;
  ledger(): Ledger;
  cap: number;
  remaining(): number;
};

/** The query, canonical: the same question in any parameter order is one cache entry. */
export function canonical(query: URLSearchParams): string {
  return [...query.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
}

export function cacheFile(dir: string, query: URLSearchParams): string {
  return path.join(dir, "responses", `${createHash("sha1").update(canonical(query)).digest("hex")}.json`);
}

function emptyLedger(now: Date): Ledger {
  return { since: now.toISOString(), items: 0, paidRequests: 0, freeRequests: 0, uncertain: 0, log: [] };
}

export function readLedger(dir: string, now = new Date()): Ledger {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8")) as Ledger;
  } catch {
    return emptyLedger(now);
  }
}

function writeLedger(dir: string, ledger: Ledger): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ledger.json");
  // Written whole and renamed: a crash mid-write must not leave half a count.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...ledger, log: ledger.log.slice(-400) }, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

export function createV1Client(opts: {
  /** Where the ledger and the responses live. */
  dir: string;
  apiKey: () => string;
  /** Items the ledger may reach. Defaults to the plan minus the reserve. */
  cap?: number;
  /** Required to set a cap above the plan: the items beyond it are charged to the client's card. */
  allowOverage?: boolean;
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
  let ledger = readLedger(opts.dir, now());

  const record = (query: URLSearchParams, items: number, note?: string) => {
    ledger.items += items;
    ledger.log.push({ at: now().toISOString(), query: canonical(query), items, ...(note ? { note } : {}) });
    writeLedger(opts.dir, ledger);
  };

  return {
    cap,
    ledger: () => ledger,
    remaining: () => Math.max(0, cap - ledger.items),

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
      const file = cacheFile(opts.dir, query);

      if (paid && fs.existsSync(file)) {
        try {
          const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
          if (Array.isArray(j["hydra:member"])) {
            return {
              total: Number(j["hydra:totalItems"] ?? 0),
              items: j["hydra:member"] as Record<string, unknown>[],
              fromCache: true,
              spent: 0,
            };
          }
        } catch {
          // An unreadable file is not an answer; fall through and ask — within the cap.
        }
      }

      // Re-read before spending: another run may have spent since this one started.
      ledger = readLedger(opts.dir, now());
      if (paid && ledger.items + perPage > cap) {
        throw new BudgetError(
          `refused before sending: ${ledger.items} items counted since ${ledger.since.slice(0, 10)}, ` +
            `this page asks for up to ${perPage}, and the cap is ${cap}`,
        );
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
          ledger.paidRequests += 1;
          ledger.uncertain += perPage;
          record(query, perPage, `failed in transit — counted at the worst case: ${(err as Error).message}`);
          throw new BillingFault(
            `a paid request failed in transit and may have been billed; ${perPage} items counted at the worst case. ` +
              `Not retried — check their dashboard before running again. (${(err as Error).message})`,
          );
        }
        throw err;
      }

      if (paid) ledger.paidRequests += 1;
      else ledger.freeRequests += 1;

      if (!res.ok) {
        // Refused requests return no items. Recorded, not counted, and not retried.
        record(query, 0, `HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      let j: Record<string, unknown>;
      try {
        j = JSON.parse(text) as Record<string, unknown>;
      } catch {
        if (paid) {
          ledger.uncertain += perPage;
          record(query, perPage, "200 with a body that is not JSON — counted at the worst case");
          throw new BillingFault(`a paid request answered 200 with a body we cannot read; ${perPage} items counted at the worst case`);
        }
        throw new Error("a count request answered with a body that is not JSON");
      }
      const items = Array.isArray(j["hydra:member"]) ? (j["hydra:member"] as Record<string, unknown>[]) : [];
      const total = Number(j["hydra:totalItems"] ?? 0);

      if (!paid) {
        if (items.length > 0) {
          record(query, items.length, "A COUNT REQUEST RETURNED ITEMS");
          throw new BillingFault(
            `itemsPerPage=0 came back with ${items.length} items — count requests are not free the way we were told. ` +
              `Counted, and stopping before any more are sent.`,
          );
        }
        record(query, 0);
        return { total, items, fromCache: false, spent: 0 };
      }

      // Stored before it is interpreted, so what we paid for is on disk whatever happens next.
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      record(query, items.length);
      return { total, items, fromCache: false, spent: items.length };
    },
  };
}
