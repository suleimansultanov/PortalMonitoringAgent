/**
 * A no-op stand-in for the real `server-only` package.
 *
 * The real one throws on import unless it is resolved under React's
 * `react-server` condition. That is exactly what you want inside the app — it
 * turns "this secret leaked into the browser bundle" into a build error.
 *
 * It is exactly what you do NOT want in a script. `npm run db:migrate`,
 * `db:seed` and `collect` all import modules marked `server-only`, and under
 * tsx they resolve to the throwing build, so every script dies on its first
 * import with a message about Client Components that has nothing to do with
 * anything.
 *
 * Next.js does not rely on this package to enforce the boundary — it has its
 * own checks — so replacing it costs nothing real. The same workaround is in
 * the Vault project, for the same reason.
 */
module.exports = {};
