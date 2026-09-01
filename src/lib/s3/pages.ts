import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, getBucket } from "./client";

/**
 * Raw page storage.
 *
 * Every fetched page is written here byte-for-byte before anything tries to
 * understand it. This is the single most useful decision in the pipeline: when
 * a portal redesigns and the parser breaks — and it will — the fix is a new
 * parser run over pages we already hold, not a re-crawl of thirteen sites.
 * It also means a parser bug found in November can be corrected across
 * September's data.
 *
 * LOCAL FALLBACK
 * With no S3 configured, pages go to `.pages/` on disk instead. Requiring an
 * object store before anyone can run the collector once locally is the kind of
 * friction that stops people running it locally at all — and the first run is
 * exactly where the surprises are. Production is unaffected: if S3_BUCKET is
 * set, S3 is used.
 */

const LOCAL_ROOT = path.resolve(process.cwd(), ".pages");

function useLocal(): boolean {
  return !process.env.S3_BUCKET || !process.env.S3_ENDPOINT;
}

/** `pages/{source}/{yyyy-mm-dd}/{externalId}.html` — sorts usefully in a listing. */
export function pageKey(sourceKey: string, externalId: string, fetchedAt = new Date()): string {
  const day = fetchedAt.toISOString().slice(0, 10);
  // External ids come from URLs and are mostly clean, but a portal is free to
  // put a slash or a query character in one. Encode rather than trust.
  const safeId = encodeURIComponent(externalId);
  return `pages/${sourceKey}/${day}/${safeId}.html`;
}

export async function putPage(key: string, body: string): Promise<void> {
  if (useLocal()) {
    const file = path.join(LOCAL_ROOT, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, "utf8");
    return;
  }

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: "text/html; charset=utf-8",
    }),
  );
}

/**
 * Read a stored page back.
 *
 * `maxBytes` truncates rather than throwing. The Vault project had this the
 * other way round — the reader threw when a file exceeded the caller's cap, so
 * every large file silently became a "read failed" placeholder and nobody
 * noticed for weeks. Truncation is the honest failure here: you get most of the
 * page and the caller can tell.
 */
export async function getPage(key: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
  if (useLocal()) {
    const buf = await fs.readFile(path.join(LOCAL_ROOT, key));
    return buf.subarray(0, maxBytes).toString("utf8");
  }

  const res = await getS3Client().send(
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
  );
  if (!res.Body) throw new Error(`S3 object ${key} has no body`);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    if (total + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - total));
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Remove one stored page.
 *
 * Added for the preflight probe, which writes an object and reads it back to
 * prove the credentials can actually do both — a token with read but not write
 * looks identical to a working one until the first listing of a real crawl.
 *
 * NOT used by the collector. Pages are the record a parser fix is re-run
 * against, and nothing in the pipeline has any business deleting one: a page
 * removed is a listing that can never be re-parsed, only re-crawled, and the
 * portal may not still be serving it. If a retention policy is ever wanted, it
 * belongs in the bucket's own lifecycle rules, where it is visible and
 * reversible, rather than in code that runs every night.
 */
export async function deletePage(key: string): Promise<void> {
  if (useLocal()) {
    await fs.rm(path.join(LOCAL_ROOT, key), { force: true });
    return;
  }
  await getS3Client().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
}

/** Where pages are going, for the run log to state plainly. */
export function storageDescription(): string {
  return useLocal() ? `local disk (${LOCAL_ROOT})` : `S3 bucket ${process.env.S3_BUCKET}`;
}
