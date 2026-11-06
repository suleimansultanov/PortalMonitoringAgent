import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, propertiesMovingWhole } from "./recommune";

const row = (id: string, over: Partial<Parameters<typeof plan>[0][number]> = {}) => ({
  id,
  source: "bienici",
  status: "active",
  old: "83119",
  raw: "Sainte-Maxime - Sémaphore - Nartelle",
  postal: "83120",
  url: `https://www.bienici.com/annonce/${id}`,
  propertyId: "p1",
  ...over,
});

test("a row filed under a commune its stated place does not name moves to the one it names", () => {
  const { moves } = plan([row("a"), row("b", { old: "83115" })], new Map());
  assert.deepEqual(moves.map((m) => [m.id, m.old, m.now]), [["a", "83119", "83115"]]);
});

test("Les Issambres with nothing stated but the commune's name is left for a person", () => {
  const { moves, kept } = plan([row("a", { old: "83107", raw: "Roquebrune Sur Argens", postal: null })], new Map());
  assert.equal(moves.length, 0);
  assert.equal(kept.length, 1);
});

test("a home abroad stays in no commune", () => {
  const texts = new Map([["a", { title: "Villa à Phuket", description: "Thaïlande, vue mer" }]]);
  const { moves } = plan([row("a", { old: null, raw: "Le Plan-de-la-Tour", postal: "83120", url: "https://www.vizzit.fr/fr/property/maison/phuket/1" })], texts);
  assert.equal(moves.length, 0);
});

test("a property moves whole when all its live listings go to one commune, and stays when they split", () => {
  const rows = [row("a"), row("b"), row("c", { propertyId: "p2" }), row("d", { propertyId: "p2", raw: "Saint-Tropez", postal: "83990" })];
  const { moves } = plan(rows, new Map());
  const whole = propertiesMovingWhole(rows, moves, new Map([["p1", "83119"], ["p2", "83119"]]));
  assert.deepEqual([...whole], [["p1", "83115"]]);
});
