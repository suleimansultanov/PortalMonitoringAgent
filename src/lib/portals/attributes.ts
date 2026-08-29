/**
 * The characteristics block, as a bag of what the page happened to say.
 *
 * WHY A BAG AND NOT COLUMNS
 *
 * Every portal prints a different set of these, and so does every agency on the
 * same portal: one listing lists orientation, heating and an alarm, the next
 * lists a cellar and four parking spaces, and neither is wrong. Twelve nullable
 * columns would capture a guess at today's labels and quietly drop whatever the
 * thirteenth portal calls things.
 *
 * So everything lands in `raw` exactly as printed, and a field is promoted to a
 * typed column only once the product filters on it. Promotion is then a
 * migration over data we already hold — not a re-crawl.
 */

export type Characteristics = {
  /** Label → value, as the portal printed both. */
  attributes: Record<string, string>;
  /** Cells with no label at all: "Piscine", "Vue sur mer", "Alarme". */
  flags: string[];
};

/** Longer than this and the text before the colon is a sentence, not a label. */
const MAX_LABEL = 40;

function tidy(text: string): string {
  // Non-breaking spaces are everywhere in French markup — "Prix de vente&nbsp;:"
  // — and a label that keeps one never matches a label that does not.
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Sort raw cell texts into labelled values and bare flags.
 *
 * Order is preserved and duplicates are dropped, so the block reads on our page
 * roughly as it reads on theirs — which is what makes it checkable against the
 * source at a glance.
 */
export function collectCharacteristics(cells: string[]): Characteristics {
  const attributes: Record<string, string> = {};
  const flags: string[] = [];
  const seen = new Set<string>();

  for (const cell of cells) {
    const text = tidy(cell);
    if (!text || seen.has(text)) continue;
    seen.add(text);

    const colon = text.indexOf(":");
    if (colon > 0 && colon <= MAX_LABEL) {
      const label = text.slice(0, colon).trim();
      const value = text.slice(colon + 1).trim();
      // "Alarme :" with nothing after it is a flag wearing a colon.
      if (label && value) {
        attributes[label] = value;
        continue;
      }
      if (label) flags.push(label);
      continue;
    }

    flags.push(text);
  }

  return { attributes, flags };
}

/** Nothing worth storing — keeps empty objects out of `raw`. */
export function isEmpty(c: Characteristics): boolean {
  return Object.keys(c.attributes).length === 0 && c.flags.length === 0;
}
