import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCommune } from "./communes";

/**
 * Les Issambres is a locality inside Roquebrune-sur-Argens, and the agencies
 * write it by its parts. A listing that names a part and not the whole went
 * unfiled, which on the dashboard is indistinguishable from "not for sale".
 */
test("the parts of Les Issambres resolve to Les Issambres", () => {
  // Bien'ici's own label for a listing, 2026-10-07.
  assert.equal(resolveCommune("Roquebrune-sur-Argens - Val d'Esquières - Port", "83380")?.label, "Les Issambres");
  assert.equal(resolveCommune("San Peïre-sur-Mer", "83380")?.label, "Les Issambres");
  assert.equal(resolveCommune("Les Issambres", null)?.label, "Les Issambres");
});

test("the rest of Roquebrune-sur-Argens is not Les Issambres", () => {
  // The village is inland and not what the client watches; it stays unfiled.
  assert.equal(resolveCommune("Roquebrune-sur-Argens - Village", "83520"), null);
  assert.equal(resolveCommune("Roquebrune-sur-Argens - La Bouverie", "83520"), null);
});
