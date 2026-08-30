import { test } from "node:test";
import assert from "node:assert/strict";
import { createFetcher, detectBlock, BlockedError, RateLimitedError } from "./fetcher";

test("recognises the interstitial Superimmo actually served us", () => {
  assert.ok(detectBlock("<html><body>Veuillez valider. Prouvez que vous êtes un humain</body></html>"));
});

test("recognises a Cloudflare wait page", () => {
  assert.ok(detectBlock("<html>Checking your browser before accessing</html>"));
});

test("a real listing page is not mistaken for a block", () => {
  assert.equal(detectBlock("<html><h1>Villa 320 m²</h1><p>9 500 000 €</p></html>"), null);
});

test("the word captcha in a footer does not take a working source offline", () => {
  const page = "<html>" + "<p>villa</p>".repeat(600) + "<footer>captcha policy</footer></html>";
  assert.equal(detectBlock(page), null);
});

test("the crawl delay is honoured between requests but not before the first", async () => {
  let clock = 0;
  const slept: number[] = [];
  const fetcher = createFetcher({
    delayMs: 1000,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    doFetch: (async () => new Response("<html>ok</html>", { status: 200 })) as typeof fetch,
  });

  await fetcher("https://example.test/1");
  await fetcher("https://example.test/2");
  await fetcher("https://example.test/3");

  assert.deepEqual(slept, [1000, 1000]);
});

test("403 throws immediately — retrying is how a warning becomes a ban", async () => {
  let attempts = 0;
  const fetcher = createFetcher({
    delayMs: 0,
    now: () => 0,
    sleep: async () => {},
    doFetch: (async () => {
      attempts++;
      return new Response("nope", { status: 403 });
    }) as typeof fetch,
  });

  await assert.rejects(() => fetcher("https://example.test/a"), BlockedError);
  assert.equal(attempts, 1);
});

test("a 5xx is retried — that one is their problem, probably temporary", async () => {
  let attempts = 0;
  const fetcher = createFetcher({
    delayMs: 0,
    attempts: 3,
    now: () => 0,
    sleep: async () => {},
    doFetch: (async () => {
      attempts++;
      return new Response("boom", { status: 503 });
    }) as typeof fetch,
  });

  await assert.rejects(() => fetcher("https://example.test/b"));
  assert.equal(attempts, 3);
});

test("429 is waited out and retried — it means slow down, not go away", async () => {
  let attempts = 0;
  const slept: number[] = [];
  const fetcher = createFetcher({
    delayMs: 0,
    attempts: 3,
    now: () => 0,
    sleep: async (ms) => {
      slept.push(ms);
    },
    doFetch: (async () => {
      attempts++;
      // Rate-limited twice, then served.
      if (attempts <= 2) return new Response("slow down", { status: 429 });
      return new Response("<html>ok</html>", { status: 200 });
    }) as typeof fetch,
  });

  const body = await fetcher("https://example.test/a");
  assert.match(body, /ok/);
  assert.equal(attempts, 3);
  assert.ok(slept.length >= 2, "it waited between attempts");
});

test("Retry-After is honoured when the server states it", async () => {
  const slept: number[] = [];
  let attempts = 0;
  const fetcher = createFetcher({
    delayMs: 0,
    attempts: 2,
    now: () => 0,
    sleep: async (ms) => {
      slept.push(ms);
    },
    doFetch: (async () => {
      attempts++;
      if (attempts === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "7" } });
      }
      return new Response("<html>ok</html>", { status: 200 });
    }) as typeof fetch,
  });

  await fetcher("https://example.test/b");
  assert.ok(slept.includes(7000), `expected a 7s wait, got ${slept.join(",")}`);
});

test("persistent 429 is rate limiting, NOT a block", async () => {
  /**
   * The distinction that decides whether a whole pass survives.
   *
   * Conflating these cost a real run: 60 listings discovered, ONE ingested,
   * because a single stubborn URL threw BlockedError and the runner stopped
   * everything queued behind it. A 429 must fail the listing and let the pass
   * continue.
   */
  const fetcher = createFetcher({
    delayMs: 0,
    attempts: 2,
    now: () => 0,
    sleep: async () => {},
    doFetch: (async () => new Response("no", { status: 429 })) as typeof fetch,
  });

  await assert.rejects(() => fetcher("https://example.test/c"), RateLimitedError);
  // And specifically not the thing that stops a pass.
  await fetcher("https://example.test/c").catch((err) => {
    assert.ok(!(err instanceof BlockedError));
    assert.match((err as Error).message, /rate limited/i);
  });
});

test("a 429 slows every request that follows, not just the one that hit it", async () => {
  /**
   * A 429 is about our overall rate. Retrying the one page while asking for the
   * next at the old speed just earns another 429 — so the pacing ratchets up
   * and stays up for the rest of the run.
   */
  let clock = 0;
  const slept: number[] = [];
  let calls = 0;
  const fetcher = createFetcher({
    delayMs: 1_000,
    attempts: 3,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    doFetch: (async () => {
      calls++;
      // One 429 on the first request, everything after is fine.
      if (calls === 1) return new Response("slow", { status: 429, headers: { "retry-after": "30" } });
      return new Response("<html>ok</html>", { status: 200 });
    }) as typeof fetch,
  });

  await fetcher("https://example.test/1");
  slept.length = 0;
  await fetcher("https://example.test/2");

  // The gap before the second request reflects the new pacing, not the
  // original one-second crawl delay.
  assert.ok(
    slept.some((ms) => ms > 1_000),
    `expected pacing above the original 1s, saw ${slept.join(",")}`,
  );
});

test("a 200 carrying a CAPTCHA throws rather than returning an empty page", async () => {
  const fetcher = createFetcher({
    delayMs: 0,
    now: () => 0,
    sleep: async () => {},
    doFetch: (async () =>
      new Response("<html>Prouvez que vous êtes un humain</html>", { status: 200 })) as typeof fetch,
  });

  // Returning the body here would reach the diff as "this commune is empty".
  await assert.rejects(() => fetcher("https://example.test/c"), BlockedError);
});

test("a portal's agreed header rides on every request, beside its user-agent", async () => {
  /**
   * LuxuryEstate refuses any user-agent that is not a browser's, and their
   * technical operations team answered by asking for a browser string plus an
   * `X-Collector` header they can filter on. That header is the entire reason
   * the browser string is acceptable there: with it they can still pick our
   * traffic out and throttle it; without it we would be indistinguishable from
   * visitors, which is the thing this project does not do.
   *
   * So the two travel together. A regression that dropped the header while
   * keeping the user-agent would turn an agreed configuration into exactly the
   * evasion it was built to avoid — silently, and while continuing to work.
   */
  const seen: Record<string, string>[] = [];
  const fetcher = createFetcher({
    delayMs: 0,
    now: () => 0,
    sleep: async () => {},
    userAgent: "Mozilla/5.0 (Macintosh) Chrome/140.0.0.0",
    extraHeaders: { "X-Collector": "PortalMonitoringAgent/1.0 (+https://leadestate.com)" },
    doFetch: (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response("<html>ok</html>", { status: 200 });
    }) as unknown as typeof fetch,
  });

  await fetcher("https://example.test/a");
  await fetcher("https://example.test/b");

  assert.equal(seen.length, 2, "both requests");
  for (const h of seen) {
    assert.equal(h["X-Collector"], "PortalMonitoringAgent/1.0 (+https://leadestate.com)");
    assert.match(h["user-agent"], /Chrome/);
  }
});

test("a source with no agreed headers sends none — the default stays untouched", async () => {
  const seen: Record<string, string>[] = [];
  const fetcher = createFetcher({
    delayMs: 0,
    now: () => 0,
    sleep: async () => {},
    doFetch: (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response("<html>ok</html>", { status: 200 });
    }) as unknown as typeof fetch,
  });

  await fetcher("https://example.test/a");
  assert.equal(seen[0]["X-Collector"], undefined);
  assert.match(seen[0]["user-agent"], /PortalMonitoringAgent/);
});
