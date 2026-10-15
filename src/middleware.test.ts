import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPublicPath, PUBLIC_PATHS, PUBLIC_ROOTS } from "@/lib/auth/config";

/**
 * The matcher as Next reads it: the literal in middleware.ts. Read from the
 * source rather than imported, because importing the middleware pulls in
 * next-auth's runtime — and because the literal is the thing Next compiles.
 */
function matcher(): RegExp {
  const source = readFileSync(fileURLToPath(new URL("./middleware.ts", import.meta.url)), "utf8");
  const literal = /matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"\s*\]/.exec(source)?.[1];
  assert.ok(literal, "middleware.ts must keep a single string matcher");
  return new RegExp(`^${JSON.parse(`"${literal}"`)}$`);
}

/** True when the request never reaches the guard. */
const skipped = (path: string) => !matcher().test(path);

const PROBES = [
  "/",
  "/portal",
  "/portal/x.png",
  "/portal/listings/x.css",
  "/portal/reports/report.pdf",
  "/x.svg",
  "/robots.txt",
  "/login",
  "/login-admin",
  "/docs",
  "/docs/openapi",
  "/docsecret",
  "/api/v1/properties",
  "/api/v1beta",
  "/api/auth/session",
  "/api/inngest",
  "/api/matches",
  "/_next/static/chunks/main.js",
  "/_next/staticfile",
  "/_next/image",
  "/favicon.ico",
  "/favicon.ico.png",
];

test("a path ending in .png is guarded like any other — the 2026-10-15 matcher let it past the login", () => {
  for (const path of ["/portal/x.png", "/portal/listings/x.css", "/x.svg", "/robots.txt"]) {
    assert.equal(skipped(path), false, `${path} must reach the guard`);
    assert.equal(isPublicPath(path), false, `${path} must not be public`);
  }
});

test("the matcher skips nothing the public list does not make public", () => {
  for (const path of PROBES) {
    if (skipped(path)) assert.equal(isPublicPath(path), true, `matcher skips ${path}, which is not public`);
  }
  // And it does skip the build's own assets, which is all it is for.
  assert.equal(skipped("/_next/static/chunks/main.js"), true);
  assert.equal(skipped("/_next/image"), true);
  assert.equal(skipped("/favicon.ico"), true);
});

test("public means the login, next-auth, the keyed API and the documentation — nothing else", () => {
  const open = PROBES.filter(isPublicPath);
  assert.deepEqual(open, [
    "/login",
    "/docs",
    "/docs/openapi",
    "/api/v1/properties",
    "/api/auth/session",
    "/_next/static/chunks/main.js",
    "/_next/image",
    "/favicon.ico",
  ]);
});

test("a root opens what is beneath it, not every path that starts with the same letters", () => {
  assert.equal(isPublicPath("/api/v1"), true);
  assert.equal(isPublicPath("/api/v1/reports/abc"), true);
  assert.equal(isPublicPath("/api/v1beta/properties"), false);
  assert.equal(isPublicPath("/api/authx"), false);
  assert.equal(isPublicPath("/login/../portal"), false);
});

test("the Inngest webhook is gone, and so is its exemption", () => {
  assert.equal(isPublicPath("/api/inngest"), false);
});

test("the list holds paths, never patterns — a pattern is how the tail happened", () => {
  for (const p of [...PUBLIC_PATHS, ...PUBLIC_ROOTS]) {
    assert.match(p, /^\/[A-Za-z0-9_./-]*$/, `${p} is not a plain path`);
    assert.ok(!p.endsWith("/"), `${p} must not end in a slash`);
  }
});
