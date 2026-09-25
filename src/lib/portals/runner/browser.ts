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
  waitForSelector(selector: string, opts: Record<string, unknown>): Promise<unknown>;
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
  /**
   * Show the window instead of running headless. Off everywhere by default.
   *
   * NOT A DISGUISE, and the distinction is the whole reason this is a separate
   * flag rather than a change to the default. The user-agent still names us,
   * `navigator.webdriver` is still true, nothing is patched — a site can pick
   * this traffic out and refuse it exactly as before. The only thing that
   * changes is whether Chromium draws to a screen.
   *
   * It exists because one variable behind SMC's Cloudflare block has never been
   * measured. Their challenge refuses the collector from a datacentre address
   * and from the operator's own home address alike, which rules out the address
   * and rules out our identity as the trigger. Whether it keys on headless
   * signals is the remaining question, and this answers it in one run.
   *
   * WHERE THIS STOPS. If the page comes back as a challenge that wants a click,
   * that is the answer and the run ends there. Solving it, waiting it out, or
   * dressing the browser up as a person is the thing this project does not do —
   * see the note at the top of this file, and LuxuryEstate's permission_note,
   * which we hold precisely because we can be identified and refused.
   */
  headless?: boolean;
  /**
   * Route this session's traffic through a proxy. Added 2026-09-24 for the
   * two portals that refuse datacentre address ranges wholesale.
   *
   * WHAT THIS CHANGES AND WHAT IT DOES NOT. It changes the address the request
   * leaves from. Nothing else: the user-agent still names us, the headers a
   * portal asked for are still sent, `navigator.webdriver` is still true. Both
   * portals this is for — Figaro and JamesEdition — serve this exact code from
   * a home connection (607 and 581 pages, zero failures, 16 Sep) and refuse it
   * from GitHub's ranges. So what they filter is the class of address, not us,
   * and an address of the class they serve is a route to the front door, not
   * a way around it.
   *
   * WHERE IT MUST NOT BE USED, and `run.ts` does not stop you, so read this:
   * on any portal that has refused our identity. SMC challenges every address
   * including a normal browser; SeLoger returns 403 to a browser carrying our
   * name. Changing the address there would be asking again after being told
   * no — that is circumvention, and the answer to those two is a letter.
   *
   * Credentials come from the environment, never from `portal_sources.config`
   * — see `proxyEnv` in run.ts. Only the host is ever logged.
   */
  proxy?: { server: string; username?: string; password?: string };
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
  /**
   * A selector that only exists once the listing itself has rendered.
   *
   * `domcontentloaded` fires when the document is parsed, which on a page that
   * builds its content from script is BEFORE the content exists. The page is
   * then saved, and it looks like a listing that lost its data rather than
   * like a page we photographed too early — same 200, same size order, no
   * error anywhere.
   *
   * Measured on SMC, 2026-08-30: six of 372 pages came back at 16-21 kB of
   * text against a median of 35 kB, with the property's own details missing
   * and the site's menus intact. Their `<title>` still named the property, so
   * the listings existed; we simply had not waited.
   *
   * Optional, and deliberately forgiving — a page that never shows it is still
   * returned, because some listings genuinely lack the block and refusing them
   * would trade a small loss for a larger one. The parser decides.
   */
  readySelector?: string;
  /** How long to wait for `readySelector` before giving up on it. */
  readyTimeoutMs?: number;
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
  const {
    delayMs,
    timeoutMs = 30_000,
    waitUntil = "domcontentloaded",
    readySelector,
    readyTimeoutMs = 5_000,
  } = opts;

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

  const browser = await chromium.launch({
    headless: opts.headless !== false,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });
  if (opts.proxy) {
    // Host only. The username on a residential proxy often encodes the plan,
    // the session and the country; none of that belongs in a run log.
    console.log(`[browser] egress via proxy ${proxyHost(opts.proxy.server)}`);
  }
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

      if (status === 403 || status === 429) {
        /**
         * Read what the refusal says before throwing it away.
         *
         * The browser path discarded the body of every 403 exactly as the HTTP
         * path did, and cost us the same day of guessing on SMC. Protection
         * vendors name themselves; "DataDome" and "their own rule" want
         * different answers. Wrapped, because a diagnostic that throws turns a
         * bad night into a worse one.
         */
        let detail = "";
        try {
          const shown = (await page.content())
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          /**
           * The Ray ID first, because it is the one part of a Cloudflare block
           * page that is worth anything to anybody. The site owner can paste it
           * into their own dashboard and see exactly which rule fired on which
           * request — which turns "your site blocks us" into a question they
           * can answer in a minute. The prose around it is the same on every
           * blocked request in the world.
           */
          const ray = shown.match(/Ray ID:\s*([0-9a-f]+)/i)?.[1];
          if (ray) detail = ` — Cloudflare block, Ray ID ${ray}`;
          else if (shown) detail = ` — page said: ${shown.slice(0, 200)}`;
        } catch {
          // Nothing to add. The status is the fact.
        }
        throw new BlockedError(url, `HTTP ${status}${detail}`);
      }
      if (status === 404 || status === 410) {
        throw new FetchFailedError(url, status, `not found (${status})`);
      }
      if (status >= 400) {
        throw new FetchFailedError(url, status, `unexpected status ${status}`);
      }

      /**
       * Wait for the content, not just for the document.
       *
       * Swallowing the timeout is the point: this improves the odds, it does
       * not guarantee the block is there. A page that never renders it is
       * returned anyway and fails in the parser, where the reason is visible,
       * rather than being dropped here where it would not be.
       */
      if (readySelector) {
        await page
          .waitForSelector(readySelector, { timeout: readyTimeoutMs })
          .catch(() => undefined);
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

/** The host of a proxy URL, for logging. Never the credentials. */
export function proxyHost(server: string): string {
  try {
    return new URL(server.includes("://") ? server : `http://${server}`).host;
  } catch {
    return "<unparseable proxy url>";
  }
}

/**
 * Split a proxy URL into what Playwright's `launch({ proxy })` wants.
 *
 * `http://user:pass@host:port` → `{ server: "http://host:port", username,
 * password }`. Providers hand out exactly that form, and keeping it as one
 * environment variable means one secret to rotate rather than three.
 */
export function parseProxyUrl(raw: string): { server: string; username?: string; password?: string } {
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  if (!url.hostname) throw new Error("proxy url has no host");
  const server = `${url.protocol}//${url.host}`;
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  return { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
}
