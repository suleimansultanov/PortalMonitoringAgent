-- The rest of each listing's photographs.
--
-- Both portals publish a full gallery on the detail page — 20 to 100 images.
-- We store the URLs and hotlink them, as with the cover photo: the photography
-- belongs to the agency, and a link means a withdrawn property's pictures
-- disappear on their schedule rather than lingering on ours.
--
-- NOT NULL DEFAULT '{}' rather than a nullable column: "no gallery" and "an
-- empty gallery" are the same thing here, and a nullable array invites every
-- reader to handle a third case that does not exist.

ALTER TABLE "portal_listings" ADD COLUMN IF NOT EXISTS "image_urls" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "properties"     ADD COLUMN IF NOT EXISTS "image_urls" text[] NOT NULL DEFAULT '{}';
