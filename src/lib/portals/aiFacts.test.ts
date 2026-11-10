import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_SCHEMA, AiAnswer, acceptAnswer, callCost, quoteInText, valueInQuote, type Stored } from "./aiFacts";

const none = { value: null, quote: null };
const answer = (over: Partial<AiAnswer>): AiAnswer => ({ propertyType: none, livingAreaM2: none, landM2: none, rooms: none, bedrooms: none, ...over });
const stored = (over: Partial<Stored>): Stored => ({
  title: "Villa avec piscine",
  description: "Belle villa de 180 m² habitables sur un terrain de 2 500 m². Elle offre 6 pièces dont quatre chambres et une suite parentale.",
  propertyType: "Maison",
  areaM2: null,
  landM2: null,
  rooms: 6,
  bedrooms: null,
  ...over,
});

test("a value backed by a quote in the advert fills an empty field", () => {
  const { accepted, rejected } = acceptAnswer(
    stored({}),
    answer({
      livingAreaM2: { value: 180, quote: "villa de 180 m² habitables" },
      landM2: { value: 2500, quote: "sur un terrain de 2 500 m²" },
      bedrooms: { value: 4, quote: "dont quatre chambres" },
    }),
  );
  assert.deepEqual(accepted, { areaM2: 180, landM2: 2500, bedrooms: 4 });
  assert.deepEqual(rejected, {});
});

test("a quote the advert does not contain is refused, whatever the value", () => {
  const { accepted, rejected } = acceptAnswer(stored({}), answer({ bedrooms: { value: 5, quote: "cinq chambres spacieuses" } }));
  assert.deepEqual(accepted, {});
  assert.equal(rejected.bedrooms, "quote not in the advert");
});

test("a value its own quote does not hold is refused: 'une chambre parentale' is not four bedrooms", () => {
  const s = stored({ description: "Maison de 4 pièces avec une confortable chambre parentale avec sa salle de bains.", rooms: 4 });
  const { rejected } = acceptAnswer(s, answer({ bedrooms: { value: 4, quote: "une confortable chambre parentale avec sa salle de bains" } }));
  assert.equal(rejected.bedrooms, "value not in its quote");
});

test("the portal's own figure is never replaced", () => {
  const { accepted } = acceptAnswer(stored({ areaM2: 175 }), answer({ livingAreaM2: { value: 180, quote: "villa de 180 m² habitables" } }));
  assert.deepEqual(accepted, {});
});

test("more bedrooms than rooms is not a reading, and out-of-range figures are refused", () => {
  const s = stored({ rooms: 3, description: "Appartement de 3 pièces, cinq chambres d'hôtes à côté. 12 000 m² habitables." });
  const { rejected } = acceptAnswer(s, answer({ bedrooms: { value: 5, quote: "cinq chambres" }, livingAreaM2: { value: 12000, quote: "12 000 m² habitables" } }));
  assert.match(rejected.bedrooms, /more bedrooms/);
  assert.match(rejected.livingAreaM2, /out of range/);
});

test("the type fills an empty one, and replaces only one that came from a generic title", () => {
  const restaurant = { title: "Achat : Maison (83120)", description: "Ce restaurant de plage avec une capacité d'environ 140 couverts." };
  const t = { value: "Commerce" as const, quote: "Ce restaurant de plage" };
  assert.equal(acceptAnswer(stored({ ...restaurant, propertyType: "Maison" }), answer({ propertyType: t })).accepted.propertyType, "Commerce");
  assert.equal(acceptAnswer(stored({ ...restaurant, propertyType: null }), answer({ propertyType: t })).accepted.propertyType, "Commerce");
  const stated = stored({ title: "Villa avec piscine", description: "Ce restaurant de plage reconverti en villa", propertyType: "Maison" });
  assert.match(acceptAnswer(stated, answer({ propertyType: t })).rejected.propertyType, /the portal states/);
});

test("numbers as adverts write them: thousands with commas or spaces, hectares, English and French words", () => {
  assert.equal(valueInQuote(4860, "The property is set on 4,860 m² of landscaped grounds."), true);
  assert.equal(valueInQuote(1200, "un jardin de 1 200 m2"), true);
  assert.equal(valueInQuote(15000, "un domaine de 1,5 ha", { hectares: true }), true);
  assert.equal(valueInQuote(5, "the villa offers five bedrooms", { countWords: true }), true);
  assert.equal(valueInQuote(0, "PAS DE CHAMBRE", { countWords: true }), false);
  assert.equal(quoteInText("A l'étage", "À vendre. A l’étage, deux chambres"), true);
});

test("the schema asks for every field and allows nothing else", () => {
  assert.deepEqual([...AI_SCHEMA.required].sort(), Object.keys(AI_SCHEMA.properties).sort());
  assert.equal(AI_SCHEMA.additionalProperties, false);
  assert.ok(AiAnswer.safeParse(answer({ rooms: { value: 3, quote: "3 pièces" } })).success);
});

test("cost from usage: cached reads at a tenth", () => {
  const full = callCost({ input_tokens: 1940, output_tokens: 146 });
  const cached = callCost({ input_tokens: 500, cache_read_input_tokens: 1440, output_tokens: 146 });
  assert.ok(Math.abs(full - 0.000267) < 0.000002);
  assert.ok(cached < full / 1.8);
});
