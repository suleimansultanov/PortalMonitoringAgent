import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeadConnectionError } from "./client";

/** The shape drizzle-orm 0.45 throws: the SQL outside, the driver error on `cause`. */
function drizzleWrapped(cause: Error): Error {
  return new Error('Failed query: select "id" from "users" where "users"."email" = $1', { cause });
}

test("a pooler timeout wrapped by Drizzle is a dead connection", () => {
  const pg = new Error("Connection terminated due to connection timeout", {
    cause: new Error("Connection terminated unexpectedly"),
  });
  assert.equal(isDeadConnectionError(drizzleWrapped(pg)), true);
});

test("a socket code on the cause counts, whatever the message", () => {
  const pg = Object.assign(new Error("read failed"), { code: "ECONNRESET" });
  assert.equal(isDeadConnectionError(drizzleWrapped(pg)), true);
});

test("a wrong query is not retried, even when its SQL mentions a timeout column", () => {
  const pg = Object.assign(new Error("division by zero"), { code: "22012" });
  const wrapped = new Error('Failed query: select 1 / "query_timeout" from "connection_settings"', { cause: pg });
  assert.equal(isDeadConnectionError(wrapped), false);
});

test("an unwrapped driver error is still judged on its own", () => {
  assert.equal(isDeadConnectionError(new Error("Connection terminated unexpectedly")), true);
  assert.equal(isDeadConnectionError(new Error("duplicate key value violates unique constraint")), false);
});
