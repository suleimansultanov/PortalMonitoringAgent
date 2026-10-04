import * as cheerio from "cheerio";

/**
 * The state a Nuxt page was rendered from, as plain objects.
 *
 * Groupe Figaro's two sites (Propriétés Le Figaro, Figaro Immobilier) ship it
 * in `<script id="__NUXT_DATA__">` in devalue's format: one flat array where
 * every value holds INDICES into that same array, so an object shared by ten
 * records is stored once. `adapters/figaro.ts` has its own older copy of this
 * walk, written before a second site needed it; new readers use this one.
 *
 * Written defensively. This is hydration state, not a published interface:
 * the day its shape changes, a reader must get null back and report the page
 * as unreadable, not throw and lose the pass.
 */

/**
 * Devalue's type wrappers, which are `[name, index]` pairs rather than arrays.
 * Listed explicitly rather than sniffed: a plain array here holds indices, so
 * a leading string almost always means a wrapper — and "almost always" is how
 * a record whose first field happened to be a string would lose the rest.
 */
const WRAPPERS = new Set([
  "ShallowReactive",
  "Reactive",
  "Ref",
  "ShallowRef",
  "EmptyRef",
  "EmptyShallowRef",
  "Date",
  "Set",
  "Map",
  "BigInt",
  "RegExp",
  "URL",
  "URLSearchParams",
  "NuxtError",
  "Object",
]);

export type NuxtData = {
  /** The raw flat array, for finding nodes by shape. */
  flat: unknown[];
  /** Resolve the node at `index` into ordinary nested values. Cycles become null. */
  resolve(index: number): unknown;
};

export function readNuxtData(html: string): NuxtData | null {
  const raw = cheerio.load(html)("#__NUXT_DATA__").first().contents().text().trim();
  if (!raw) return null;

  let flat: unknown[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    flat = parsed;
  } catch {
    return null;
  }

  const walk = (index: unknown, seen: ReadonlySet<number>): unknown => {
    if (typeof index !== "number" || index < 0 || index >= flat.length) return null;
    if (seen.has(index)) return null;
    const value = flat[index];
    if (value === null || typeof value !== "object") return value;
    const next = new Set(seen).add(index);
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === "string" && WRAPPERS.has(value[0])) {
        return walk(value[1], next);
      }
      return value.map((child) => walk(child, next));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walk(child, next);
    }
    return out;
  };

  return { flat, resolve: (index) => walk(index, new Set()) };
}

/**
 * The first node whose keys include all of `keys`, resolved. Found by shape
 * rather than by path because the paths run through per-request hashes and
 * names their front end is free to rename.
 */
export function findByKeys(data: NuxtData, keys: string[]): unknown {
  for (let i = 0; i < data.flat.length; i++) {
    const v = data.flat[i];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const own = v as Record<string, unknown>;
    if (keys.every((k) => k in own)) return data.resolve(i);
  }
  return null;
}
