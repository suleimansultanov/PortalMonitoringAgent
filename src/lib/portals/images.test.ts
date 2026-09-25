import { test } from "node:test";
import assert from "node:assert/strict";
import { coverFromGallery } from "./images";

/**
 * The dashboard shows the cover, then the gallery, and collapses them with an
 * exact-string Set. Every case here is a real shape from a saved page, and the
 * invariant under test is one line: when a gallery exists, the cover is IN it.
 */

test("a cover already in the gallery is left exactly as it is", () => {
  // Figaro, SMC, JamesEdition: og:image is gallery[0] byte for byte.
  const r = coverFromGallery("a.jpg", ["a.jpg", "b.jpg"]);
  assert.deepEqual(r, { imageUrl: "a.jpg", imageUrls: ["a.jpg", "b.jpg"] });
});

test("a cover that is NOT in the gallery is replaced by the gallery's first photo", () => {
  /**
   * Superimmo: og:image is an opaque id that appears nowhere in the gallery,
   * so the dashboard drew it and then drew gallery[0] — the same photograph
   * under two ids. The cover now IS gallery[0], so the Set collapses them.
   */
  const r = coverFromGallery("photo.superimmo.com/99oocynm", ["photo.superimmo.com/4rum2il", "photo.superimmo.com/ui2y079"]);
  assert.equal(r.imageUrl, "photo.superimmo.com/4rum2il");
});

test("a cache-busted cover on Green-Acres resolves to its own first photo", () => {
  // Before the adapter fix, og:image carried ?639233027540000000 and gallery[0] did not.
  const r = coverFromGallery("cdn/Photos/X_1.jpg?6392330", ["cdn/Photos/X_1.jpg", "cdn/Photos/X_2.jpg"]);
  assert.equal(r.imageUrl, "cdn/Photos/X_1.jpg", "cover must compare equal to gallery[0]");
});

test("with no gallery, the cover stands alone and is not invented", () => {
  assert.deepEqual(coverFromGallery("a.jpg", []), { imageUrl: "a.jpg", imageUrls: [] });
  assert.deepEqual(coverFromGallery(null, []), { imageUrl: null, imageUrls: [] });
});

test("duplicate gallery entries are collapsed, order preserved", () => {
  const r = coverFromGallery(null, ["a.jpg", "b.jpg", "a.jpg", "c.jpg"]);
  assert.deepEqual(r.imageUrls, ["a.jpg", "b.jpg", "c.jpg"]);
  assert.equal(r.imageUrl, "a.jpg");
});

test("the frontend's own Set now shows each photograph once", () => {
  // What listings/[id]/page.tsx does with the result.
  const r = coverFromGallery("cdn/Photos/X_1.jpg?busted", ["cdn/Photos/X_1.jpg", "cdn/Photos/X_2.jpg"]);
  const shown = [...new Set([r.imageUrl, ...r.imageUrls].filter(Boolean))];
  assert.deepEqual(shown, ["cdn/Photos/X_1.jpg", "cdn/Photos/X_2.jpg"]);
});
