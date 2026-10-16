import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { bucket, clientIp, fixedWindow, hit, LIMITS, loginBuckets, peek } from "./rateLimit";

/** A database that answers one statement with `rows`, and remembers what it was asked. */
function fakeDb(rows: Record<string, unknown>[]) {
  const asked: string[] = [];
  const exec = async (q: SQL) => {
    asked.push(new PgDialect().sqlToQuery(q).sql);
    return { rows };
  };
  return { exec, asked };
}

const broken = async () => {
  throw new Error('relation "rate_limits" does not exist');
};

const T = Date.parse("2026-10-15T10:00:30.000Z");

test("a window starts on its boundary, and Retry-After is what is left of it — never zero", () => {
  const w = fixedWindow(T, 60);
  assert.equal(w.start.toISOString(), "2026-10-15T10:00:00.000Z");
  assert.equal(w.retryAfterSec, 30);
  assert.equal(fixedWindow(Date.parse("2026-10-15T10:00:00.000Z"), 60).retryAfterSec, 60);
  assert.equal(fixedWindow(Date.parse("2026-10-15T10:00:59.999Z"), 60).retryAfterSec, 1);
  assert.equal(fixedWindow(T, 900).start.toISOString(), "2026-10-15T10:00:00.000Z");
});

test("the address is the platform's, first hop first; 'unknown' locally", () => {
  assert.equal(clientIp(new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" })), "203.0.113.9");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })), "198.51.100.1");
  assert.equal(clientIp(new Headers()), "unknown");
});

test("a bucket names no email and no address — the table would otherwise list every email tried", () => {
  const b = loginBuckets("Mark@Med-Estates.com", "203.0.113.9");
  assert.doesNotMatch(b.emailIp, /mark|med-estates|203\.0/i);
  assert.match(b.emailIp, /^login:[0-9a-f]{32}$/);
  // Case and spaces do not make a fresh bucket for the same person.
  assert.equal(loginBuckets(" mark@med-estates.com ", "203.0.113.9").emailIp, b.emailIp);
  assert.notEqual(loginBuckets("mark@med-estates.com", "198.51.100.1").emailIp, b.emailIp);
  assert.notEqual(bucket("v1-key", "k1"), bucket("v1-key", "k2"));
  assert.notEqual(bucket("v1-key", "k1"), bucket("v1-unauthorised", "k1"));
});

test("the 120th request of a minute is answered; the 121st is 429 with the rest of the minute", async () => {
  const ok = await hit("v1-key:x", LIMITS.v1PerKey, { now: T, exec: fakeDb([{ count: 120 }]).exec });
  assert.deepEqual(ok, { allowed: true, count: 120, retryAfterSec: 30 });
  const over = await hit("v1-key:x", LIMITS.v1PerKey, { now: T, exec: fakeDb([{ count: 121 }]).exec });
  assert.deepEqual(over, { allowed: false, count: 121, retryAfterSec: 30 });
});

test("one statement per request: an upsert on the bucket that restarts an old window at 1", async () => {
  const db = fakeDb([{ count: 1 }]);
  await hit("v1-key:x", LIMITS.v1PerKey, { now: T, exec: db.exec });
  assert.equal(db.asked.length, 1);
  assert.match(db.asked[0], /insert into rate_limits[\s\S]*on conflict \(bucket\) do update/);
  assert.match(db.asked[0], /when rate_limits\.window_start >= excluded\.window_start then rate_limits\.count \+ 1\s+else 1/);
});

test("a limiter that cannot reach its table lets the request through — it must not become the outage", async () => {
  const v = await hit("v1-key:x", LIMITS.v1PerKey, { now: T, exec: broken });
  assert.equal(v.allowed, true);
  const p = await peek("login:x", LIMITS.loginPerEmailIp, { now: T, exec: broken });
  assert.equal(p.allowed, true);
});

test("ten failed sign-ins in fifteen minutes are allowed; the eleventh attempt is refused", async () => {
  const nine = await peek("login:x", LIMITS.loginPerEmailIp, { now: T, exec: fakeDb([{ count: 9 }]).exec });
  assert.equal(nine.allowed, true);
  const ten = await peek("login:x", LIMITS.loginPerEmailIp, { now: T, exec: fakeDb([{ count: 10 }]).exec });
  assert.equal(ten.allowed, false);
  assert.equal(ten.retryAfterSec, 870);
  const none = await peek("login:x", LIMITS.loginPerEmailIp, { now: T, exec: fakeDb([]).exec });
  assert.deepEqual(none, { allowed: true, count: 0, retryAfterSec: 870 });
});

test("the limits are never felt by a normal client", () => {
  // Seeding: the whole served market (6 278 on 2026-10-15) at the default
  // limit=200 is 32 pages, plus /status and a few /events pages — inside one
  // minute's allowance, with room to spare for the corpus to double.
  const seed = Math.ceil(6_278 / 200) + 1 + 5;
  assert.ok(seed * 2 < LIMITS.v1PerKey.limit, `a seed walk takes ${seed} requests`);
  // Polling /status once a second — wasteful, and still not refused.
  assert.ok(60 <= LIMITS.v1PerKey.limit);
  // A revoked key polled every five minutes never meets its 429.
  assert.ok((LIMITS.v1UnauthorisedPerIp.windowSec / 300) * 2 < LIMITS.v1UnauthorisedPerIp.limit);
});
