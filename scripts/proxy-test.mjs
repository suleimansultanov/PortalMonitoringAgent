#!/usr/bin/env node
/**
 * Does a residential proxy get our collector served? A small, metered answer.
 *
 *   node scripts/proxy-test.mjs                       # four portals, 3 listings each, 30 MB cap
 *   node scripts/proxy-test.mjs --listings=5 --budget-mb=20 --portals=figaro
 *
 * Needs PMA_RESIDENTIAL_PROXY (http://user:pass@host:port) and, ideally,
 * CRAWLER_USER_AGENT. Without the proxy it refuses to run: going out direct
 * would answer a different question and spend nothing useful.
 *
 * THE ORDER, AND WHY THE LAST TWO ARE DIAGNOSTIC ONLY. Figaro and JamesEdition
 * come first: they serve this exact collector from a home connection (607 and
 * 581 pages, 16 Sep) and refuse datacentre ranges, so the address is the whole
 * difference and a residential one is a fair test. SMC and Superimmo follow,
 * run once at the operator's request (2026-10-04) to measure, not to adopt:
 *   - SMC challenges every address, a normal Chrome at home included. Expected
 *     answer: the same challenge. If so, the letter stays the only route.
 *   - Superimmo is not Cloudflare at all: its own server answers 429 at any
 *     spacing, from home too. A fresh address may well be served — which
 *     would show a rate limit, not a way in. Putting the nightly through new
 *     addresses against it is still what this project does not do (CLAUDE.md,
 *     runner/browser.ts `proxy`); that would be a separate decision.
 *
 * WHAT IT DOES NOT DO: no stealth. Our own user-agent, headless, nothing
 * patched. A challenge page is recorded and the portal is stopped there — it
 * is never solved or waited out.
 *
 * WHY IT IS METERED. Trial plans are ~100 MB. A listing page with everything
 * it pulls in is 2–5 MB (measured 2026-10-04); the HTML we parse is ~3 % of
 * that. So only the portal's own documents are loaded — no images, fonts,
 * scripts, styles or third-party calls — and every byte that does cross is
 * counted, with a margin for TLS and proxy overhead the browser cannot see.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : "true"];
  }),
);
const LISTINGS = Math.max(0, Number(args.listings ?? 3));
const BUDGET_BYTES = Math.max(1, Number(args["budget-mb"] ?? 30)) * 1024 * 1024;
const OUT = path.resolve(args.out ?? "proxy-test-pages");
/** What the browser can count is HTTP. TLS records and the proxy CONNECT are on top. */
const OVERHEAD = 1.2;

const UA =
  process.env.CRAWLER_USER_AGENT?.trim() ||
  process.env.COLLECTOR_USER_AGENT?.trim() ||
  "PortalMonitoringAgent/1.0 (+https://leadestate.com; suleiman@leadestate.com)";

const PORTALS = {
  figaro: {
    host: "proprietes.lefigaro.fr",
    delayMs: 5_000, // their row in seed.ts
    index:
      "https://proprietes.lefigaro.fr/annonces/immobilier-var-provence+alpes+cote+d+azur-france/?ville=st+tropez",
    listingLinks: (html) =>
      [...html.matchAll(/(?:https:\/\/proprietes\.lefigaro\.fr)?(\/annonces\/[^/?#"\s]+\/\d{5,}\/)/g)].map(
        (m) => `https://proprietes.lefigaro.fr${m[1]}`,
      ),
    /** Their listing state ships in the page; without it the page is not one we can read. */
    looksServed: (html) => html.includes("__NUXT_DATA__"),
  },
  jamesedition: {
    host: "www.jamesedition.com",
    delayMs: 4_000,
    index: "https://www.jamesedition.com/real_estate/saint-tropez-france?order=recent",
    listingLinks: (html) =>
      [...html.matchAll(/href="(\/real_estate\/[a-z0-9-]+\/[a-z0-9-]+-\d{6,})"/gi)].map(
        (m) => `https://www.jamesedition.com${m[1]}`,
      ),
    looksServed: (html) => /application\/ld\+json/.test(html) && /real_estate/.test(html),
  },
  smc: {
    host: "www.maisonsetappartements.fr",
    delayMs: 10_000,
    /**
     * No index: their search pages refuse us outright, and discovery goes
     * through a sitemap that is far too large for this budget. The home page
     * stands in for it, then four listings that were live on 30 Aug — a 404
     * still tells us whether the challenge sits in front of it.
     */
    index: "https://www.maisonsetappartements.fr/",
    listingLinks: () => [
      "https://www.maisonsetappartements.fr/fr/83/annonce-vente-maison-les-issambres-4161332.html",
      "https://www.maisonsetappartements.fr/fr/83/annonce-vente-maison-les-issambres-4444814.html",
      "https://www.maisonsetappartements.fr/fr/83/annonce-vente-maison-les-issambres-4345866.html",
      "https://www.maisonsetappartements.fr/fr/83/annonce-vente-appartement-le-plan-de-la-tour-4420716.html",
    ],
    looksServed: (html) => /description-ann|application\/ld\+json/.test(html) && html.length > 20_000,
  },
  superimmo: {
    host: "www.superimmo.com",
    delayMs: 10_000,
    index: "https://www.superimmo.com/achat/provence-alpes-cote-d-azur/var/saint-tropez-83990?sort=created_at",
    listingLinks: (html) =>
      [...html.matchAll(/href="((?:https:\/\/www\.superimmo\.com)?\/annonces\/achat-[a-z0-9-]+)"/gi)].map((m) =>
        m[1].startsWith("http") ? m[1] : `https://www.superimmo.com${m[1]}`,
      ),
    looksServed: (html) => /\/annonces\/achat-|€/.test(html) && html.length > 20_000,
  },
};

const wanted = (args.portals ?? "figaro,jamesedition,smc,superimmo").split(",").map((s) => s.trim()).filter(Boolean);
for (const k of wanted) {
  if (!PORTALS[k]) {
    console.error(`"${k}" is not tested here. Only: ${Object.keys(PORTALS).join(", ")}.`);
    process.exit(2);
  }
}

const raw = process.env.PMA_RESIDENTIAL_PROXY?.trim();
if (!raw) {
  console.error("PMA_RESIDENTIAL_PROXY is not set. This test only makes sense through the proxy; refusing to go direct.");
  process.exit(2);
}
const pu = new URL(raw.includes("://") ? raw : `http://${raw}`);
const proxy = {
  server: `${pu.protocol}//${pu.host}`,
  ...(pu.username ? { username: decodeURIComponent(pu.username) } : {}),
  ...(pu.password ? { password: decodeURIComponent(pu.password) } : {}),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (b) => `${Math.round(b / 1024)} kB`;
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

let spent = 0; // bytes the browser saw cross, before the overhead margin
const rows = [];
let blocked = 0;

function billed() {
  return Math.round(spent * OVERHEAD);
}

/**
 * One context per portal, everything but the portal's own documents refused.
 * Cloudflare's challenge, if served, arrives as a document too — it is
 * recorded as such; its scripts are blocked with the rest, so it is never run.
 */
async function openContext(browser, portal) {
  const context = await browser.newContext({ locale: "fr-FR", timezoneId: "Europe/Paris", userAgent: UA });
  await context.route("**/*", (route) => {
    const req = route.request();
    const host = new URL(req.url()).hostname;
    const own = host === portal.host || host === "ipinfo.io";
    if (req.resourceType() === "document" && own) return route.continue();
    blocked++;
    return route.abort();
  });
  context.on("requestfinished", async (req) => {
    try {
      const s = await req.sizes();
      spent += s.requestHeadersSize + s.requestBodySize + s.responseHeadersSize + s.responseBodySize;
    } catch {
      /* gone with its page */
    }
  });
  return context;
}

async function visit(page, portalKey, kind, url, largestDoc) {
  // Stop before a page that could cross the cap, not after it.
  const next = Math.max(largestDoc, 400 * 1024) * OVERHEAD;
  if (billed() + next > BUDGET_BYTES) {
    rows.push({ portal: portalKey, kind, url, status: "-", verdict: "skipped: budget", bytes: 0 });
    return { stop: true };
  }
  const before = spent;
  let status = 0;
  let html = "";
  let mitigated = "";
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    status = res?.status() ?? 0;
    mitigated = res?.headers()["cf-mitigated"] ?? "";
    await sleep(500); // let `requestfinished` land so the count is complete
    html = await page.content();
  } catch (err) {
    rows.push({ portal: portalKey, kind, url, status: "error", verdict: err.message.split("\n")[0].slice(0, 80), bytes: spent - before });
    return { stop: true };
  }
  const challenge = mitigated === "challenge" || /Just a moment|Attention Required|challenge-platform/i.test(html.slice(0, 6000));
  const verdict =
    status === 200 && !challenge
      ? PORTALS[portalKey].looksServed(html)
        ? "SERVED"
        : "200 but not a page we can read"
      : challenge
        ? `REFUSED: Cloudflare challenge (${status})`
        : status === 429
          ? "REFUSED: rate limit (429)"
          : `REFUSED: HTTP ${status}`;
  const bytes = spent - before;
  rows.push({ portal: portalKey, kind, url, status, verdict, bytes });
  await fs.writeFile(path.join(OUT, `${portalKey}-${kind}-${rows.length}.html`), html);
  return { stop: !verdict.startsWith("SERVED") && kind !== "egress", html, docBytes: bytes };
}

await fs.mkdir(OUT, { recursive: true });
console.log(`proxy ${pu.host} (credentials not printed) · user-agent: ${UA}`);
console.log(`budget ${mb(BUDGET_BYTES)} incl. ×${OVERHEAD} overhead · ${LISTINGS} listing(s) per portal · ${wanted.join(", ")}\n`);

const browser = await chromium.launch({ headless: true, proxy });
try {
  for (const key of wanted) {
    const portal = PORTALS[key];
    const context = await openContext(browser, portal);
    const page = await context.newPage();

    // Where this session leaves from — a few hundred bytes, worth it to read the result.
    try {
      await page.goto("https://ipinfo.io/json", { timeout: 20_000 });
      const info = JSON.parse(await page.locator("body").innerText());
      console.log(`── ${key}: egress ${info.ip} · ${info.city ?? "?"}, ${info.country ?? "?"} · ${info.org ?? "?"}`);
    } catch {
      console.log(`── ${key}: egress address unknown (ipinfo did not answer)`);
    }

    let largest = 0;
    const first = await visit(page, key, "index", portal.index, largest);
    largest = Math.max(largest, first.docBytes ?? 0);
    if (!first.stop) {
      const links = [...new Set(portal.listingLinks(first.html))].slice(0, LISTINGS);
      if (links.length === 0 && LISTINGS > 0) rows.push({ portal: key, kind: "listing", url: "-", status: "-", verdict: "no listing links on the index", bytes: 0 });
      for (const url of links) {
        await sleep(portal.delayMs);
        const r = await visit(page, key, "listing", url, largest);
        largest = Math.max(largest, r.docBytes ?? 0);
        if (r.stop) break; // first refusal ends the portal: no knocking until someone opens
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const lines = [
  "| portal | page | HTTP | verdict | on the wire |",
  "|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.portal} | ${r.kind} | ${r.status} | ${r.verdict} | ${kb(r.bytes)} |`),
  "",
  `**Proxy traffic: ~${mb(billed())}** (${mb(spent)} counted by the browser ×${OVERHEAD}) of a ${mb(BUDGET_BYTES)} cap · ${blocked} sub-requests blocked`,
];
console.log("\n" + lines.join("\n"));
for (const r of rows) console.log(`   ${r.portal} ${r.kind}: ${r.url}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Residential proxy test\n\n${lines.join("\n")}\n`);
}
