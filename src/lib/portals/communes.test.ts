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

/**
 * The client's complaint of 2026-11-05: Bien'ici homes shown under Saint-Tropez
 * that are somewhere else when clicked. The portal stated the right place; the
 * text mentioned Saint-Tropez, and that won.
 */
test("the stated place outranks a commune the advert only mentions", () => {
  const text = "Belle villa à 15 minutes de Saint-Tropez et de Port Grimaud";
  assert.equal(resolveCommune("Sainte-Maxime - Sémaphore - Nartelle", "83120", text)?.label, "Sainte-Maxime");
  assert.equal(resolveCommune("Cavalaire-sur-Mer - Castillane - Vivards", "83240", text)?.label, "Cavalaire-sur-Mer");
  assert.equal(resolveCommune("Cogolin - Radasse - Faucon", "83310", text)?.label, "Cogolin");
  assert.equal(resolveCommune("Sainte-Maxime - Centre-ville", "83120", "A deux pas des Issambres")?.label, "Sainte-Maxime");
});

test("a place outside the gulf stays unfiled whatever its text mentions", () => {
  const text = "Golf et plages, Saint-Tropez à 30 minutes, proche des Issambres";
  assert.equal(resolveCommune("Roquebrune-sur-Argens - Golf", "83520", text), null);
  assert.equal(resolveCommune("Fréjus", "83600", text), null);
});

test("a district is read from the text only inside the commune already settled on", () => {
  assert.equal(resolveCommune("Grimaud", "83310", "Appartement Port Grimaud vue port")?.label, "Port Grimaud");
  assert.equal(resolveCommune("Cogolin", "83310", "Aux Marines de Cogolin")?.label, "Marines de Cogolin");
  assert.equal(resolveCommune("Cogolin", "83310", "Vue sur Port Grimaud")?.label, "Cogolin");
});

test("a stated place naming two communes means the first", () => {
  assert.equal(resolveCommune("Gassin - Proche Saint-Tropez", null)?.label, "Gassin");
  assert.equal(resolveCommune("Saint-Tropez - Route de Gassin", null)?.label, "Saint-Tropez");
});

test("names match as whole words, and an accent or a hyphen changes nothing", () => {
  assert.equal(resolveCommune("ST TROPEZ", null)?.label, "Saint-Tropez");
  assert.equal(resolveCommune("La Môle", null)?.label, "La Môle");
  assert.equal(resolveCommune("Grimaudière", null), null);
});

test("no place stated: the postcode, and the text only to choose among communes sharing one", () => {
  assert.equal(resolveCommune(null, "83990", "à 20 minutes de Ramatuelle")?.label, "Saint-Tropez");
  assert.equal(resolveCommune(null, "83310", "Villa à Cogolin")?.label, "Cogolin");
  assert.equal(resolveCommune(null, "83310", "Villa sans lieu dit")?.label, "Grimaud");
  assert.equal(resolveCommune(null, "83120", "Mas au Plan-de-la-Tour")?.label, "Le Plan-de-la-Tour");
  assert.equal(resolveCommune(null, "83120", "Proche de Saint-Tropez")?.label, "Sainte-Maxime");
});

test("nothing stated at all: only a district is specific enough to mean itself", () => {
  assert.equal(resolveCommune(null, null, "Studio à Port Grimaud")?.label, "Port Grimaud");
  assert.equal(resolveCommune(null, null, "Proche de Saint-Tropez"), null);
});

test("a place we do not watch stays unfiled, whatever its text mentions", () => {
  assert.equal(resolveCommune("Vidauban", null, "Villa proche de Saint-Tropez"), null);
  assert.equal(resolveCommune("Ramatuel", null)?.label, "Ramatuelle");
});

test("Roquebrune-sur-Argens counts only where Les Issambres is named, and never at 83520", () => {
  const near = "Villa aux Issambres, Saint-Tropez à 30 minutes";
  assert.equal(resolveCommune("Roquebrune Sur Argens", null, near)?.label, "Les Issambres");
  assert.equal(resolveCommune("Roquebrune-sur-Argens - Les Terrasses", "83380", near)?.label, "Les Issambres");
  assert.equal(resolveCommune("Roquebrune-sur-Argens", "83520", near), null);
  assert.equal(resolveCommune("Roquebrune Sur Argens", null, "Villa, Saint-Tropez à 30 minutes"), null);
  // Bien'ici prints 83380 on the inland village too: the postcode alone is not enough.
  assert.equal(resolveCommune("Roquebrune-sur-Argens - Village", "83380"), null);
});
