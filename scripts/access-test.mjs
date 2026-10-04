#!/usr/bin/env node
/**
 * Who serves the collector, from where? A small, metered answer per portal.
 *
 *   node scripts/access-test.mjs --direct                      # from this machine's own address
 *   node scripts/access-test.mjs                               # through PMA_RESIDENTIAL_PROXY
 *   node scripts/access-test.mjs --portals=figaro,seloger --listings=2 --budget-mb=20
 *
 * Two modes, one question each:
 *   --direct  "does this address get served?" — run on GitHub Actions it says
 *             which portals the nightly can reach as it is. Free.
 *   (proxy)   "would a residential address get served?" — needs
 *             PMA_RESIDENTIAL_PROXY (http://user:pass@host:port) and refuses
 *             to fall back to direct, which would answer the other question.
 *
 * THE PORTALS. Two groups (`--portals` picks; the default is the group named
 * by `--group`, "candidates" unless told otherwise):
 *   blocked     Figaro, JamesEdition, SMC (both sites), Superimmo — adapters exist, the
 *               nightly cannot reach them. Measured through a French
 *               residential address on 2026-10-04: the first two served every
 *               page; SMC answered its Cloudflare challenge and Superimmo a
 *               Turnstile check on the first request, so an address is not
 *               what those two are refusing.
 *   candidates  the portals on the client's list with NO adapter yet: SeLoger
 *               and Belles Demeures (AVIV), Figaro Immobilier, Vizzit, Zefir,
 *               Zoopla Overseas. This is the cheap test to run before writing
 *               one: an adapter is a day, and it is wasted on a portal that
 *               will not open the door.
 * Together with the three that already collect nightly from GitHub and are
 * therefore not here (Green-Acres, Etreproprio, LuxuryEstate — their own run
 * log is the measurement), that is the client's fourteen. Bien'ici is a
 * fifteenth we added.
 *
 * ROBOTS.TXT COMES FIRST, for every portal, every run. A page it disallows is
 * requested only where written permission is on file (`basis: "permission"`);
 * otherwise the test reports "closed by robots.txt" and asks nothing more.
 *
 * WHAT IT DOES NOT DO: no stealth. Our own user-agent, headless, nothing
 * patched. A challenge or captcha is recorded and the portal is stopped there
 * — never solved, never waited out, never retried from another address. A
 * residential address is a way to the front door for a portal that filters
 * datacentre ranges wholesale; it is not an answer to a portal that has seen
 * who we are and said no (runner/browser.ts, `proxy`).
 *
 * WHY IT IS METERED. Trial plans are ~100 MB. A listing page with everything
 * it pulls in is 2–5 MB (measured 2026-10-04); the HTML we parse is ~3 % of
 * that. So only the portal's own documents are loaded — no images, fonts,
 * scripts, styles or third-party calls — and every byte that does cross is
 * counted, with a margin for TLS and proxy overhead the browser cannot see.
 * Sixteen pages across four portals cost 0.96 MB on 2026-10-04.
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
const DIRECT = args.direct === "true";
const LISTINGS = Math.max(0, Number(args.listings ?? 3));
const BUDGET_BYTES = Math.max(1, Number(args["budget-mb"] ?? 30)) * 1024 * 1024;
const OUT = path.resolve(args.out ?? "access-test-pages");
/** What the browser can count is HTTP. TLS records and the proxy CONNECT are on top. */
const OVERHEAD = 1.2;

const UA =
  process.env.CRAWLER_USER_AGENT?.trim() ||
  process.env.COLLECTOR_USER_AGENT?.trim() ||
  "PortalMonitoringAgent/1.0 (+https://leadestate.com; suleiman@leadestate.com)";

/** Every `href` on a page that matches, made absolute. */
const links = (html, origin, re) =>
  [...html.matchAll(re)].map((m) => (m[1].startsWith("http") ? m[1] : `${origin}${m[1]}`));

/**
 * `basis` is why we may ask at all: "open" is robots.txt, "permission" is a
 * written reply from a named person (dates in PMA — Portal Letters).
 * `listings` are fixed URLs used when the index gives none — real ones, taken
 * from our own database or from the Stream.Estate pilot of 2026-09-29. A 404
 * on one means the listing has gone, which is not a refusal and is reported
 * differently.
 */
const PORTALS = {
  // ── adapters exist, the nightly is refused ────────────────────────────────
  figaro: {
    group: "blocked",
    basis: "permission",
    origin: "https://proprietes.lefigaro.fr",
    delayMs: 5_000,
    index: "https://proprietes.lefigaro.fr/annonces/immobilier-var-provence+alpes+cote+d+azur-france/?ville=st+tropez",
    listingLinks: (html) =>
      links(html, "https://proprietes.lefigaro.fr", /(?:https:\/\/proprietes\.lefigaro\.fr)?(\/annonces\/[^/?#"\s]+\/\d{5,}\/)/g),
    /** Their listing state ships in the page; without it the page is not one we can read. */
    looksServed: (html) => html.includes("__NUXT_DATA__"),
  },
  jamesedition: {
    group: "blocked",
    basis: "open",
    origin: "https://www.jamesedition.com",
    delayMs: 4_000,
    index: "https://www.jamesedition.com/real_estate/saint-tropez-france?order=recent",
    listingLinks: (html) =>
      links(html, "https://www.jamesedition.com", /href="(\/real_estate\/[a-z0-9-]+\/[a-z0-9-]+-\d{6,})"/gi),
    looksServed: (html) => /application\/ld\+json/.test(html) && /real_estate/.test(html),
  },
  smc: {
    group: "blocked",
    basis: "permission",
    origin: "https://www.maisonsetappartements.fr",
    delayMs: 10_000,
    /**
     * No index: their search pages refuse us outright, and discovery goes
     * through a sitemap far too large for this budget. The home page stands in.
     */
    index: "https://www.maisonsetappartements.fr/",
    listings: [
      "https://www.maisonsetappartements.fr/fr/83/annonce-vente-maison-les-issambres-4161332.html",
      "https://www.maisonsetappartements.fr/fr/83/annonce-vente-maison-les-issambres-4444814.html",
      "https://www.maisonsetappartements.fr/fr/83/annonce-vente-maison-les-issambres-4345866.html",
    ],
    looksServed: (html) => /description-ann|application\/ld\+json/.test(html) && html.length > 20_000,
  },
  "smc-residences": {
    group: "blocked",
    /** SMC's second site. robots.txt closes `fiche-annonce-*`; their reply of 25 Aug covers it. */
    basis: "permission",
    origin: "https://www.residences-immobilier.com",
    delayMs: 10_000,
    index: "https://www.residences-immobilier.com/",
    listings: ["https://www.residences-immobilier.com/fr/83/annonce-vente-maison-ramatuelle-4426627.html"],
    looksServed: (html) => /description-ann|application\/ld\+json/.test(html) && html.length > 20_000,
  },
  superimmo: {
    group: "blocked",
    basis: "open",
    origin: "https://www.superimmo.com",
    delayMs: 10_000,
    index: "https://www.superimmo.com/achat/provence-alpes-cote-d-azur/var/saint-tropez-83990?sort=created_at",
    listingLinks: (html) =>
      links(html, "https://www.superimmo.com", /href="((?:https:\/\/www\.superimmo\.com)?\/annonces\/achat-[a-z0-9-]+)"/gi),
    looksServed: (html) => /\/annonces\/achat-|€/.test(html) && html.length > 20_000,
  },

  // ── on the client's list, no adapter yet ──────────────────────────────────
  seloger: {
    group: "candidates",
    /** AVIV, written 25 Aug 2026. Their robots.txt closes search and listings to everyone else. */
    basis: "permission",
    origin: "https://www.seloger.com",
    delayMs: 6_000,
    index: "https://www.seloger.com/recherche/achat/maison/provence-alpes-cote-d-azur/saint-tropez-83990/ad08fr34360",
    listingLinks: (html) =>
      links(html, "https://www.seloger.com", /href="((?:https:\/\/www\.seloger\.com)?\/annonce\/achat\/[^"?#]+)/gi),
    listings: ["https://www.seloger.com/annonce/achat/provence-alpes-cote-d-azur/var-83/saint-tropez-83990/26EW5UCY9FGY"],
    looksServed: (html) => html.length > 30_000 && /annonce|€/i.test(html),
  },
  bellesdemeures: {
    group: "candidates",
    basis: "permission", // same AVIV reply
    origin: "https://www.bellesdemeures.com",
    delayMs: 6_000,
    index: "https://www.bellesdemeures.com/",
    listingLinks: (html) =>
      links(html, "https://www.bellesdemeures.com", /href="((?:https:\/\/www\.bellesdemeures\.com)?\/annonces\/vente\/[^"?#]+\/\d{6,}\/)/gi),
    listings: ["https://www.bellesdemeures.com/annonces/vente/tt-2-tb-2-pl-35941/271605725/"],
    looksServed: (html) => html.length > 30_000 && /annonce|€/i.test(html),
  },
  "figaro-immobilier": {
    group: "candidates",
    /**
     * "open", not "permission": Groupe Figaro's reply of 25 Aug was about
     * Propriétés Le Figaro. Whether it covers this site has never been asked,
     * so here their robots.txt decides.
     */
    basis: "open",
    origin: "https://immobilier.lefigaro.fr",
    delayMs: 5_000,
    index: "https://immobilier.lefigaro.fr/annonces/immobilier-vente-bien-saint+tropez+83990.html",
    listingLinks: (html) =>
      links(html, "https://immobilier.lefigaro.fr", /href="((?:https:\/\/immobilier\.lefigaro\.fr)?\/annonces\/annonce-\d{6,}\.html)/gi),
    listings: ["https://immobilier.lefigaro.fr/annonces/annonce-104748999.html"],
    looksServed: (html) => html.length > 30_000 && /annonce|€/i.test(html),
  },
  vizzit: {
    group: "candidates",
    /** Green-Acres' engine and, by the Stream.Estate pilot, its ids too. */
    basis: "open",
    origin: "https://www.vizzit.fr",
    delayMs: 3_000,
    index: "https://www.vizzit.fr/property-for-sale/saint-tropez",
    listingLinks: (html) =>
      links(html, "https://www.vizzit.fr", /href="((?:https:\/\/www\.vizzit\.fr)?\/fr\/property\/[a-z-]+\/[a-z-]+\/A[a-z0-9]{12,})/gi),
    listings: ["https://www.vizzit.fr/fr/property/appartement/saint-tropez/Ag0fd0cn96pi96t3"],
    looksServed: (html) => html.length > 30_000 && /currency-selection-|price/i.test(html),
  },
  zefir: {
    group: "candidates",
    /**
     * Dropped on merit, not access (re-checked 10 Sep): one of our fourteen
     * communes, and every listing republished from feeds we already collect.
     * Here only so the answer for the client's whole list is on one page.
     */
    basis: "open",
    origin: "https://www.zefir.fr",
    delayMs: 3_000,
    index: "https://www.zefir.fr/",
    looksServed: (html) => html.length > 20_000,
  },
  "zoopla-overseas": {
    group: "candidates",
    /** robots.txt closed /property/ and /search/ when read on 24 Aug; it decides again here. */
    basis: "open",
    origin: "https://www.zoopla.co.uk",
    delayMs: 5_000,
    index: "https://www.zoopla.co.uk/overseas/",
    looksServed: (html) => html.length > 20_000 && /overseas|property/i.test(html),
  },
};

const group = args.group ?? "candidates";
const wanted = (args.portals ?? Object.keys(PORTALS).filter((k) => PORTALS[k].group === group).join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
for (const k of wanted) {
  if (!PORTALS[k]) {
    console.error(`"${k}" is not tested here. Known: ${Object.keys(PORTALS).join(", ")}.`);
    process.exit(2);
  }
}

let proxy;
let proxyHost = "";
if (!DIRECT) {
  const raw = process.env.PMA_RESIDENTIAL_PROXY?.trim();
  if (!raw) {
    console.error(
      "PMA_RESIDENTIAL_PROXY is not set, so this would go out direct and answer a different question.\n" +
        "Pass --direct if that is the question you mean to ask.",
    );
    process.exit(2);
  }
  const pu = new URL(raw.includes("://") ? raw : `http://${raw}`);
  proxyHost = pu.host;
  proxy = {
    server: `${pu.protocol}//${pu.host}`,
    ...(pu.username ? { username: decodeURIComponent(pu.username) } : {}),
    ...(pu.password ? { password: decodeURIComponent(pu.password) } : {}),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (b) => `${Math.round(b / 1024)} kB`;
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

let spent = 0; // bytes the browser saw cross, before the overhead margin
let blocked = 0;
const rows = [];
const billed = () => Math.round(spent * OVERHEAD);

/**
 * May `url` be fetched, by the `User-agent: *` group of this robots.txt?
 * Longest matching rule wins, Allow on a tie — the convention every large
 * crawler follows. `*` and a trailing `$` are honoured. A group that names our
 * own agent would take precedence; none has, and if one ever does that is a
 * refusal to read in person, so it is reported rather than parsed.
 */
function robotsVerdict(robots, url) {
  if (/user-agent:\s*portalmonitoringagent/i.test(robots)) return { allowed: false, rule: "names PortalMonitoringAgent — read it" };
  const target = new URL(url).pathname + new URL(url).search;
  let inStar = false;
  let seenRuleInGroup = false;
  let best = { len: -1, allow: true, rule: "" };
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = line.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, field, value] = m;
    if (field.toLowerCase() === "user-agent") {
      if (seenRuleInGroup) { inStar = false; seenRuleInGroup = false; }
      if (value.trim() === "*") inStar = true;
      continue;
    }
    seenRuleInGroup = true;
    if (!inStar || !value) continue;
    const pattern = "^" + value.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\?\$$/, "$");
    let re;
    try { re = new RegExp(pattern); } catch { continue; }
    if (!re.test(target)) continue;
    const allow = field.toLowerCase() === "allow";
    if (value.length > best.len || (value.length === best.len && allow)) best = { len: value.length, allow, rule: `${field}: ${value}` };
  }
  return { allowed: best.allow, rule: best.rule };
}

/** One context per portal, everything but the portal's own documents refused. */
async function openContext(browser, host) {
  const context = await browser.newContext({ locale: "fr-FR", timezoneId: "Europe/Paris", userAgent: UA });
  await context.route("**/*", (route) => {
    const req = route.request();
    const h = new URL(req.url()).hostname;
    if (req.resourceType() === "document" && (h === host || h === "ipinfo.io")) return route.continue();
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

/** What came back, named for what it is. Only "SERVED" lets the portal continue. */
function classify(status, headers, html, portal) {
  const head = html.slice(0, 8000);
  if (headers["x-datadome"] || /captcha-delivery\.com|datadome/i.test(head)) return `REFUSED: DataDome captcha (${status})`;
  if (/cf-turnstile|challenges\.cloudflare\.com\/turnstile/i.test(html)) return `REFUSED: Cloudflare Turnstile check (${status})`;
  if (headers["cf-mitigated"] === "challenge" || /Just a moment|challenge-platform/i.test(head)) return `REFUSED: Cloudflare challenge (${status})`;
  if (status === 404 || status === 410) return `gone (${status}) — not a refusal`;
  if (status === 429) return "REFUSED: rate limit (429)";
  if (status !== 200) return `REFUSED: HTTP ${status}`;
  return portal.looksServed(html) ? "SERVED" : "200 but not a page we can read";
}

async function visit(page, key, kind, url, largestDoc) {
  // Stop before a page that could cross the cap, not after it.
  if (billed() + Math.max(largestDoc, 400 * 1024) * OVERHEAD > BUDGET_BYTES) {
    rows.push({ portal: key, kind, url, status: "-", verdict: "skipped: budget", bytes: 0 });
    return { ok: false };
  }
  const before = spent;
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const status = res?.status() ?? 0;
    const headers = res?.headers() ?? {};
    await sleep(500); // let `requestfinished` land so the count is complete
    const html = await page.content();
    const verdict = classify(status, headers, html, PORTALS[key]);
    const bytes = spent - before;
    rows.push({ portal: key, kind, url, status, verdict, bytes });
    await fs.writeFile(path.join(OUT, `${key}-${kind}-${rows.length}.html`), html);
    return { ok: verdict === "SERVED", gone: verdict.startsWith("gone"), html, bytes };
  } catch (err) {
    rows.push({ portal: key, kind, url, status: "error", verdict: err.message.split("\n")[0].slice(0, 90), bytes: spent - before });
    return { ok: false };
  }
}

await fs.mkdir(OUT, { recursive: true });
console.log(
  `${DIRECT ? "DIRECT — this machine's own address" : `via proxy ${proxyHost} (credentials not printed)`} · user-agent: ${UA}`,
);
console.log(`budget ${mb(BUDGET_BYTES)} incl. ×${OVERHEAD} overhead · ${LISTINGS} listing(s) per portal · ${wanted.join(", ")}\n`);

const browser = await chromium.launch({ headless: true, ...(proxy ? { proxy } : {}) });
const robotsNotes = [];
try {
  for (const key of wanted) {
    const portal = PORTALS[key];
    const host = new URL(portal.origin).hostname;
    const context = await openContext(browser, host);
    const page = await context.newPage();

    // Where this session leaves from — a few hundred bytes, worth it to read the result.
    try {
      await page.goto("https://ipinfo.io/json", { timeout: 20_000 });
      const info = JSON.parse(await page.locator("body").innerText());
      console.log(`── ${key}: leaving from ${info.ip} · ${info.city ?? "?"}, ${info.country ?? "?"} · ${info.org ?? "?"}`);
    } catch {
      console.log(`── ${key}: egress address unknown (ipinfo did not answer)`);
    }

    // robots.txt first. Unreadable is itself an answer, and not permission.
    let robots = null;
    try {
      const res = await page.goto(`${portal.origin}/robots.txt`, { timeout: 30_000 });
      if (res?.status() === 200) robots = await page.locator("body").innerText();
      else robotsNotes.push(`${key}: robots.txt answered HTTP ${res?.status() ?? "?"}`);
    } catch (err) {
      robotsNotes.push(`${key}: robots.txt unreadable (${err.message.split("\n")[0].slice(0, 60)})`);
    }
    const mayAsk = (url, kind) => {
      if (robots === null) return true; // nothing to obey; the page's own answer will say
      const v = robotsVerdict(robots, url);
      if (v.allowed) return true;
      if (portal.basis === "permission") {
        robotsNotes.push(`${key} ${kind}: robots.txt says "${v.rule}" — asked anyway, written permission on file`);
        return true;
      }
      rows.push({ portal: key, kind, url, status: "-", verdict: `closed by robots.txt (${v.rule}) — not requested`, bytes: 0 });
      return false;
    };

    let largest = 0;
    let fromIndex = [];
    if (mayAsk(portal.index, "index")) {
      await sleep(portal.delayMs);
      const first = await visit(page, key, "index", portal.index, largest);
      largest = Math.max(largest, first.bytes ?? 0);
      if (first.ok && portal.listingLinks) fromIndex = [...new Set(portal.listingLinks(first.html))];
      // A refusal on the index ends the portal: no knocking on its other doors.
      if (!first.ok && !first.gone) {
        await context.close();
        continue;
      }
    }
    const candidates = (fromIndex.length > 0 ? fromIndex : (portal.listings ?? [])).slice(0, LISTINGS);
    for (const url of candidates) {
      if (!mayAsk(url, "listing")) break;
      await sleep(portal.delayMs);
      const r = await visit(page, key, "listing", url, largest);
      largest = Math.max(largest, r.bytes ?? 0);
      if (!r.ok && !r.gone) break; // first refusal ends the portal
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const lines = [
  `**${DIRECT ? "Direct, from this machine's address" : `Through the residential proxy (${proxyHost})`}**`,
  "",
  "| portal | page | HTTP | verdict | on the wire |",
  "|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.portal} | ${r.kind} | ${r.status} | ${r.verdict} | ${kb(r.bytes)} |`),
  "",
  ...(robotsNotes.length ? ["robots.txt:", ...robotsNotes.map((n) => `- ${n}`), ""] : []),
  `**Traffic: ~${mb(billed())}** (${mb(spent)} counted by the browser ×${OVERHEAD}) of a ${mb(BUDGET_BYTES)} cap · ${blocked} sub-requests blocked`,
];
console.log("\n" + lines.join("\n"));
for (const r of rows) console.log(`   ${r.portal} ${r.kind}: ${r.url}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Portal access test\n\n${lines.join("\n")}\n`);
}
