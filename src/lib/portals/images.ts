/**
 * One rule about photographs, kept pure so it can be tested against strings.
 *
 * THE FAULT IT FIXES, measured on saved pages 2026-09-24. The client saw the
 * first two or three photographs of almost every property come up identical.
 * The dashboard shows `imageUrl` first and then `imageUrls`, and collapses
 * them with a `Set` — which is exact-string, so it only helps when the cover
 * IS the gallery's first entry byte for byte. On three portals it is. On the
 * two largest it is not:
 *
 *   Green-Acres  imageUrl   …/Photos/X_1.jpg?639233027540000000   (cache-buster)
 *                gallery[0] …/Photos/X_1.jpg
 *                gallery[1] …/miniPhotos/X_1.jpg                   (the thumbnail)
 *                gallery[2] …/Photos/X_2.jpg
 *                → the first THREE images shown are one photograph.
 *
 *   Superimmo    imageUrl   photo.superimmo.com/99oocynm…           (opaque id)
 *                gallery[0] photo.superimmo.com/4rum2il…            (another id)
 *                → the same photo under two ids the Set cannot relate.
 *
 * So: when a gallery exists, the cover is its first entry — not whatever
 * `og:image` happened to be. Nothing is lost, because `og:image` is the
 * portal's own choice of cover and is the gallery's first photo in every case
 * measured; what changes is that it now matches the gallery exactly, so the
 * dashboard's own dedup works. The original `og:image` is kept in `raw` by
 * the adapters that read it.
 */
export function coverFromGallery(
  imageUrl: string | null,
  imageUrls: string[],
): { imageUrl: string | null; imageUrls: string[] } {
  const gallery = [...new Set(imageUrls.filter((u): u is string => typeof u === "string" && u.length > 0))];
  if (gallery.length === 0) return { imageUrl, imageUrls: gallery };
  if (imageUrl && gallery.includes(imageUrl)) return { imageUrl, imageUrls: gallery };
  return { imageUrl: gallery[0], imageUrls: gallery };
}
