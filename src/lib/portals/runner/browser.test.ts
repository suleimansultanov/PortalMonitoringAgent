import test from "node:test";
import assert from "node:assert/strict";
import { parseProxyUrl, proxyHost } from "./browser";

/**
 * The proxy URL arrives as one environment variable and has to reach
 * Playwright as three fields — and the credentials must reach the launch and
 * never the log. Both halves are checked here because both have a failure
 * that would only show up on the night it matters.
 */

test("a provider-style url splits into server, username and password", () => {
  const p = parseProxyUrl("http://user-abc-country-fr:s3cr3t@gate.example.net:7000");
  assert.deepEqual(p, {
    server: "http://gate.example.net:7000",
    username: "user-abc-country-fr",
    password: "s3cr3t",
  });
});

test("credentials are percent-decoded, because passwords contain symbols", () => {
  const p = parseProxyUrl("http://u%40x:p%3Ass%2Fw@h.example:1");
  assert.equal(p.username, "u@x");
  assert.equal(p.password, "p:ss/w");
});

test("a bare host:port is accepted and carries no credentials", () => {
  const p = parseProxyUrl("gate.example.net:7000");
  assert.equal(p.server, "http://gate.example.net:7000");
  assert.equal("username" in p, false);
  assert.equal("password" in p, false);
});

test("socks5 is passed through with its scheme", () => {
  assert.equal(parseProxyUrl("socks5://h.example:1080").server, "socks5://h.example:1080");
});

test("an empty or hostless value is refused loudly", () => {
  assert.throws(() => parseProxyUrl("http://:@"));
  assert.throws(() => parseProxyUrl(""));
});

test("what gets logged is the host and only the host", () => {
  const raw = "http://plan-42-session-xyz:hunter2@gate.example.net:7000";
  const shown = proxyHost(parseProxyUrl(raw).server);
  assert.equal(shown, "gate.example.net:7000");
  assert.equal(shown.includes("hunter2"), false);
  assert.equal(shown.includes("session"), false);
});
