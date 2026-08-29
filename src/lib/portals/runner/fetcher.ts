import { gunzipSync } from "node:zlib";
import type { PoliteFetch } from "../types";

/**
 * The only place in this project that touches the network.
 *
 * Adapters are handed one of these rather than reaching for `fetch` themselves.
 * That keeps three things in one place: the crawl delay each portal asked for
 * in its robots.txt, the user-agent that identifies us to the sites that
 * granted permission, and the judgement about whether a response means "no such
 * listing" or "you are being blocked".
 *
 * The third is the one that matters most, and it is why this file exists rather
 * than a two-line wrapper.
 */

/**
 * Plain field assignments rather than TypeScript parameter properties.
 * Parameter properties are not erasable syntax — they emit code — so a runtime
 * that only strips types (`node --experimental-strip-types`) refuses to load
 * the file. Two extra lines buys the ability to run this anywhere.
 */
/**
 * Who we say we are, on every path.
 *
 * One constant because the browser path must introduce itself identically — a
 * client that identifies itself can be allowlisted, contacted or asked to slow
 * down, and two different strings would mean a portal allowlisting one of them
 * and still refusing the other.
 */
export const USER_AGENT =
  "PortalMonitoringAgent/1.0 (+https://leadestate.com; contact@leadestate.com)";

export class BlockedError extends Error {
  url: string;
  signal: string;
  constructor(url: string, signal: string) {
    super(`blocked at ${url} (${signal})`);
    this.name = "BlockedError";
    this.url = url;
    this.signal = signal;
  }
}

/**
 * Persistently rate limited — NOT the same as blocked, and the distinction
 * decides whether a whole pass survives.
 *
 * A 403 or a CAPTCHA is the site refusing us: continuing means hammering
 * somewhere we are not welcome, so the pass stops. A 429 that will not clear is
 * the site saying we are asking too fast *right now*. Treating the second like
 * the first cost a real run: 60 listings discovered, one ingested, because one
 * stubborn URL aborted everything behind it.
 *
 * So this is a FetchFailedError — the listing fails, the pass continues, and
 * the runner slows down for the rest of it.
 */
export class RateLimitedError extends Error {
  url: string;
  attempts: number;
  constructor(url: string, attempts: number) {
    super(`rate limited at ${url} (HTTP 429 after ${attempts} attempts)`);
    this.name = "RateLimitedError";
    this.url = url;
    this.attempts = attempts;
  }
}

export class FetchFailedError extends Error {
  url: string;
  status: number | null;
  constructor(url: string, status: number | null, message: string) {
    super(message);
    this.name = "FetchFailedError";
    this.url = url;
    this.status = status;
  }
}

/**
 * A 200 response is not proof of success.
 *
 * Superimmo serves an interstitial that asks you to prove you are human, with a
 * perfectly ordinary status code. Parsed naively it yields a page with no
 * listings — which reaches the diff as "this commune is empty" and, if it got
 * past the guard, would delist real properties.
 *
 * These markers are checked before anything else looks at the body.
 */
const BLOCK_MARKERS: { pattern: RegExp; signal: string }[] = [
  { pattern: /prouvez que vous [êe]tes un humain/i, signal: "captcha (fr)" },
  { pattern: /prove you are (a )?human/i, signal: "captcha (en)" },
  { pattern: /\bcaptcha\b/i, signal: "captcha keyword" },
  { pattern: /datadome/i, signal: "datadome" },
  { pattern: /cf-browser-verification|checking your browser/i, signal: "cloudflare interstitial" },
  { pattern: /access denied|acc[èe]s refus[ée]/i, signal: "access denied" },
];

/**
 * `Retry-After` in either of its two legal forms: seconds, or an HTTP date.
 * Capped, because a server occasionally answers with an hour and nothing good
 * comes of a crawler sleeping through its own run.
 */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 120_000);

  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - Date.now(), 0), 120_000);
}

export function detectBlock(body: string): string | null {
  // Only inspect the head of the document. Block pages are short; a real
  // listing page can legitimately contain the word "captcha" somewhere in a
  // privacy policy in the footer, and matching that would take a working
  // source offline.
  const head = body.slice(0, 4000);
  for (const { pattern, signal } of BLOCK_MARKERS) {
    if (pattern.test(head)) return signal;
  }
  return null;
}

export type FetcherOptions = {
  /** From `portal_sources.crawl_delay_ms`, which comes from their robots.txt. */
  delayMs: number;
  userAgent?: string;
  /** Retries for transient failures only. Never for 403, 404 or a block. */
  attempts?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  doFetch?: typeof fetch;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ceiling on the adaptive pacing. Past this a source is not worth waiting on. */
const MAX_DELAY_MS = 120_000;

/**
 * Build a fetch that will not exceed one request per `delayMs` for this source.
 *
 * The spacing is held in a closure, so one fetcher per source per process gives
 * per-source serialisation for free. Parallelism between sources comes from
 * running their functions concurrently — never from firing requests at one
 * portal faster.
 */
export function createFetcher(opts: FetcherOptions): PoliteFetch {
  const {
    delayMs,
    /**
     * Identify ourselves properly, with a way to be contacted.
     *
     * A bare token gets refused by ordinary WAF rules, and rightly — an
     * unidentified client hammering a site is indistinguishable from an
     * unwanted one. Naming ourselves is both the polite thing and the practical
     * one: several of these portals let us in on the basis of knowing who we
     * are, and a request they can trace back to that agreement is a request
     * they can choose to allow.
     *
     * Set CRAWLER_USER_AGENT to a real, reachable address. This default is a
     * placeholder, not a value to ship.
     */
    userAgent = process.env.CRAWLER_USER_AGENT ??
      USER_AGENT,
    attempts = 3,
    timeoutMs = 20_000,
    now = () => Date.now(),
    sleep = defaultSleep,
    doFetch = fetch,
  } = opts;

  let nextAllowedAt = 0;
  /**
   * The pacing actually in force, which starts at the portal's stated
   * crawl-delay and only ever increases — see the 429 branch below.
   */
  let currentDelay = delayMs;

  return async function politeFetch(url: string): Promise<string> {
    const wait = nextAllowedAt - now();
    if (wait > 0) await sleep(wait);
    nextAllowedAt = now() + currentDelay;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await doFetch(url, {
          headers: {
            "user-agent": userAgent,
            // The headers any well-formed HTTP client sends. Not a disguise —
            // omitting them makes the request malformed rather than anonymous,
            // and some servers reject on that alone.
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
            "accept-encoding": "gzip, deflate, br",
          },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });

        /**
         * 403 and 429 are not the same message, and treating them alike was
         * wrong.
         *
         * 403 is "you may not have this". Retrying is the wrong answer to being
         * refused — it is what turns a warning into a ban.
         *
         * 429 is "not this fast". The correct answer is to wait and try again,
         * which is literally what the status asks for, and sites often say how
         * long in `Retry-After`. Throwing on it stopped an entire pass over one
         * moment of impatience.
         */
        if (res.status === 403) {
          throw new BlockedError(url, "HTTP 403");
        }
        if (res.status === 429) {
          const wait = retryAfterMs(res) ?? Math.max(delayMs, 5_000) * Math.pow(2, attempt);

          /**
           * Slow down for everything that follows, not just for this URL.
           *
           * A 429 is about our overall rate, so retrying this one page while
           * continuing to ask for the next at the old speed just earns another
           * 429. The delay ratchets up and never back down within a run: the
           * portal has told us its limit and there is no reason to go looking
           * for it again a minute later.
           */
          currentDelay = Math.min(Math.max(currentDelay * 1.5, wait), MAX_DELAY_MS);

          if (attempt === attempts) {
            // Not a refusal — a rate we cannot meet right now. The listing
            // fails; the pass carries on at the slower rate.
            throw new RateLimitedError(url, attempts);
          }
          console.warn(
            `[fetch] 429 at ${url} — waiting ${Math.round(wait / 1000)}s ` +
              `(pacing now ${Math.round(currentDelay / 1000)}s between requests)`,
          );
          await sleep(wait);
          nextAllowedAt = now() + currentDelay;
          continue;
        }
        if (res.status === 404 || res.status === 410) {
          throw new FetchFailedError(url, res.status, `not found (${res.status})`);
        }
        if (res.status >= 500) {
          // Their problem, probably temporary. Worth one more try.
          throw new FetchFailedError(url, res.status, `server error ${res.status}`);
        }
        if (!res.ok) {
          throw new FetchFailedError(url, res.status, `unexpected status ${res.status}`);
        }

        const body = await readBody(res, url);

        const signal = detectBlock(body);
        if (signal) throw new BlockedError(url, signal);

        return body;
      } catch (err) {
        lastErr = err;
        // Being blocked or told the page does not exist is a final answer.
        // Only ambiguous failures get another attempt.
        if (err instanceof BlockedError) throw err;
        if (err instanceof FetchFailedError && err.status !== null && err.status < 500) throw err;
        if (attempt === attempts) break;
        // Back off, and respect the crawl delay while doing it.
        await sleep(Math.max(delayMs, 1000) * attempt);
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new FetchFailedError(url, null, String(lastErr));
  };
}

/**
 * Read the body, transparently ungzipping `.gz` payloads.
 *
 * Sitemaps are routinely served as `.xml.gz` with `Content-Type:
 * application/gzip`, which `fetch` does NOT decompress for you — that only
 * happens for `Content-Encoding: gzip`. Adapters should not have to know the
 * difference, so it is handled once, here.
 */
async function readBody(res: Response, url: string): Promise<string> {
  const isGzip =
    url.endsWith(".gz") ||
    (res.headers.get("content-type") ?? "").includes("gzip");

  if (!isGzip) return res.text();

  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return gunzipSync(buf).toString("utf8");
  } catch {
    // Some servers set a gzip content-type but send plain text. Falling back is
    // cheaper than failing a whole sitemap over a misconfigured header.
    return buf.toString("utf8");
  }
}
