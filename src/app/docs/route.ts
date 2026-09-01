/**
 * GET /docs — Swagger UI over the specification at /docs/openapi.
 *
 * A route handler returning HTML rather than a React page, because Swagger UI
 * takes over the whole document: it wants its own stylesheet, its own root
 * element and its own bootstrap script, and wrapping that in the app layout
 * would mean fighting both.
 *
 * Loaded from a CDN with a pinned version rather than added to package.json.
 * `swagger-ui-dist` is several megabytes of vendored bundle whose only consumer
 * is this one page; pinning the version is what stops it changing underneath us
 * the way an unpinned `@latest` would.
 */

export const runtime = "nodejs";

const SWAGGER = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14";

export async function GET() {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Collector API — Portal Monitoring Agent</title>
    <link rel="stylesheet" href="${SWAGGER}/swagger-ui.css" />
    <style>
      body { margin: 0; background: #fff; }
      /* The stock topbar only offers to load a different spec, which is not a
         thing anyone should do from here. */
      .swagger-ui .topbar { display: none; }
      .pma-back {
        font: 500 11px/1 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.1em; text-transform: uppercase;
        padding: 14px 20px; display: block; color: #666; text-decoration: none;
        border-bottom: 1px solid #eee;
      }
      .pma-back:hover { color: #111; }
    </style>
  </head>
  <body>
    <a class="pma-back" href="/portal">← Portal</a>
    <div id="swagger"></div>
    <script src="${SWAGGER}/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/docs/openapi",
        dom_id: "#swagger",
        deepLinking: true,
        // Alphabetical rather than declaration order: the reader is looking for
        // an endpoint by name, not reading it as a narrative.
        operationsSorter: "alpha",
        defaultModelsExpandDepth: 1,
        tryItOutEnabled: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
    </script>
  </body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The spec changes with the code, so a cached copy would document a
      // version that is no longer deployed.
      "cache-control": "no-store",
    },
  });
}
