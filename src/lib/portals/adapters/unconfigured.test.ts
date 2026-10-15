import { test } from "node:test";
import assert from "node:assert/strict";
import { listAdapters } from "../registry";
import { addressableCommunes } from "./unconfigured";
import {
  ETREPROPRIO_SLUGS,
  FIGARO_COMMUNES,
  GREEN_ACRES_COMMUNES,
  JAMESEDITION_COMMUNES,
  SMC_COMMUNES,
  SUPERIMMO_COMMUNES,
  luxuryEstatePathsByInsee,
} from "../communePaths";

/** No commune has this code: no config, seeded or built in, can name it. */
const NOWHERE = "99999";

/**
 * Adapters that address any INSEE code directly, through an API that takes
 * the code itself — there is no per-commune slug that could be missing.
 */
const ADDRESS_ANY_INSEE: Record<string, string> = {
  "stream-estate": "the V2 search takes `uniqueCodes: [insee]` as it is",
  "stream-estate-v1": "the V1 search falls back to `includedInseeCodes[]=<insee>` for any commune",
};

/**
 * Each adapter's config as seeded — real gulf communes, none of them NOWHERE —
 * so the test also proves an adapter asks for nothing it was not asked for.
 * SMC carries its sitemap, which used to be walked even for a pass with no
 * commune it could address. An adapter missing here runs with `{}`, which for
 * Bien'ici, Zoopla and Figaro Immobilier means their built-in tables.
 */
const SEEDED: Record<string, Record<string, unknown>> = {
  smc: { sitemap: "https://www.maisonsetappartements.fr/sitemap.xml", communes: SMC_COMMUNES },
  etreproprio: { communeSlugs: ETREPROPRIO_SLUGS },
  luxuryestate: { communePaths: luxuryEstatePathsByInsee() },
  superimmo: { communes: SUPERIMMO_COMMUNES },
  "green-acres": { communes: GREEN_ACRES_COMMUNES },
  figaro: { communes: FIGARO_COMMUNES },
  jamesedition: { communes: JAMESEDITION_COMMUNES },
  vizzit: { communes: GREEN_ACRES_COMMUNES },
};

async function discoverNowhere(key: string, config: Record<string, unknown>) {
  const adapter = listAdapters().find((a) => a.key === key)!;
  const asked: string[] = [];
  const incomplete: [string, string][] = [];
  const out: string[] = [];
  const ctx = {
    fetch: async (url: string): Promise<string> => {
      asked.push(url);
      throw new Error(`fetch was called for ${url}`);
    },
    communeInsee: [NOWHERE],
    config,
    incomplete: (insee: string, reason: string) => incomplete.push([insee, reason]),
  };
  for await (const d of adapter.discover(ctx)) out.push(d.externalId);
  return { asked, incomplete, out };
}

test("the skip list names only adapters that exist, each with its reason", () => {
  const keys = new Set(listAdapters().map((a) => a.key));
  for (const [key, why] of Object.entries(ADDRESS_ANY_INSEE)) {
    assert.ok(keys.has(key), `${key} is skipped below but is not in the registry`);
    assert.ok(why.length > 0);
  }
});

/**
 * REVIEW 1.6, 2026-10-15. The runner's delisting baseline is every commune the
 * pass was asked for. An adapter that warned "skipping" for a commune it had no
 * slug for — seven of them did — handed the runner a commune that looked walked
 * and empty, and the runner delisted its whole stock for that source that
 * night. The abort guard saw a healthy total and said nothing.
 *
 * One test per registered adapter, so a new one cannot join without it.
 */
for (const adapter of listAdapters()) {
  if (ADDRESS_ANY_INSEE[adapter.key]) continue;

  test(`${adapter.key}: a commune it has no config for is reported incomplete, never walked as empty`, async () => {
    for (const config of [{}, SEEDED[adapter.key] ?? {}]) {
      const { asked, incomplete, out } = await discoverNowhere(adapter.key, config);
      assert.deepEqual(asked, [], `${adapter.key} fetched for a commune it cannot address`);
      assert.deepEqual(out, []);
      assert.equal(incomplete.length, 1, `${adapter.key}: ${JSON.stringify(incomplete)}`);
      assert.equal(incomplete[0][0], NOWHERE);
      assert.match(incomplete[0][1], /no .+ configured for this commune/);
    }
  });
}

test("the helper keeps the order asked for, and reports only what it cannot address", () => {
  const reported: [string, string][] = [];
  const wanted = addressableCommunes(
    {
      communeInsee: ["83119", "83079", "83068"],
      incomplete: (insee, reason) => reported.push([insee, reason]),
    },
    { source: "jamesedition", what: "area slug", has: (insee) => insee !== "83079" },
  );
  assert.deepEqual(wanted, ["83119", "83068"]);
  assert.deepEqual(reported, [["83079", "no area slug configured for this commune"]]);
});

test("JamesEdition shields La Môle every night: there is no area page to walk", async () => {
  // Their nearby-areas block names eleven of our twelve and not La Môle; a
  // guessed slug answers 200 with somewhere else. Reported, it is shielded.
  assert.equal(JAMESEDITION_COMMUNES.some((c) => c.insee === "83079"), false);
  const adapter = listAdapters().find((a) => a.key === "jamesedition")!;
  const incomplete: [string, string][] = [];
  const asked: string[] = [];
  for await (const _ of adapter.discover({
    fetch: async (url) => {
      asked.push(url);
      throw new Error("no network in tests");
    },
    communeInsee: ["83079"],
    config: { communes: JAMESEDITION_COMMUNES },
    incomplete: (insee, reason) => incomplete.push([insee, reason]),
  })) {
    assert.fail("nothing to yield");
  }
  assert.deepEqual(asked, []);
  assert.deepEqual(incomplete, [["83079", "no area slug configured for this commune"]]);
});
