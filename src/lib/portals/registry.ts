import type { PortalAdapter } from "./types";
import { smcAdapter } from "./adapters/smc";
import { etreproprioAdapter } from "./adapters/etreproprio";
import { luxuryEstateAdapter } from "./adapters/luxuryestate";
import { superimmoAdapter } from "./adapters/superimmo";
import { greenAcresAdapter } from "./adapters/greenacres";
import { figaroAdapter } from "./adapters/figaro";

/**
 * Adapter registry.
 *
 * A row in `portal_sources` names an adapter by key; this maps that key to the
 * code that implements it. Adding a portal for a future client is a new file
 * here plus a row in the table — never a branch, and never a fork of the
 * pipeline. ("Config, not forks", per the Lead Estate client build SOP.)
 *
 * Ten adapters will cover thirteen portals: SeLoger and Belles Demeures run on
 * one AVIV platform, Maisons et Appartements and Résidences Immobilier on one
 * SMC platform, Green-Acres and Vizzit on one engine. The library grows slower
 * than the portal count because the French market is a handful of platforms
 * wearing different brands.
 */

const ADAPTERS: PortalAdapter[] = [
  smcAdapter,
  etreproprioAdapter,
  luxuryEstateAdapter,
  superimmoAdapter,
  greenAcresAdapter,
  figaroAdapter,
  // jamesEditionAdapter,
  // avivAdapter,
  // figaroImmobilierAdapter,
  // zooplaAdapter,
];

const BY_KEY = new Map(ADAPTERS.map((a) => [a.key, a]));

export function getAdapter(key: string): PortalAdapter {
  const adapter = BY_KEY.get(key);
  if (!adapter) {
    throw new Error(
      `No adapter registered for source "${key}". ` +
        `Known: ${[...BY_KEY.keys()].join(", ") || "(none)"}.`,
    );
  }
  return adapter;
}

export function listAdapters(): PortalAdapter[] {
  return [...ADAPTERS];
}

/** Which adapter handles a URL — used when a link turns up without context. */
export function adapterForHost(hostname: string): PortalAdapter | null {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  return (
    ADAPTERS.find((a) => a.hosts.some((h) => h.replace(/^www\./, "").toLowerCase() === host)) ??
    null
  );
}
