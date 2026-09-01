import { redirect } from "next/navigation";

/**
 * The root is a signpost, not a screen.
 *
 * Two things are served from this deployment and neither should own `/`: our
 * own interface, which lives under `/portal`, and the API that client instances
 * call, described at `/docs`. A bookmark to `/` from before the split still
 * lands somewhere sensible.
 */
export default function Root() {
  redirect("/portal");
}
