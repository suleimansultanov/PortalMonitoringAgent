/**
 * Is this advert, in its own words, for a home outside France?
 *
 * An agency in the gulf that also sells abroad publishes those homes from its
 * own office, and the portals file them under the agency's town. Immocenter,
 * Le Plan-de-la-Tour, sells in Phuket: Vizzit carried fourteen of its villas
 * and condos as Le Plan-de-la-Tour in October, and Stream.Estate V1 sent
 * thirteen more with `cityInsee: 83094` and the agency's own coordinates.
 * The client saw Phuket in its market and asked (Mark, 2026-10-27).
 *
 * Read from the advert itself — URL, title, description — because the
 * location fields are exactly what is wrong. A denylist, grown from evidence
 * only: every marker here was run over every stored listing before it went in
 * (2026-10-27: these markers hit those 27 adverts and nothing else). Words
 * that look foreign and are not stay out: "pierre de Bali" is a pool stone,
 * and "Miami" is in one agency's footer under every villa it sells. Add a
 * place the same way — measure it over the table first.
 */
const ABROAD =
  /(?:^|[^\p{L}\p{N}])(phuket|tha[iï]lande?|thailand|bangkok|pattaya|krabi|koh? samui|thb|bahts?)(?![\p{L}\p{N}])/iu;

/** The marker found, lower-cased, or null when nothing places the advert abroad. */
export function placedAbroad(...parts: (string | null | undefined)[]): string | null {
  const m = parts.filter((p): p is string => !!p).join("\n").match(ABROAD);
  return m ? m[1].toLowerCase() : null;
}
