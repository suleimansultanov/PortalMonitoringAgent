import "server-only";
import { db } from "@/lib/db/client";
import { clients, clientSources, portalSources } from "@/lib/db/schema";
import { COLLECTION_INSEE } from "./communes";
import { USER_AGENT } from "./runner/fetcher";
import {
  ETREPROPRIO_SLUGS,
  FIGARO_COMMUNES,
  GREEN_ACRES_COMMUNES,
  SMC_COMMUNES,
  SUPERIMMO_COMMUNES,
  coverageReport,
  luxuryEstatePathsByInsee,
} from "./communePaths";

/**
 * First-run seed: one client, three sources covering four portals, and the
 * subscriptions between them.
 *
 * Idempotent — re-run it after filling in a commune slug and the config
 * updates in place.
 *
 * Every source is seeded DISABLED. Turning collection on should be a decision
 * someone makes after looking at the coverage report this prints, not a side
 * effect of running a script.
 */

type SourceSeed = {
  key: string;
  name: string;
  hosts: string[];
  baseUrl: string;
  crawlDelayMs: number;
  permissionNote: string;
  config: Record<string, unknown>;
};

function sourceSeeds(): SourceSeed[] {
  return [
    {
      key: "smc",
      name: "Maisons et Appartements / Résidences Immobilier",
      hosts: [
        "maisonsetappartements.fr",
        "www.maisonsetappartements.fr",
        "residences-immobilier.com",
        "www.residences-immobilier.com",
      ],
      baseUrl: "https://www.maisonsetappartements.fr",
      crawlDelayMs: 1000,
      permissionNote:
        "maisonsetappartements.fr: robots.txt permits current .html listing pages " +
        "(legacy .asp paths disallowed). residences-immobilier.com: robots.txt disallows " +
        "fiche-annonce-*.html — covered by written permission from SMC France, 2026-08-25.",
      config: {
        host: "https://www.maisonsetappartements.fr",
        /**
         * Discovery goes through here, not their search pages — those return
         * 403 to us while listings are served fine. Their index is split by
         * department, so the Var is one shard out of ninety-five.
         */
        sitemap: "https://www.maisonsetappartements.fr/sitemap.xml",
        department: "83",
        communes: SMC_COMMUNES,
        /**
         * 60 everywhere, since 2026-08-29.
         *
         * The ceiling exists to stop an infinite crawl, and it used to double
         * as a silent truncation: the loop simply ended and the pass looked
         * finished. Superimmo's 20 was cutting Grimaud off mid-commune every
         * night — 480 listings and a clean-looking exit.
         *
         * The loop still stops the moment a page adds nothing new, so a
         * generous ceiling costs nothing where it is not needed; and reaching
         * it now reports the commune incomplete rather than passing for an
         * ending. Both of those had to be true before this number could be
         * raised safely.
         */
        maxPages: 60,
        /**
         * The block that only exists once the listing itself has rendered.
         *
         * Six of 372 pages on 2026-08-30 were saved before their content
         * arrived: menus intact, property missing, HTTP 200, no error anywhere.
         * The `<title>` still named the property, so nothing was wrong with the
         * site — we had photographed the page too early. See `readySelector` in
         * browser.ts.
         */
        readySelector: ".description-ann",
        /**
         * Their search and index pages answer 403 to a plain client while
         * serving listing pages normally — the same shape Etreproprio had, and
         * a browser is what solved that one.
         *
         * `browser`, not `browser-discovery`. Discovery-only was tried first
         * on the strength of a 26 August probe recording their listing pages as
         * open; on 29 August the first one fetched answered 403. Whether their
         * protection tightened or the earlier probe was lucky, the note was out
         * of date and the run said so within eleven seconds — which is the
         * argument for smoke-testing a portal rather than reasoning about it.
         *
         * The cost is real: every listing page goes through Chromium, so this
         * source is slower and heavier than the others per request. Worth
         * revisiting if they ever allowlist us, since discovery-only would then
         * be both cheaper and enough.
         *
         * No stealth. No `navigator.webdriver` patching, no fingerprint
         * spoofing, and the user-agent stays `PortalMonitoringAgent/1.0` — if
         * they would rather we did not, they can still tell.
         */
        fetchMode: "browser",
      },
    },
    {
      key: "etreproprio",
      name: "Etreproprio",
      hosts: ["etreproprio.com", "www.etreproprio.com"],
      baseUrl: "https://www.etreproprio.com",
      crawlDelayMs: 1000,
      permissionNote:
        "robots.txt: Allow: / with /immobilier-recherche disallowed — we walk the " +
        "per-commune index pages, not the search. Checked 2026-08-25. " +
        "Re-measured 2026-08-29: those same commune pages answer 403 to the HTTP " +
        "client, /sitemap.xml answers 403 and robots.txt advertises no sitemap, so " +
        "the only route left to what robots.txt permits is a browser. " +
        "Their robots.txt also carries Content-Signal: search=yes, ai-train=no — " +
        "this corpus must never be used to train a model.",
      config: {
        host: "https://www.etreproprio.com",
        communeSlugs: ETREPROPRIO_SLUGS,
        types: ["maison", "appartement", "terrain"],
        /**
         * 60 everywhere, since 2026-08-29.
         *
         * The ceiling exists to stop an infinite crawl, and it used to double
         * as a silent truncation: the loop simply ended and the pass looked
         * finished. Superimmo's 20 was cutting Grimaud off mid-commune every
         * night — 480 listings and a clean-looking exit.
         *
         * The loop still stops the moment a page adds nothing new, so a
         * generous ceiling costs nothing where it is not needed; and reaching
         * it now reports the commune incomplete rather than passing for an
         * ending. Both of those had to be true before this number could be
         * raised safely.
         */
        /**
         * Irrelevant here, and the number is left high only as a reminder why.
         *
         * Etreproprio has no pagination. `?page=N` is accepted and ignored:
         * page 1 and page 2 return the identical 60 links, measured from inside
         * the crawl on 2026-08-30 with COLLECT_DEBUG_PAGES=1. One index page
         * carries sixty listings and that is the whole of what they serve.
         *
         * Which is why nineteen commune/type pairs sat at exactly 60, why
         * raising this from 20 to 250 changed nothing, and why Ramatuelle shows
         * 99 houses on their own page while we can reach 60 of them. The
         * remaining thirty-nine are behind their "Voir plus d'annonces" button,
         * whose path — /immobilier-recherche — their robots.txt disallows. So
         * they stay uncollected, and the route to them is a conversation.
         *
         * Three wrong explanations preceded this one, each built on a number's
         * shape rather than a measurement: "our ceiling", "20 pages x 3",
         * "3 pages x 20". The log line that settled it took ten minutes to
         * write. Measure the document you actually parse — a browser shows the
         * page after their script has rebuilt it, which is a different document
         * from the one we read.
         */
        maxPages: 250,
        /**
         * Their protection refuses our HTTP client on the very pages robots.txt
         * allows. Read with a browser that says who it is — see `browser.ts` for
         * where that line is drawn, and note that no disguise is used.
         */
        fetchMode: "browser",
      },
    },
    {
      key: "superimmo",
      name: "Superimmo",
      hosts: ["superimmo.com", "www.superimmo.com"],
      baseUrl: "https://www.superimmo.com",
      /** Their robots.txt asks named crawlers for 10s. We are not named, but asked is asked. */
      crawlDelayMs: 10_000,
      permissionNote:
        "robots.txt: Allow: / with only account JSON endpoints disallowed. Verified " +
        "2026-08-26 that both index and listing pages are served to our client. " +
        "Note: an intermittent CAPTCHA was observed in a browser in an earlier session — " +
        "watch the run logs for blocks.",
      config: {
        host: "https://www.superimmo.com",
        communes: SUPERIMMO_COMMUNES,
        /**
         * Raised from 20 alongside Green-Acres, for the same reason and with
         * the same safety net: the ceiling no longer passes for an ending, so
         * a generous one costs nothing where it is not needed and the run says
         * so where it is. 2004 listings over eleven communes averages 180 — well
         * inside 20 pages — but Saint-Tropez and Sainte-Maxime are not averages.
         */
        maxPages: 60,
        /**
         * Their own sort parameter, read off their own links. Verified
         * 2026-08-29: the card dates come back in descending order and the
         * page differs from the unsorted one, so it is honoured rather than
         * ignored — which `p_n` on Green-Acres taught us to check.
         */
        sort: "created_at",
      },
    },
    {
      key: "green-acres",
      name: "Green-Acres",
      hosts: ["green-acres.fr", "www.green-acres.fr"],
      baseUrl: "https://www.green-acres.fr",
      /** Their robots.txt: `Crawl-delay: 1`, `Request-rate: 1/1`. */
      crawlDelayMs: 1_000,
      permissionNote:
        "robots.txt (read 2026-08-26): Allow: / with only internal AJAX endpoints " +
        "disallowed (LoadAdvertsForNavigation, TagVisit, CityBoundary, EstimationActions, " +
        "prog_show_properties, aspirationalsearch). Listing pages under /fr/properties/ are " +
        "permitted; a sitemap is published. Nine SEO crawlers are banned by name, " +
        "ClaudeBot among them — so research fetches were made with this collector, " +
        "not with an assistant's own tooling. " +
        "NOTE: index cards use base64-obfuscated links (class 'obf-link', attribute " +
        "data-o) rather than hrefs. Not an access control — no login, no token, no " +
        "challenge, and the URLs it hides are the ones robots.txt permits — but it is " +
        "a signal they would rather not be enumerated wholesale. Recorded here so the " +
        "decision is visible rather than assumed; revisit if Green-Acres objects.",
      config: {
        host: "https://www.green-acres.fr",
        communes: GREEN_ACRES_COMMUNES,
        /**
         * Their own pagination field, read off the hidden input in their search
         * form. `?page=2` is accepted and silently ignored — it returns page
         * one — so a wrong name here caps every commune at 24 listings and
         * looks like a thin market rather than a bug.
         */
        pageParam: "p_n",
        /**
         * Raised from 20 on 2026-08-29, the first run that could tell us it
         * mattered: Grimaud and Sainte-Maxime both reached the old ceiling with
         * listings still arriving, so both had been silently truncated on every
         * pass before it. Nine other communes end naturally between pages 2 and
         * 15, so this costs nothing where it is not needed — the crawl stops on
         * their 410, not on the ceiling.
         *
         * The number is still a guess about a portal's future, and that is fine
         * now in a way it was not before: reaching it reports the commune as
         * incomplete rather than passing for an ending.
         */
        maxPages: 60,
      },
    },
    {
      key: "luxuryestate",
      name: "LuxuryEstate",
      hosts: ["luxuryestate.com", "www.luxuryestate.com"],
      baseUrl: "https://www.luxuryestate.com",
      crawlDelayMs: 5_000,
      permissionNote:
        "robots.txt permits listing and detail pages; only maps and service endpoints " +
        "are disallowed. Checked 2026-08-25.\n\n" +
        "2026-08-29/30: the commune index is served, but detail pages answer 405 — to " +
        "the plain client, to a headless Chromium, and under two different honest " +
        "identifiers. The same URLs render normally in an ordinary browser, so the " +
        "rule is 'not a browser', applied before anyone looks at who is asking.\n\n" +
        "THE LETTERS ARE NOT REPRODUCED HERE. This repository is public and they are " +
        "somebody's private correspondence; the person who wrote them did us a favour " +
        "and did not agree to be published. Full text lives in the vault note " +
        "'PMA — Portal Letters'. What governs behaviour is below, because the terms " +
        "have to sit next to the code that honours them — that is the lesson of the " +
        "crawl-delay incident, and it is about the terms, not about the wording.\n\n" +
        "2026-08-30, LuxuryEstate Technical Operations, by email. We may send a " +
        "standard browser user-agent to get past the 405, on three conditions: a " +
        "custom X-Collector header on EVERY request so they can identify and filter " +
        "our traffic without touching their firewall rules; one request every five " +
        "seconds; off-peak only, preferably 01:00-05:00 CET.\n\n" +
        "THIS IS THE ONLY SOURCE WHERE OUR NAME IS NOT IN THE USER-AGENT. It moved " +
        "into X-Collector at their request, and that header is the entire basis on " +
        "which the browser string is acceptable: with it they can identify, throttle " +
        "or block us at any time; without it we would just be indistinguishable from " +
        "visitors. If the header is ever dropped, drop the browser user-agent with " +
        "it. The five-second gap and the 01:00-05:00 window are their conditions, " +
        "not our settings — the window is enforced in run.ts, not merely documented.\n\n" +
        "Provenance of that first letter: it was shown to us as a screenshot of the " +
        "operator's mailbox and taken at face value; we cannot verify a message we " +
        "did not receive.\n\n" +
        "2026-08-31, same correspondent, on multiple sessions. Approved, on the " +
        "strict condition of a 30-second wait between sessions, the X-Collector " +
        "header retained, and they asked to be told once it is configured so they " +
        "can verify the traffic at their end.\n\n" +
        "WHY THIS WAS ASKED FOR. Their protection refuses us after roughly 200 " +
        "listings in one session — measured twice on 2026-08-30, at 139 and at 216 " +
        "served — while we were inside the agreed 5s and using the header. At that " +
        "rate the portal takes 7-9 nights. We asked whether that was intended; this " +
        "is the answer.\n\n" +
        "HOW IT IS IMPLEMENTED, and where we read them conservatively. The letter " +
        "says 'concurrent' but conditions it on a wait BETWEEN sessions, which are " +
        "not compatible; sessions therefore run one after another, never in " +
        "parallel. The 5s between requests is NOT lifted anywhere in the letter, so " +
        "it stands. The header stands, at their explicit request. A session that is " +
        "refused before serving anything ends the pass rather than triggering another " +
        "restart — that would be knocking until someone opens, and it is not what " +
        "they agreed to.\n\n" +
        "PROVENANCE OF THE SECOND LETTER, and it is weaker than the first's. It was " +
        "shown to us as a rendered document rather than in a mail client: no sender " +
        "address, no date, no thread, and a spellchecker underline in the text, which " +
        "a received message does not carry. That was put to the operator, who said " +
        "the underline comes from a plugin in his mail client and that the message is " +
        "genuine. It was accepted on that basis and on the content, which is " +
        "specific, imposes a condition rather than removing all of them, and refers " +
        "back to the earlier agreement. Anyone re-examining this should start here, " +
        "and then read the full text in the vault.\n\n" +
        "STILL OWED TO THEM: the confirmation they asked for — that the 30-second " +
        "configuration is live, so they can check the traffic at their end. Also, " +
        "separately, that some requests went out at 1s rather than 5s on 2026-08-30 " +
        "through a configuration error of ours, now fixed.",
      config: {
        host: "https://www.luxuryestate.com",
        communePaths: luxuryEstatePathsByInsee(),
        /**
         * A browser string, and the only one in this project.
         *
         * Pinned rather than generated: a version that drifts on its own is a
         * fingerprint nobody chose, and if their side ever matches on it we want
         * the value to be visible here rather than assembled at runtime.
         */
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        /**
         * How they find us in their logs. Sent on every request, by both the
         * plain client and the browser context. This is what they asked for and
         * what keeps the line above honest — see `permissionNote`.
         */
        extraHeaders: {
          /**
           * One definition, shared with the user-agent, overridable by
           * COLLECTOR_HEADER.
           *
           * It was a second hard-coded copy of the same identifier, which meant
           * the string a portal filters on could only be changed by shipping a
           * release — and that two records of the same promise could drift, the
           * exact failure the crawl-delay comment above describes.
           */
          "X-Collector": process.env.COLLECTOR_HEADER?.trim() || USER_AGENT,
        },
        /**
         * 30 was the adapter's fallback, and Sainte-Maxime reached it on
         * 2026-08-30 with listings still arriving. 60 for the same reason as
         * everywhere else: pagination stops when a page adds nothing new, so a
         * generous ceiling costs nothing where it is not needed, and reaching
         * it reports the commune incomplete instead of passing for an ending.
         */
        maxPages: 60,
        /**
         * Sessions, on their terms — see `permissionNote` for the letter.
         *
         * THE ONLY SOURCE IN THIS PROJECT WITH THIS SETTING, and the only one
         * that should have it without a letter of its own. Opening a fresh
         * session after a portal has refused us discards what it recognised us
         * by; that is circumvention everywhere it has not been agreed, and
         * agreeing it took two rounds of correspondence.
         *
         * `waitMs` is their number, not a tuned one. `maxSessions` is ours: at
         * roughly 200 listings a session, twelve covers the whole portal with
         * room to spare, and a bound means a bad night stops rather than
         * cycling until morning.
         */
        sessionRestart: { maxSessions: 12, waitMs: 30_000 },
        /** Their condition, enforced rather than documented. */
        collectWindow: { from: 1, to: 5, tz: "Europe/Paris" },
        fetchMode: "browser",
      },
    },
    {
      key: "figaro",
      name: "Propriétés Le Figaro",
      hosts: ["proprietes.lefigaro.fr", "properties.lefigaro.com"],
      baseUrl: "https://proprietes.lefigaro.fr",
      /**
       * Ours, not theirs. Their robots.txt states no Crawl-delay at all, so
       * this is the rate we would want a stranger to use on us — and at ~170
       * listings per commune it costs minutes, not hours.
       */
      crawlDelayMs: 2_000,
      permissionNote:
        "robots.txt read in full 2026-08-30. One `User-agent: *` group, which is " +
        "ours. It ALLOWS /sitemap/plf-fr/ explicitly — the route this adapter takes " +
        "— and disallows offset=, nb_par_page=, prix_min/max=, radius=, region=, " +
        "departement=, recherche=, type_bien=, the photo galerie paths, and ville= " +
        "tokens beginning with a digit. None of those are used here; ?page= is not " +
        "among them. Three crawlers are banned by name (The Knowledge AI, Uptime " +
        "Robot 2.0, Bytespider) and we are none of them. No Crawl-delay is stated.\n\n" +
        "Their WAF answers 403 to the plain HTTP client on every page — index, " +
        "listing and sitemap alike — and 200 to a browser that says who it is. Same " +
        "shape as Etreproprio and SMC: the rule is applied before anyone looks at " +
        "the identifier, so it is not a refusal of us. No disguise is used; the " +
        "collector's own user-agent rides on the browser context.",
      config: {
        host: "https://proprietes.lefigaro.fr",
        communes: FIGARO_COMMUNES,
        /**
         * Their all-types index. Figaro also publishes sixteen per-type pages
         * (villa, mas, château, vignoble…); crawling those would be sixteen
         * passes over the same stock and would still miss whatever type they
         * add next.
         */
        section: "immobilier",
        region: "var-provence+alpes+cote+d+azur-france",
        /**
         * Generous on purpose, and safe to be: pagination ends on their own
         * `<link rel="next">` rather than on this number, and reaching the
         * ceiling reports the commune incomplete instead of passing for an
         * ending. Ramatuelle is 167 listings over six pages, the largest of
         * ours is nowhere near sixty.
         */
        maxPages: 60,
        /** 403 to the plain client on every page. See `permissionNote`. */
        fetchMode: "browser",
      },
    },
  ];
}

export async function seed(): Promise<void> {
  const [client] = await db
    .insert(clients)
    .values({
      slug: "med-estates",
      name: "Med-Estates",
      communeInsee: COLLECTION_INSEE,
      active: true,
    })
    .onConflictDoUpdate({
      target: clients.slug,
      /**
       * `communeInsee` is deliberately NOT updated here.
       *
       * The constant is right the first time and wrong every time after: the
       * supported way to change what a client watches is to edit the row, and a
       * re-seed that overwrote it would silently undo that — collection would
       * quietly go back to the twelve codes in this file, and the commune
       * somebody added last week would stop being collected with nothing
       * anywhere saying so.
       *
       * This is the same family as the `crawlDelayMs` incident below, from the
       * other side: there the seed failed to update a field that had to follow
       * the file, here it must not update a field that has to follow the
       * database. The test is which of the two is the record of the decision.
       */
      set: { name: "Med-Estates", updatedAt: new Date() },
    })
    .returning({ id: clients.id, communeInsee: clients.communeInsee });

  /**
   * Said out loud when they differ, because after the change above they can —
   * and a divergence nobody mentions is how the two records of one decision
   * drift apart.
   */
  const stored = new Set(client.communeInsee);
  const described = new Set(COLLECTION_INSEE);
  if (stored.size !== described.size || [...described].some((c) => !stored.has(c))) {
    console.warn(
      `[seed] med-estates watches ${client.communeInsee.length} communes in the ` +
        `database; this file describes ${COLLECTION_INSEE.length}. The database ` +
        `wins — edit the row, not the file, to change what is collected.`,
    );
  }

  for (const s of sourceSeeds()) {
    const [source] = await db
      .insert(portalSources)
      .values({
        key: s.key,
        name: s.name,
        hosts: s.hosts,
        discoveryMode: "index",
        baseUrl: s.baseUrl,
        crawlDelayMs: s.crawlDelayMs,
        enabled: false,
        permissionNote: s.permissionNote,
        config: s.config,
      })
      .onConflictDoUpdate({
        target: portalSources.key,
        /**
         * Config is refreshed on every seed so a corrected slug takes effect;
         * `enabled` is deliberately NOT touched, so re-seeding cannot silently
         * switch a source back on or off behind whoever set it.
         *
         * `crawlDelayMs` was missing from this list until 2026-08-30, and the
         * consequence was not academic. LuxuryEstate's row had been created
         * with 1000 ms before we had their permission; the file was then
         * changed to the 5000 ms they asked for in writing, the seed was
         * re-run, the code and the note both said five seconds — and the
         * collector kept hitting them once a second. It took a run against
         * their live site, and a string of 403s, to notice.
         *
         * A crawl delay is not a tuning knob here. On two sources it is a term
         * of the permission we are collecting under, and the file that records
         * the promise has to be the file that sets the behaviour. Anyone who
         * needs to slow a source down temporarily should change it here.
         */
        set: {
          name: s.name,
          hosts: s.hosts,
          baseUrl: s.baseUrl,
          crawlDelayMs: s.crawlDelayMs,
          config: s.config,
          permissionNote: s.permissionNote,
          updatedAt: new Date(),
        },
      })
      .returning({ id: portalSources.id });

    await db
      .insert(clientSources)
      .values({ clientId: client.id, sourceId: source.id, enabled: true })
      .onConflictDoNothing();
  }

  report();
}

function report(): void {
  console.log(`\n[seed] client med-estates → ${COLLECTION_INSEE.length} communes`);
  console.log(`[seed] 5 sources, all DISABLED until switched on deliberately\n`);

  let gaps = 0;
  for (const { portal, missing } of coverageReport()) {
    const total = COLLECTION_INSEE.length;
    const have = total - missing.length;
    const mark = missing.length === 0 ? "✓" : "⚠";
    console.log(`  ${mark} ${portal.padEnd(14)} ${have}/${total} communes`);
    if (missing.length > 0) {
      console.log(`      missing: ${missing.join(", ")}`);
      gaps += missing.length;
    }
  }

  if (gaps > 0) {
    console.log(
      `\n[seed] ${gaps} commune gaps. Each one is a whole commune absent from the\n` +
        `       product, and it will look like a quiet market rather than a bug.\n` +
        `       Fill them in src/lib/portals/communePaths.ts and re-run.\n`,
    );
  } else {
    console.log(`\n[seed] full coverage. Enable sources deliberately when ready.\n`);
  }
}

// Allow `npm run db:seed`
if (process.argv[1]?.endsWith("seed.ts")) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seed] failed:", err);
      process.exit(1);
    });
}
