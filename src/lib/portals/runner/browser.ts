import type { PoliteFetch } from "../types";
import { BlockedError, FetchFailedError, detectBlock } from "./fetcher";

/**
 * Fetching through a real browser.
 *
 * Several of these portals refuse a plain HTTP client on every path — index
 * pages, sitemaps, gzipped shards — while serving the same URLs to a browser.
 * The difference is not headers; we tried. It is the TLS handshake and the
 * absence of a JavaScript runtime, and neither is something a fetch client can
 * change honestly.
 *
 * WHEN THIS IS LEGITIMATE, AND WHEN IT IS NOT
 *
 * Enabled per source, never globally, and only where the portal has agreed in
 * writing that we may collect. On those sites the block is automation
 * contradicting its owner's own decision, and reading with a browser is reading
 * what they said we could read.
 *
 * Where there is no agreement, this stays off. `portal_sources.permission_note`
 * must say who agreed and when before `fetchMode: "browser"` goes near a source.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * No stealth plugins, no patching `navigator.webdriver`, no canvas or WebGL
 * fingerprint spoofing. If a plain browser is detected and refused, that is the
 * site saying no a second time, and the answer is another conversation — not a
 * better disguise. Every one of those techniques exists to defeat a control the
 * site chose to deploy, and using them would turn a permitted collection into
 * an unwelcome one.
 */

type Browser = {
  newContext(opts: Record<string, unknown>): Promise<BrowserContext>;
  close(): Promise<void>;
};
type BrowserContext = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
};
type Page = {
  goto(url: string, opts: Record<string, unknown>): Promise<Response_ | null>;
  content(): Promise<string>;
  close(): Promise<void>;
};
type Response_ = { status(): number };

export type BrowserFetcherOptions = {
  delayMs: number;
  userAgent?: string;
  /**
   * Headers the portal asked us to send on every request — see the long note on
   * `FetcherOptions.extraHeaders`. Set at the context level so that Playwright
   * attaches them to sub-resource requests too, not only to `page.goto`.
   */
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  /**
   * 'domcontentloaded' rather than 'networkidle'.
   *
   * These pages never go idle — analytics, ad slots and chat widgets keep
   * chattering long after the content is there. Waiting for silence means
   * waiting for the timeout on every page, which at a thousand pages is hours
   * of nothing.
   */
  waitUntil?: "domcontentloaded" | "load";
};

export type BrowserSession = {
  fetch: PoliteFetch;
  close: () => Promise<void>;
};

/**
 * One browser for a whole run, one page per request.
 *
 * Launching Chromium costs a second or two and a few hundred megabytes; doing
 * it per URL would dominate the run. Pages are closed individually because a
 * long-lived page accumulates listeners and memory until the process dies
 * somewhere unhelpful.
 */
export async function createBrowserSession(
  opts: BrowserFetcherOptions,
): Promise<BrowserSession> {
  const { delayMs, timeoutMs = 30_000, waitUntil = "domcontentloaded" } = opts;

  let chromium: { launch(o: Record<string, unknown>): Promise<Browser> };
  try {
    /**
     * Imported lazily, and by a name TypeScript will not try to resolve at
     * build time. Most sources never need a browser, and Playwright is a heavy
     * dependency to load into a process that is only going to fetch XML — but
     * more practically, the project has to typecheck and deploy on machines
     * where it is not installed at all.
     */
    const mod = (await import(/* webpackIgnore: true */ "playwright" as string)) as {
      chromium: { launch(o: Record<string, unknown>): Promise<Browser> };
    };
    chromium = mod.chromium;
  } catch {
    throw new Error(
      "Browser mode needs Playwright. Install it with `npm i -D playwright` and " +
        "`npx playwright install chromium`, or set this source back to fetchMode: 'http'.",
    );
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    /**
     * Identify ourselves in the user-agent — unless a portal has asked us in
     * writing not to, and given us another header to be identified by instead.
     *
     * A client that says who it is can be allowlisted, contacted, or asked to
     * slow down. One that cannot be picked out of ordinary traffic at all
     * cannot — and that is the part that would make this evasion rather than
     * access. LuxuryEstate is the one source where the identifier moved out of
     * the user-agent and into `X-Collector` at their own request; see its
     * `permission_note`. Everywhere else the user-agent still names us.
     */
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
    ...(opts.extraHeaders && Object.keys(opts.extraHeaders).length > 0
      ? { extraHTTPHeaders: opts.extraHeaders }
      : {}),
  });

  let nextAllowedAt = 0;

  const fetch: PoliteFetch = async (url: string) => {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAllowedAt = Date.now() + delayMs;

    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil, timeout: timeoutMs });
      const status = response?.status() ?? 0;

      if (status === 403 || status === 429) throw new BlockedError(url, `HTTP ${status}`);
      if (status === 404 || status === 410) {
        throw new FetchFailedError(url, status, `not found (${status})`);
      }
      if (status >= 400) {
        throw new FetchFailedError(url, status, `unexpected status ${status}`);
      }

      const html = await page.content();

      // Same check as the HTTP path: a rendered challenge page returns 200 and
      // parses to nothing, which reaches the diff as "this commune is empty".
      const signal = detectBlock(html);
      if (signal) throw new BlockedError(url, signal);

      return html;
    } finally {
      await page.close();
    }
  };

  return {
    fetch,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
