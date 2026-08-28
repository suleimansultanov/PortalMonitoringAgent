-- Listing photography.
--
-- We store the URL the portal publishes in `og:image` and hotlink it. We do NOT
-- copy the file: the photography belongs to the agency, `og:image` exists
-- precisely so other sites can display it, and a link means a withdrawn
-- property's image disappears on their schedule rather than lingering on ours.
--
-- Both portals collected so far publish one on every single listing page —
-- 159/159 and 30/30 — so this is reliable enough for the product to lead with.

ALTER TABLE "portal_listings" ADD COLUMN IF NOT EXISTS "image_url" text;
ALTER TABLE "properties"     ADD COLUMN IF NOT EXISTS "image_url" text;
