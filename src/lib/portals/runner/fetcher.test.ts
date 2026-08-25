import { test } from "node:test";
import assert from "node:assert/strict";
import { createFetcher, detectBlock, BlockedError } from "./fetcher";

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
